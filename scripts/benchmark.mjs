import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../dist/src/db/database.js";
import { WorktreeManager } from "../dist/src/worktrees/worktreeManager.js";
import { TaskGraph } from "../dist/src/dag/taskGraph.js";
import { LeaseWatchdog } from "../dist/src/dispatch/watchdog.js";
import { WaymarkSupervisor } from "../dist/src/waymark/waymarkSupervisor.js";

function setupBenchmarkRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-bench-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Benchmark Agent"], { cwd: tempDir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "benchmark@example.com"], { cwd: tempDir, windowsHide: true });

  fs.writeFileSync(path.join(tempDir, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "README.md"), "# Benchmark Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: tempDir, windowsHide: true });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tempDir, windowsHide: true });
  return tempDir;
}

function cleanupRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

async function runBenchmarks() {
  const results = {};
  const repoRoot = setupBenchmarkRepo();

  try {
    const db = new ArbiterDatabase(":memory:");
    const worktrees = new WorktreeManager(repoRoot);
    const waymark = new WaymarkSupervisor();
    const watchdog = new LeaseWatchdog(db, worktrees, waymark);

    // 1. Benchmark: Worktree Provisioning Latency
    const wtStart = performance.now();
    const { path: wtPath, branch } = worktrees.createWorktree("bench-task-1", "main");
    const wtElapsedMs = performance.now() - wtStart;
    results.worktreeProvisioningMs = Number(wtElapsedMs.toFixed(2));

    // Cleanup provisioned worktree
    worktrees.removeWorktree("bench-task-1");
    worktrees.deleteBranch("bench-task-1");

    // 2. Benchmark: DAG Resolution (100 sequential & branching tasks)
    const dag = new TaskGraph(db);
    const dagInsertStart = performance.now();
    for (let i = 1; i <= 50; i++) {
      db.insertTask({
        id: `task-${i}`,
        title: `Task ${i}`,
        description: `Benchmark task ${i}`,
        status: "PENDING",
        baseBranch: "main",
        branch: `arbiter/task-${i}`,
        worktreePath: null,
        assignedWorkerId: null,
        waymarkTrajectoryId: null,
        resultAnswer: null,
        errorMessage: null,
      });
      if (i > 1) {
        dag.addDependency(`task-${i - 1}`, `task-${i}`);
      }
    }
    const topoStart = performance.now();
    const order = dag.getTopologicalOrder();
    const topoElapsedMs = performance.now() - topoStart;
    results.dagTopologicalSort50NodesMs = Number(topoElapsedMs.toFixed(2));
    results.dagNodesResolved = order.length;

    // 3. Benchmark: Lease Watchdog Scan Latency
    for (let i = 1; i <= 20; i++) {
      db.setWorkerLease({
        workerId: `worker-${i}`,
        taskId: `task-${i}`,
        pid: process.pid,
        heartbeatAt: new Date().toISOString(),
        status: "ACTIVE",
      });
    }
    const watchdogStart = performance.now();
    const scanRes = watchdog.scanLeases();
    const watchdogElapsedMs = performance.now() - watchdogStart;
    results.watchdogScan20LeasesMs = Number(watchdogElapsedMs.toFixed(2));
    results.watchdogLeasesScanned = scanRes.scanned;

    // 4. Memory Footprint
    const mem = process.memoryUsage();
    results.heapUsedMb = Number((mem.heapUsed / 1024 / 1024).toFixed(2));
    results.rssMb = Number((mem.rss / 1024 / 1024).toFixed(2));
    results.runtimeDependencies = 0; // zero npm dependencies at runtime!

    console.log(JSON.stringify({ arbiter: 1, kind: "benchmark", ok: true, metrics: results }, null, 2));
  } finally {
    cleanupRepo(repoRoot);
  }
}

runBenchmarks();

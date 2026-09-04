import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../src/db/database.js";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../src/waymark/waymarkSupervisor.js";
import { LeaseWatchdog } from "../src/dispatch/watchdog.js";
import { TaskService } from "../src/dag/taskService.js";

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-watchdog-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "arbiter-test@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Arbiter Test"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Arbiter Watchdog Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, windowsHide: true });

  return {
    repoRoot,
    cleanup: () => {
      try {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("LeaseWatchdog detects alive PID and leaves active lease untouched", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const worktrees = new WorktreeManager(repoRoot);
    const waymark = new WaymarkSupervisor();
    const watchdog = new LeaseWatchdog(db, worktrees, waymark);

    db.insertTask({
      id: "task-live",
      title: "Live Task",
      description: "Running with current process PID",
      status: "IN_PROGRESS",
      baseBranch: "main",
      branch: "arbiter/task-live",
      worktreePath: null,
      assignedWorkerId: "worker-live",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    db.setWorkerLease({
      workerId: "worker-live",
      taskId: "task-live",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      status: "ACTIVE",
    });

    const result = watchdog.scanLeases();
    assert.equal(result.scanned, 1);
    assert.equal(result.expiredCount, 0);
    assert.equal(result.recoveredTasks.length, 0);

    const task = db.getTask("task-live");
    assert.equal(task?.status, "IN_PROGRESS");
    assert.equal(task?.assignedWorkerId, "worker-live");

    const lease = db.getWorkerLease("task-live");
    assert.equal(lease?.status, "ACTIVE");
  } finally {
    cleanup();
  }
});

test("LeaseWatchdog detects dead PID and recovers task to READY", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const worktrees = new WorktreeManager(repoRoot);
    const waymark = new WaymarkSupervisor();
    const watchdog = new LeaseWatchdog(db, worktrees, waymark);

    db.insertTask({
      id: "task-dead",
      title: "Dead Worker Task",
      description: "Worker crashed",
      status: "IN_PROGRESS",
      baseBranch: "main",
      branch: "arbiter/task-dead",
      worktreePath: null,
      assignedWorkerId: "worker-dead",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    // Use impossible PID 99999999
    db.setWorkerLease({
      workerId: "worker-dead",
      taskId: "task-dead",
      pid: 99999999,
      heartbeatAt: new Date().toISOString(),
      status: "ACTIVE",
    });

    const result = watchdog.scanLeases();
    assert.equal(result.scanned, 1);
    assert.equal(result.expiredCount, 1);
    assert.deepEqual(result.recoveredTasks, ["task-dead"]);

    const task = db.getTask("task-dead");
    assert.equal(task?.status, "READY");
    assert.equal(task?.assignedWorkerId, null);
    assert.ok(task?.errorMessage?.includes("PID 99999999 is no longer running"));

    const lease = db.getWorkerLease("task-dead");
    assert.equal(lease, null); // No ACTIVE lease remaining
  } finally {
    cleanup();
  }
});

test("LeaseWatchdog expires lease when heartbeat timeout is exceeded", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const worktrees = new WorktreeManager(repoRoot);
    const waymark = new WaymarkSupervisor();
    const watchdog = new LeaseWatchdog(db, worktrees, waymark);

    db.insertTask({
      id: "task-stale",
      title: "Stale Task",
      description: "Agent stopped reporting heartbeats",
      status: "IN_PROGRESS",
      baseBranch: "main",
      branch: "arbiter/task-stale",
      worktreePath: null,
      assignedWorkerId: "worker-stale",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    // Heartbeat 10 minutes in the past
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    db.setWorkerLease({
      workerId: "worker-stale",
      taskId: "task-stale",
      pid: process.pid, // PID is alive, but heartbeat timed out
      heartbeatAt: tenMinutesAgo,
      status: "ACTIVE",
    });

    // Scan with 60 second timeout
    const result = watchdog.scanLeases({ heartbeatTimeoutMs: 60_000 });
    assert.equal(result.scanned, 1);
    assert.equal(result.expiredCount, 1);
    assert.deepEqual(result.recoveredTasks, ["task-stale"]);

    const task = db.getTask("task-stale");
    assert.equal(task?.status, "READY");
    assert.equal(task?.assignedWorkerId, null);
    assert.ok(task?.errorMessage?.includes("Heartbeat timed out"));
  } finally {
    cleanup();
  }
});

test("TaskService automatically triggers watchdog scan on claimNextTask", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const worktrees = new WorktreeManager(repoRoot);
    const waymark = new WaymarkSupervisor();
    const taskService = new TaskService(db, worktrees, waymark);

    // Abandoned task held by dead PID
    db.insertTask({
      id: "task-abandoned",
      title: "Abandoned Task",
      description: "Needs rescue",
      status: "IN_PROGRESS",
      baseBranch: "main",
      branch: "arbiter/task-abandoned",
      worktreePath: null,
      assignedWorkerId: "crashed-agent",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    db.setWorkerLease({
      workerId: "crashed-agent",
      taskId: "task-abandoned",
      pid: 99999998,
      heartbeatAt: new Date().toISOString(),
      status: "ACTIVE",
    });

    // Claim next task with new worker
    const claim = taskService.claimNextTask("rescuer-agent", process.pid);
    assert.ok(claim);
    assert.equal(claim.task.id, "task-abandoned");
    assert.equal(claim.task.status, "IN_PROGRESS");
    assert.equal(claim.task.assignedWorkerId, "rescuer-agent");
  } finally {
    cleanup();
  }
});

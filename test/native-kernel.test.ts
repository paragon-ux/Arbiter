import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import {
  isNativeKernelAvailable,
  nativeCreateJob,
  nativeAssignProcessToJob,
  nativeTerminateJob,
  nativeCloseJob,
  nativeAddWorktree,
  nativePruneWorktree,
  nativeStageAndCommit,
} from "../src/native/nativeKernel.js";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";
import { LeaseWatchdog } from "../src/dispatch/watchdog.js";
import { ArbiterDatabase } from "../src/db/database.js";
import { WaymarkSupervisor } from "../src/waymark/waymarkSupervisor.js";

describe("Native Kernel & Process Sandboxing Suite", () => {

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-native-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "arbiter-native@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Arbiter Native Test"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Arbiter Native Kernel Test\n", "utf8");
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

test("Native kernel module handles graceful degradation when binary is uncompiled", () => {
  const available = isNativeKernelAvailable();
  assert.equal(typeof available, "boolean");

  if (!available) {
    assert.equal(nativeCreateJob(), null);
    assert.equal(nativeAssignProcessToJob(1, process.pid), false);
    assert.equal(nativeTerminateJob(1), false);
    assert.equal(nativeCloseJob(1), false);
    assert.equal(nativeAddWorktree("fake", "name", "path", "branch"), null);
    assert.equal(nativePruneWorktree("fake", "name", "path"), null);
    assert.equal(nativeStageAndCommit("fake", "msg"), null);
  }
});

test("WorktreeManager seamlessly executes with native kernel or fallback", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const manager = new WorktreeManager(repoRoot);
    const { path: wtPath, branch } = manager.createWorktree("native-1", "main");

    assert.equal(branch, "arbiter/task-native-1");
    assert.ok(fs.existsSync(wtPath));
    assert.ok(fs.existsSync(path.join(wtPath, "README.md")));

    fs.writeFileSync(path.join(wtPath, "native.txt"), "Native execution verification\n", "utf8");
    const committed = manager.commitAll(wtPath, "Native commit test");
    assert.equal(committed, true);

    manager.removeWorktree("native-1");
    assert.equal(fs.existsSync(wtPath), false);
  } finally {
    cleanup();
  }
});

test("LeaseWatchdog sandbox lifecycle methods operate safely with native kernel", async () => {
  const db = new ArbiterDatabase(":memory:");
  const manager = new WorktreeManager(process.cwd());
  const waymark = new WaymarkSupervisor(process.cwd());
  const watchdog = new LeaseWatchdog(db, manager, waymark);

  // Spawn child process to test sandbox eviction
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    assert.ok(child.pid && child.pid > 0);
    const jobId = watchdog.sandboxWorker("worker-alpha", child.pid);
    if (isNativeKernelAvailable()) {
      assert.ok(jobId !== null);
    }

    // Evict or release worker sandbox cleanly
    watchdog.evictWorkerSandbox("worker-alpha");
    // Give OS a moment to reap the process
    await new Promise((r) => setTimeout(r, 50));
    if (isNativeKernelAvailable()) {
      assert.equal(watchdog.isPidAlive(child.pid), false);
    }
  } finally {
    try {
      child.kill();
    } catch {}
  }
});
});

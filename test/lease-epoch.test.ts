import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../src/db/database.js";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../src/waymark/waymarkSupervisor.js";
import { TaskService } from "../src/dag/taskService.js";

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-epoch-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "epoch@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Epoch Tester"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Epoch Test\n", "utf8");
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

describe("Lease Epoch Fencing & ABA Protection Suite", () => {
  test("Lease epoch monotonically increments upon task re-claim", () => {
    const { repoRoot, cleanup } = setupFixtureRepo();
    try {
      const db = new ArbiterDatabase(":memory:");
      const worktrees = new WorktreeManager(repoRoot);
      const waymark = new WaymarkSupervisor();
      const taskService = new TaskService(db, worktrees, waymark);

      const task = taskService.submitTask({
        id: "task-epoch-1",
        title: "Epoch Test Task",
        description: "Test monotonic epoch increments",
      });

      // Worker 1 claims task
      const claim1 = taskService.claimNextTask("worker-alpha", 11111);
      assert.ok(claim1);
      assert.equal(claim1.task.id, task.id);
      assert.equal(claim1.leaseEpoch, 1);

      // Watchdog marks lease expired
      db.expireWorkerLease("worker-alpha", task.id);
      db.updateTask(task.id, { status: "READY", assignedWorkerId: null });

      // Worker 2 claims task
      const claim2 = taskService.claimNextTask("worker-beta", 22222);
      assert.ok(claim2);
      assert.equal(claim2.task.id, task.id);
      assert.equal(claim2.leaseEpoch, 2);
    } finally {
      cleanup();
    }
  });

  test("Stale worker attempting checkpoint or complete is rejected with STALE_EPOCH_REVOKED", () => {
    const { repoRoot, cleanup } = setupFixtureRepo();
    try {
      const db = new ArbiterDatabase(":memory:");
      const worktrees = new WorktreeManager(repoRoot);
      const waymark = new WaymarkSupervisor();
      const taskService = new TaskService(db, worktrees, waymark);

      const task = taskService.submitTask({
        id: "task-epoch-2",
        title: "Stale Worker Test",
        description: "Test rejection of zombie worker checkpoint",
      });

      // Worker 1 claims task at epoch 1
      const claim1 = taskService.claimNextTask("worker-zombie", 33333);
      assert.ok(claim1);
      const staleEpoch = claim1.leaseEpoch;
      assert.equal(staleEpoch, 1);

      // Simulate worker freeze: watchdog expires lease and reclaims to READY
      db.expireWorkerLease("worker-zombie", task.id);
      db.updateTask(task.id, { status: "READY", assignedWorkerId: null });

      // Worker 2 re-claims task at epoch 2
      const claim2 = taskService.claimNextTask("worker-active", 44444);
      assert.ok(claim2);
      assert.equal(claim2.leaseEpoch, 2);

      // Zombie worker wakes up and attempts checkpoint with epoch 1
      assert.throws(
        () => {
          taskService.checkpoint(task.id, "worker-zombie", "Zombie progress", staleEpoch);
        },
        /Worker worker-zombie does not hold active lease|STALE_EPOCH_REVOKED/
      );

      // Even if worker ID matches active lease somehow, stale epoch must be rejected
      assert.throws(
        () => {
          taskService.checkpoint(task.id, "worker-active", "Active progress with stale epoch", 1);
        },
        /STALE_EPOCH_REVOKED/
      );

      // Valid epoch succeeds
      assert.doesNotThrow(() => {
        taskService.checkpoint(task.id, "worker-active", "Valid checkpoint", 2);
      });
    } finally {
      cleanup();
    }
  });
});

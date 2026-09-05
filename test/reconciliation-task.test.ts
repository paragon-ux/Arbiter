import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../src/db/database.js";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";
import { MergeQueue } from "../src/merge/mergeQueue.js";

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-reconcile-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "reconcile@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Reconcile Tester"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "conflict.txt"), "Base content line 1\nBase content line 2\n", "utf8");
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

describe("Automated Conflict Reconciliation Task Suite (SEQ-06)", () => {
  test("MergeQueue automatically spawns dependent reconciliation task on conflict", () => {
    const { repoRoot, cleanup } = setupFixtureRepo();
    try {
      const db = new ArbiterDatabase(":memory:");
      const worktrees = new WorktreeManager(repoRoot);
      const queue = new MergeQueue(db, worktrees, repoRoot);

      // Branch 1: Modify conflict.txt
      const taskId1 = "task-branch-1";
      const { path: wt1, branch: branch1 } = worktrees.createWorktree(taskId1, "main");
      fs.writeFileSync(path.join(wt1, "conflict.txt"), "Branch 1 conflicting modification\n", "utf8");
      worktrees.commitAll(wt1, "Commit from branch 1");

      db.insertTask({
        id: taskId1,
        title: "Task Branch 1",
        description: "First edit",
        baseBranch: "main",
        branch: branch1,
        status: "COMPLETED",
        worktreePath: wt1,
        assignedWorkerId: "worker-1",
        waymarkTrajectoryId: "trj_1",
        resultAnswer: "Done 1",
        errorMessage: null,
      });

      // Branch 2: Modify conflict.txt differently
      const taskId2 = "task-branch-2";
      const { path: wt2, branch: branch2 } = worktrees.createWorktree(taskId2, "main");
      fs.writeFileSync(path.join(wt2, "conflict.txt"), "Branch 2 mutually exclusive modification\n", "utf8");
      worktrees.commitAll(wt2, "Commit from branch 2");

      db.insertTask({
        id: taskId2,
        title: "Task Branch 2",
        description: "Second conflicting edit",
        baseBranch: "main",
        branch: branch2,
        status: "COMPLETED",
        worktreePath: wt2,
        assignedWorkerId: "worker-2",
        waymarkTrajectoryId: "trj_2",
        resultAnswer: "Done 2",
        errorMessage: null,
      });

      // 1. Merge branch 1 successfully into main
      const res1 = queue.mergeTask(taskId1, "main");
      assert.ok(res1.ok);
      assert.equal(res1.merged, true);

      // 2. Merge branch 2 -> must produce conflict against updated main
      const res2 = queue.mergeTask(taskId2, "main");
      assert.equal(res2.ok, false);
      assert.equal(res2.conflict, true);
      assert.ok(res2.reconciliationTaskId, "Must return reconciliationTaskId");
      assert.equal(res2.reconciliationTaskId, "reconcile-task-branch-2");

      // 3. Verify reconciliation task in DB
      const reconcileTask = db.getTask("reconcile-task-branch-2");
      assert.ok(reconcileTask, "Reconciliation task must exist in DB");
      assert.equal(reconcileTask.status, "PENDING");
      assert.ok(reconcileTask.title.includes("Reconcile Conflict"));
      assert.ok(reconcileTask.description.includes("Conflict Details"));

      // 4. Verify dependency edge: reconcile task depends on conflicted task
      const parents = db.getParentTaskIds("reconcile-task-branch-2");
      assert.ok(parents.includes("task-branch-2"), "Reconciliation task must depend on conflicted task");
    } finally {
      cleanup();
    }
  });
});

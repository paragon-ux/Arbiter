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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-sandbox-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "sandbox@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Sandbox Tester"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "Initial tracked content\n", "utf8");
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

describe("Dedicated Merge Sandbox Isolation Suite (SEQ-05)", () => {
  test("MergeQueue executes in dedicated sandbox without disturbing dirty operator checkout", () => {
    const { repoRoot, cleanup } = setupFixtureRepo();
    try {
      const db = new ArbiterDatabase(":memory:");
      const worktrees = new WorktreeManager(repoRoot);
      const queue = new MergeQueue(db, worktrees, repoRoot);

      // 1. Provision a task worktree and commit an orthogonal change
      const taskId = "task-sandbox-1";
      const { path: wtPath, branch } = worktrees.createWorktree(taskId, "main");
      fs.writeFileSync(path.join(wtPath, "feature.txt"), "Feature in isolated worktree\n", "utf8");
      const committed = worktrees.commitAll(wtPath, "Add feature in worktree");
      assert.ok(committed);

      db.insertTask({
        id: taskId,
        title: "Sandbox Feature Task",
        description: "Test dedicated merge sandbox",
        baseBranch: "main",
        branch,
        status: "COMPLETED",
        worktreePath: wtPath,
        assignedWorkerId: "worker-1",
        waymarkTrajectoryId: "trj_1",
        resultAnswer: "Done",
        errorMessage: null,
      });

      // 2. Operator introduces uncommitted tracked and untracked changes in primary repoRoot
      const dirtyUncommittedContent = "DIRTY UNCOMMITTED CHANGES IN OPERATOR CHECKOUT\n";
      fs.appendFileSync(path.join(repoRoot, "tracked.txt"), dirtyUncommittedContent, "utf8");
      fs.writeFileSync(path.join(repoRoot, "untracked.tmp"), "operator temporary file\n", "utf8");

      // Verify operator repo is indeed dirty
      const dirtyStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
      assert.ok(dirtyStatus.includes("M tracked.txt"));
      assert.ok(dirtyStatus.includes("?? untracked.tmp"));

      // 3. Execute merge via MergeQueue
      const mergeRes = queue.mergeTask(taskId, "main");
      assert.ok(mergeRes.ok, `Merge failed: ${mergeRes.reason}`);
      assert.equal(mergeRes.merged, true);

      // 4. Verify that operator checkout was NEVER disturbed
      const postMergeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
      assert.ok(postMergeStatus.includes("M tracked.txt"), "Operator modified tracked file must remain modified");
      assert.ok(postMergeStatus.includes("?? untracked.tmp"), "Operator untracked file must remain intact");

      const trackedContent = fs.readFileSync(path.join(repoRoot, "tracked.txt"), "utf8");
      assert.ok(trackedContent.includes(dirtyUncommittedContent), "Operator dirty content was not overwritten");

      // 5. Verify dedicated sandbox worktree exists
      const sandboxPath = queue.getMergeSandboxPath();
      assert.ok(fs.existsSync(sandboxPath), "Dedicated merge sandbox worktree must exist");
      assert.ok(fs.existsSync(path.join(sandboxPath, "feature.txt")), "Merged feature must be present in sandbox worktree");
    } finally {
      cleanup();
    }
  });
});

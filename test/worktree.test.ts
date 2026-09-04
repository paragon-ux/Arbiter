import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-wt-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "arbiter-test@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Arbiter Test"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Arbiter Test Repository\n", "utf8");
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

test("WorktreeManager provisions isolated worktree, commits changes, and prunes cleanly", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const manager = new WorktreeManager(repoRoot);

    // 1. Create worktree
    const { path: wtPath, branch } = manager.createWorktree("task-alpha", "main");
    assert.equal(branch, "arbiter/task-alpha");
    assert.ok(fs.existsSync(wtPath));
    assert.ok(fs.existsSync(path.join(wtPath, "README.md")));

    // 2. Commit a new file inside worktree
    fs.writeFileSync(path.join(wtPath, "alpha.txt"), "Created by Agent Alpha", "utf8");
    const committed = manager.commitAll(wtPath, "Add alpha.txt");
    assert.equal(committed, true);

    // 3. Verify main repo does not see alpha.txt yet
    assert.equal(fs.existsSync(path.join(repoRoot, "alpha.txt")), false);

    // 4. List worktrees
    const list = manager.listWorktrees();
    assert.ok(list.some((w) => w.branch === "arbiter/task-alpha"));

    // 5. Remove worktree
    manager.removeWorktree("task-alpha");
    assert.equal(fs.existsSync(wtPath), false);

    // 6. Delete branch
    manager.deleteBranch("task-alpha");
    const remainingList = manager.listWorktrees();
    assert.equal(remainingList.some((w) => w.branch === "arbiter/task-alpha"), false);
  } finally {
    cleanup();
  }
});

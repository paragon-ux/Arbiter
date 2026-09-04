import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../src/db/database.js";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";
import { MergeQueue } from "../src/merge/mergeQueue.js";

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-merge-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "arbiter-test@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Arbiter Test"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "shared.txt"), "Original content on line 1\n", "utf8");
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

test("MergeQueue cleanly merges independent task branch into main", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const manager = new WorktreeManager(repoRoot);
    const queue = new MergeQueue(db, manager, repoRoot);

    // 1. Setup task record & worktree
    db.insertTask({
      id: "T1",
      title: "Add Feature 1",
      description: "Description 1",
      baseBranch: "main",
      branch: manager.getBranchNameForTask("T1"),
      worktreePath: null,
      assignedWorkerId: "agent-1",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    const { path: wtPath } = manager.createWorktree("T1", "main");
    db.updateTask("T1", { worktreePath: wtPath });

    // 2. Commit a non-conflicting change
    fs.writeFileSync(path.join(wtPath, "feature1.txt"), "Feature 1 content", "utf8");
    manager.commitAll(wtPath, "Add feature 1");

    // 3. Mark completed
    db.updateTask("T1", { status: "COMPLETED" });

    // 4. Merge
    const result = queue.mergeTask("T1", "main");
    assert.equal(result.ok, true);
    assert.equal(result.merged, true);

    // 5. Verify feature1.txt is now in main repo
    assert.ok(fs.existsSync(path.join(repoRoot, "feature1.txt")));
    // Worktree was pruned
    assert.equal(fs.existsSync(wtPath), false);
  } finally {
    cleanup();
  }
});

test("MergeQueue quarantines conflicting task branch and aborts git merge cleanly", () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const manager = new WorktreeManager(repoRoot);
    const queue = new MergeQueue(db, manager, repoRoot);

    // Task A: modifies shared.txt
    db.insertTask({
      id: "TA",
      title: "Task A edit",
      description: "Desc A",
      baseBranch: "main",
      branch: manager.getBranchNameForTask("TA"),
      worktreePath: null,
      assignedWorkerId: "agent-A",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });
    const { path: wtA } = manager.createWorktree("TA", "main");
    db.updateTask("TA", { worktreePath: wtA });
    fs.writeFileSync(path.join(wtA, "shared.txt"), "Content from Task A\n", "utf8");
    manager.commitAll(wtA, "Task A modified shared.txt");
    db.updateTask("TA", { status: "COMPLETED" });

    // Task B: modifies shared.txt differently
    db.insertTask({
      id: "TB",
      title: "Task B edit",
      description: "Desc B",
      baseBranch: "main",
      branch: manager.getBranchNameForTask("TB"),
      worktreePath: null,
      assignedWorkerId: "agent-B",
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });
    const { path: wtB } = manager.createWorktree("TB", "main");
    db.updateTask("TB", { worktreePath: wtB });
    fs.writeFileSync(path.join(wtB, "shared.txt"), "Conflicting content from Task B\n", "utf8");
    manager.commitAll(wtB, "Task B modified shared.txt");
    db.updateTask("TB", { status: "COMPLETED" });

    // Merge Task A -> succeeds
    const resA = queue.mergeTask("TA", "main");
    assert.equal(resA.ok, true);
    assert.equal(resA.merged, true);

    // Merge Task B -> conflicts!
    const resB = queue.mergeTask("TB", "main");
    assert.equal(resB.ok, false);
    assert.equal(resB.merged, false);
    assert.equal(resB.conflict, true);

    // Verify Task B status is CONFLICT in DB
    const taskB = db.getTask("TB");
    assert.equal(taskB?.status, "CONFLICT");
    assert.match(taskB?.errorMessage ?? "", /conflict/i);

    // Verify worktree B is preserved for inspection
    assert.ok(fs.existsSync(wtB));

    // Verify main repo is NOT stuck in merge state
    const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(gitStatus.trim(), "");
  } finally {
    cleanup();
  }
});

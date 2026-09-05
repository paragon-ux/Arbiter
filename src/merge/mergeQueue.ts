import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../db/database.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import { TaskRecord } from "../db/types.js";

export interface MergeResult {
  ok: boolean;
  taskId: string;
  merged: boolean;
  conflict?: boolean;
  reason?: string;
  reconciliationTaskId?: string;
}

export class MergeQueue {
  constructor(
    public readonly db: ArbiterDatabase,
    public readonly worktrees: WorktreeManager,
    public readonly repoRoot: string,
  ) {}

  public getMergeSandboxPath(): string {
    return path.join(this.repoRoot, ".arbiter", "merge-sandbox");
  }

  public ensureMergeSandbox(targetBranch = "main"): string {
    const sandboxPath = this.getMergeSandboxPath();
    if (!fs.existsSync(sandboxPath)) {
      // Provision dedicated merge sandbox worktree
      this.git(["worktree", "add", "-f", sandboxPath, targetBranch]);
    } else {
      // Ensure sandbox is clean and on targetBranch
      try {
        this.gitIn(sandboxPath, ["merge", "--abort"]);
      } catch {}
      try {
        this.gitIn(sandboxPath, ["checkout", "-f", targetBranch]);
        this.gitIn(sandboxPath, ["clean", "-fd"]);
      } catch {}
    }

    return sandboxPath;
  }

  public spawnReconciliationTask(taskId: string, targetBranch: string, detail: string): string {
    const task = this.db.getTask(taskId);
    const reconcileId = `reconcile-${taskId}`;

    const existing = this.db.getTask(reconcileId);
    if (existing) return existing.id;

    const title = `Reconcile Conflict: ${task ? task.title : taskId}`;
    const description = `Automated conflict reconciliation task spawned for ${taskId} on branch ${targetBranch}.\n\nConflict Details:\n${detail}`;

    this.db.insertTask({
      id: reconcileId,
      title,
      description,
      baseBranch: targetBranch,
      branch: `arbiter/${reconcileId}`,
      status: "PENDING",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    this.db.addDependency(taskId, reconcileId);
    this.db.logEvent(reconcileId, "task.reconciliation_spawned", { parentTaskId: taskId, targetBranch, error: detail });
    return reconcileId;
  }

  public mergeTask(taskId: string, targetBranch = "main"): MergeResult {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (task.status !== "COMPLETED" && task.status !== "CONFLICT") {
      throw new Error(`Cannot merge task ${taskId}: status is ${task.status} (must be COMPLETED or CONFLICT)`);
    }

    const branch = this.worktrees.getBranchNameForTask(taskId);
    const sandboxPath = this.ensureMergeSandbox(targetBranch);

    let repoRootWasCleanOnTarget = false;
    try {
      const currentBranch = this.git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const status = this.git(["status", "--porcelain"]).trim();
      if (currentBranch === targetBranch && status.length === 0) {
        repoRootWasCleanOnTarget = true;
      }
    } catch {}

    try {
      // Execute merge inside dedicated merge sandbox (operator checkout in repoRoot is untouched)
      this.gitIn(sandboxPath, ["merge", "--no-ff", branch, "-m", `Merge task ${task.id}: ${task.title}`]);

      // If operator checkout was clean and tracking targetBranch, keep it in sync
      if (repoRootWasCleanOnTarget) {
        try {
          this.git(["reset", "--hard", targetBranch]);
        } catch {}
      }

      // Clean up ephemeral task worktree and branch
      this.worktrees.removeWorktree(taskId);
      this.worktrees.deleteBranch(taskId);

      this.db.updateTask(taskId, {
        status: "COMPLETED",
        worktreePath: null,
      });
      this.db.logEvent(taskId, "task.merged", { targetBranch, branch, mergedInSandbox: true });

      return {
        ok: true,
        taskId,
        merged: true,
      };
    } catch (error) {
      // Conflict or failure during merge
      const err = error as { message?: string; stderr?: string };
      const detail = err.stderr || err.message || "Merge conflict";

      // Abort in-progress git merge inside dedicated sandbox
      try {
        this.gitIn(sandboxPath, ["merge", "--abort"]);
      } catch {}

      // Mark task as CONFLICT and preserve worktree in quarantine
      this.db.updateTask(taskId, {
        status: "CONFLICT",
        errorMessage: `Merge conflict against ${targetBranch}: ${detail}`,
      });
      this.db.logEvent(taskId, "task.conflict", { targetBranch, error: detail });

      // Spawn automated conflict-reconciliation task (Part 2.4)
      const reconciliationTaskId = this.spawnReconciliationTask(taskId, targetBranch, detail);

      return {
        ok: false,
        taskId,
        merged: false,
        conflict: true,
        reason: detail,
        reconciliationTaskId,
      };
    }
  }

  public mergeAllCompleted(targetBranch = "main"): MergeResult[] {
    const completedTasks = this.db.listTasks("COMPLETED").filter((t) => t.worktreePath !== null);
    const results: MergeResult[] = [];

    for (const task of completedTasks) {
      const res = this.mergeTask(task.id, targetBranch);
      results.push(res);
      if (res.conflict) {
        // Quarantine conflicting branch and continue merging independent non-conflicting tasks (P2 #6)
        continue;
      }
    }
    return results;
  }

  private git(args: readonly string[]): string {
    return this.gitIn(this.repoRoot, args);
  }

  private gitIn(cwd: string, args: readonly string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }).trim();
  }
}

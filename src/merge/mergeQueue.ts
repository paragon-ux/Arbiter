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
}

export class MergeQueue {
  constructor(
    public readonly db: ArbiterDatabase,
    public readonly worktrees: WorktreeManager,
    public readonly repoRoot: string,
  ) {}

  public mergeTask(taskId: string, targetBranch = "main"): MergeResult {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (task.status !== "COMPLETED" && task.status !== "CONFLICT") {
      throw new Error(`Cannot merge task ${taskId}: status is ${task.status} (must be COMPLETED or CONFLICT)`);
    }

    const branch = this.worktrees.getBranchNameForTask(taskId);

    try {
      // 1. Ensure primary repo is clean and on targetBranch (P3 #12)
      const status = this.git(["status", "--porcelain"]).trim();
      if (status) {
        throw new Error(`Cannot perform merge: primary repo working tree has uncommitted changes:\n${status}`);
      }
      this.git(["checkout", targetBranch]);

      // 2. Attempt merge
      this.git(["merge", "--no-ff", branch, "-m", `Merge task ${task.id}: ${task.title}`]);

      // 3. Clean up ephemeral worktree and branch
      this.worktrees.removeWorktree(taskId);
      this.worktrees.deleteBranch(taskId);

      this.db.updateTask(taskId, {
        status: "COMPLETED",
        worktreePath: null,
      });
      this.db.logEvent(taskId, "task.merged", { targetBranch, branch });

      return {
        ok: true,
        taskId,
        merged: true,
      };
    } catch (error) {
      // Conflict or failure during merge
      const err = error as { message?: string; stderr?: string };
      const detail = err.stderr || err.message || "Merge conflict";

      // Abort in-progress git merge
      try {
        this.git(["merge", "--abort"]);
      } catch {}

      // Mark task as CONFLICT and preserve worktree in quarantine
      this.db.updateTask(taskId, {
        status: "CONFLICT",
        errorMessage: `Merge conflict against ${targetBranch}: ${detail}`,
      });
      this.db.logEvent(taskId, "task.conflict", { targetBranch, error: detail });

      return {
        ok: false,
        taskId,
        merged: false,
        conflict: true,
        reason: detail,
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
    return execFileSync("git", args, {
      cwd: this.repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }).trim();
  }
}

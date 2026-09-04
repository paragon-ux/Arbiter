import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isNativeKernelAvailable,
  nativeAddWorktree,
  nativeDeleteBranch,
  nativePruneWorktree,
  nativeStageAndCommit,
} from "../native/nativeKernel.js";

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
}

export class WorktreeManager {
  constructor(public readonly repoRoot: string) {}

  public getWorktreesDir(): string {
    return path.join(this.repoRoot, ".arbiter", "worktrees");
  }

  public getWorktreePathForTask(taskId: string): string {
    const raw = taskId.startsWith("task-") ? taskId.slice(5) : taskId;
    const safeId = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.getWorktreesDir(), `task-${safeId}`);
  }

  public getBranchNameForTask(taskId: string): string {
    const raw = taskId.startsWith("task-") ? taskId.slice(5) : taskId;
    const safeId = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `arbiter/task-${safeId}`;
  }

  public createWorktree(taskId: string, baseBranch = "main"): { path: string; branch: string } {
    const targetDir = this.getWorktreePathForTask(taskId);
    const branch = this.getBranchNameForTask(taskId);

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });

    // If worktree already exists, remove it cleanly first
    if (fs.existsSync(targetDir)) {
      this.removeWorktree(taskId);
    }

    // Delegate to native kernel if available
    if (isNativeKernelAvailable()) {
      const nativeRes = nativeAddWorktree(this.repoRoot, `task-${taskId}`, targetDir, branch, baseBranch);
      if (nativeRes && nativeRes.success) {
        const canonicalPath = fs.realpathSync.native(targetDir);
        return { path: canonicalPath, branch };
      }
    }

    // Ensure branch doesn't already exist from stale run in CLI fallback
    try {
      this.git(["branch", "-D", branch]);
    } catch {}

    // git worktree add -b <branch> <targetDir> <baseBranch>
    this.git(["worktree", "add", "-b", branch, targetDir, baseBranch]);

    const canonicalPath = fs.realpathSync.native(targetDir);
    return { path: canonicalPath, branch };
  }

  public removeWorktree(taskId: string): void {
    const targetDir = this.getWorktreePathForTask(taskId);
    if (isNativeKernelAvailable()) {
      const pruned = nativePruneWorktree(this.repoRoot, `task-${taskId}`, targetDir);
      if (pruned && pruned.success) {
        return;
      }
    }
    try {
      this.git(["worktree", "remove", "--force", targetDir]);
    } catch {
      // Fallback if git fails due to untracked/locked files
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    }
    try {
      this.git(["worktree", "prune"]);
    } catch {}
  }

  public deleteBranch(taskId: string): void {
    const branch = this.getBranchNameForTask(taskId);
    if (isNativeKernelAvailable()) {
      if (nativeDeleteBranch(this.repoRoot, branch)) {
        return;
      }
    }
    try {
      this.git(["branch", "-D", branch]);
    } catch {}
  }

  public listWorktrees(): WorktreeInfo[] {
    const output = this.git(["worktree", "list", "--porcelain"]);
    const lines = output.split(/\r?\n/);
    const result: WorktreeInfo[] = [];

    let current: Partial<WorktreeInfo> = {};
    for (const line of lines) {
      if (!line.trim()) {
        if (current.path) {
          result.push({
            path: current.path,
            head: current.head ?? "",
            branch: current.branch ?? "",
            bare: Boolean(current.bare),
          });
        }
        current = {};
        continue;
      }
      const [key, ...rest] = line.split(" ");
      const val = rest.join(" ");
      if (key === "worktree") current.path = val;
      else if (key === "HEAD") current.head = val;
      else if (key === "branch") current.branch = val.replace("refs/heads/", "");
      else if (key === "bare") current.bare = true;
    }
    if (current.path) {
      result.push({
        path: current.path,
        head: current.head ?? "",
        branch: current.branch ?? "",
        bare: Boolean(current.bare),
      });
    }
    return result;
  }

  public commitAll(worktreePath: string, message: string): boolean {
    if (isNativeKernelAvailable()) {
      const nativeRes = nativeStageAndCommit(worktreePath, message);
      if (nativeRes && nativeRes.success) {
        return true;
      }
    }
    this.gitIn(worktreePath, ["add", "-A"]);
    const status = this.gitIn(worktreePath, ["status", "--porcelain"]).trim();
    if (!status) return false; // Nothing to commit
    this.gitIn(worktreePath, ["commit", "-m", message]);
    return true;
  }

  private git(args: readonly string[]): string {
    return execFileSync("git", args, {
      cwd: this.repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }).trim();
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

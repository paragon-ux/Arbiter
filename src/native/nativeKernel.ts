import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface WorktreeNativeResult {
  success: boolean;
  worktreePath: string;
  branch: string;
  elapsedUs: number;
}

export interface CommitNativeResult {
  success: boolean;
  commitId: string;
  elapsedUs: number;
}

export interface PruneNativeResult {
  success: boolean;
  elapsedUs: number;
}

interface RawNativeKernel {
  isNativeKernelAvailable(): boolean;
  kernelCreateJob(): number | bigint;
  kernelAssignProcess(jobId: number | bigint, pid: number): boolean;
  kernelTerminateJob(jobId: number | bigint, exitCode?: number): boolean;
  kernelCloseJob(jobId: number | bigint): boolean;
  kernelAddWorktree(
    repoPath: string,
    name: string,
    path: string,
    branchName: string,
    baseRef?: string,
  ): {
    success: boolean;
    worktreePath: string;
    branch: string;
    elapsedUs: number;
  };
  kernelPruneWorktree(
    repoPath: string,
    name: string,
    path: string,
  ): {
    success: boolean;
    elapsedUs: number;
  };
  kernelStageAndCommit(
    worktreePath: string,
    message: string,
    authorName: string,
    authorEmail: string,
  ): {
    success: boolean;
    commitId: string;
    elapsedUs: number;
  };
  kernelDeleteBranch(repoPath: string, branchName: string): boolean;
}

let nativeKernelModule: RawNativeKernel | null = null;
let probeAttempted = false;

export function getNativeKernel(): RawNativeKernel | null {
  if (probeAttempted) return nativeKernelModule;
  probeAttempted = true;

  try {
    const req = createRequire(import.meta.url);
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidatePaths = [
      path.resolve(moduleDir, "../../native/arbiter-kernel.node"),
      path.resolve(moduleDir, "../../../dist/native/arbiter-kernel.node"),
      path.resolve(moduleDir, "../../dist/native/arbiter-kernel.node"),
      path.resolve(moduleDir, "../../../crates/arbiter-kernel/target/release/arbiter_kernel.node"),
      path.resolve(moduleDir, "../../../crates/arbiter-kernel/target/release/arbiter_kernel.dll"),
      path.resolve(moduleDir, "../../../crates/arbiter-kernel/target/debug/arbiter_kernel.node"),
      path.resolve(moduleDir, "../../../crates/arbiter-kernel/target/debug/arbiter_kernel.dll"),
      path.resolve(process.cwd(), "dist/native/arbiter-kernel.node"),
      path.resolve(process.cwd(), "crates/arbiter-kernel/target/release/arbiter_kernel.node"),
      path.resolve(process.cwd(), "crates/arbiter-kernel/target/release/arbiter_kernel.dll"),
      path.resolve(process.cwd(), "crates/arbiter-kernel/target/debug/arbiter_kernel.node"),
      path.resolve(process.cwd(), "crates/arbiter-kernel/target/debug/arbiter_kernel.dll"),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const mod = req(p) as RawNativeKernel;
          if (mod && typeof mod.isNativeKernelAvailable === "function") {
            nativeKernelModule = mod;
            return nativeKernelModule;
          }
        } catch {
          // Probe next candidate
        }
      }
    }
  } catch {
    // Graceful fallback
  }

  return null;
}

export function isNativeKernelAvailable(): boolean {
  return getNativeKernel() !== null;
}

export function nativeCreateJob(): number | null {
  const k = getNativeKernel();
  if (!k) return null;
  try {
    const id = k.kernelCreateJob();
    return Number(id);
  } catch {
    return null;
  }
}

export function nativeAssignProcessToJob(jobId: number, pid: number): boolean {
  const k = getNativeKernel();
  if (!k) return false;
  try {
    return k.kernelAssignProcess(jobId, pid);
  } catch {
    return false;
  }
}

export function nativeTerminateJob(jobId: number, exitCode = 1): boolean {
  const k = getNativeKernel();
  if (!k) return false;
  try {
    return k.kernelTerminateJob(jobId, exitCode);
  } catch {
    return false;
  }
}

export function nativeCloseJob(jobId: number): boolean {
  const k = getNativeKernel();
  if (!k) return false;
  try {
    return k.kernelCloseJob(jobId);
  } catch {
    return false;
  }
}

export function nativeAddWorktree(
  repoPath: string,
  name: string,
  targetPath: string,
  branchName: string,
  baseRef?: string,
): WorktreeNativeResult | null {
  const k = getNativeKernel();
  if (!k) return null;
  try {
    const res = k.kernelAddWorktree(repoPath, name, targetPath, branchName, baseRef);
    return {
      success: res.success,
      worktreePath: res.worktreePath,
      branch: res.branch,
      elapsedUs: res.elapsedUs,
    };
  } catch {
    return null;
  }
}

export function nativePruneWorktree(
  repoPath: string,
  name: string,
  targetPath: string,
): PruneNativeResult | null {
  const k = getNativeKernel();
  if (!k) return null;
  try {
    const res = k.kernelPruneWorktree(repoPath, name, targetPath);
    return {
      success: res.success,
      elapsedUs: res.elapsedUs,
    };
  } catch {
    return null;
  }
}

export function nativeStageAndCommit(
  worktreePath: string,
  message: string,
  authorName = "Arbiter",
  authorEmail = "arbiter@agent.local",
): CommitNativeResult | null {
  const k = getNativeKernel();
  if (!k) return null;
  try {
    const res = k.kernelStageAndCommit(worktreePath, message, authorName, authorEmail);
    return {
      success: res.success,
      commitId: res.commitId,
      elapsedUs: res.elapsedUs,
    };
  } catch {
    return null;
  }
}

export function nativeDeleteBranch(repoPath: string, branchName: string): boolean {
  const k = getNativeKernel();
  if (!k) return false;
  try {
    return Boolean(k.kernelDeleteBranch(repoPath, branchName));
  } catch {
    return false;
  }
}


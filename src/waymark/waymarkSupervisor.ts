import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface WaymarkStatusResult {
  status: string;
  trajectoryId: string | null;
  totalSteps: number;
}

export interface WaymarkBeginResult {
  ok: boolean;
  id: string;
}

export interface WaymarkCompleteResult {
  ok: boolean;
  id: string;
  published?: boolean;
}

export class WaymarkSupervisor {
  private readonly cliPath: string;

  constructor(customCliPath?: string) {
    if (customCliPath && fs.existsSync(customCliPath)) {
      this.cliPath = customCliPath;
    } else if (process.env.WAYMARK_CLI_PATH && fs.existsSync(process.env.WAYMARK_CLI_PATH)) {
      this.cliPath = process.env.WAYMARK_CLI_PATH;
    } else {
      const candidate1 = path.resolve(
        process.cwd(),
        "../../Deepseek-Project/Waymark/dist/src/cli.js",
      );
      const candidate2 = path.resolve(
        process.cwd(),
        "../Deepseek-Project/Waymark/dist/src/cli.js",
      );
      this.cliPath = fs.existsSync(candidate1)
        ? candidate1
        : fs.existsSync(candidate2)
          ? candidate2
          : "waymark";
    }
  }

  public initWorktree(worktreePath: string, profile: "recording" | "capn-cli" | "none" = "recording"): boolean {
    const res = this.runCli(worktreePath, ["init", "--profile", profile]);
    return Boolean(res && res.ok);
  }

  public beginTrajectory(worktreePath: string, question: string): string {
    const res = this.runCli(worktreePath, ["begin", question]) as unknown as WaymarkBeginResult;
    if (!res || !res.id) {
      throw new Error(`Failed to begin Waymark trajectory: ${JSON.stringify(res)}`);
    }
    return res.id;
  }

  public getStatus(worktreePath: string): WaymarkStatusResult {
    const res = this.runCli(worktreePath, ["status", "--porcelain"]) as Record<string, unknown>;
    return {
      status: String(res?.status ?? "NONE"),
      trajectoryId: res?.trajectoryId ? String(res.trajectoryId) : null,
      totalSteps: Number(res?.totalSteps ?? 0),
    };
  }

  public checkIntegrity(worktreePath: string): Record<string, unknown> {
    return this.runCli(worktreePath, ["check", "--active", "--porcelain"]);
  }

  public recoverLock(worktreePath: string, force = true): Record<string, unknown> {
    const args = ["recover-lock"];
    if (force) args.push("--force");
    return this.runCli(worktreePath, args);
  }

  public completeTrajectory(worktreePath: string, trajectoryId: string, answer: string): WaymarkCompleteResult {
    const res = this.runCli(worktreePath, ["complete", trajectoryId, answer]) as unknown as WaymarkCompleteResult;
    return res;
  }

  public abandonTrajectory(worktreePath: string, trajectoryId: string, reason?: string): boolean {
    const args = ["abandon", trajectoryId];
    if (reason) {
      args.push("--reason", reason);
    }
    const res = this.runCli(worktreePath, args);
    return Boolean(res && res.ok);
  }

  private runCli(cwd: string, args: readonly string[]): Record<string, unknown> {
    try {
      let stdout: string;
      if (this.cliPath.endsWith(".js")) {
        stdout = execFileSync(process.execPath, [this.cliPath, ...args], {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
        });
      } else {
        stdout = execFileSync(this.cliPath, args, {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
        });
      }
      return JSON.parse(stdout.trim()) as Record<string, unknown>;
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      if (err.stdout) {
        try {
          return JSON.parse(err.stdout.trim()) as Record<string, unknown>;
        } catch {}
      }
      throw new Error(`Waymark CLI failed: ${err.stderr || err.message}`);
    }
  }
}

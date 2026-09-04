import crypto from "node:crypto";
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
  private readonly cliPath: string | null = null;
  private fallbackMode = false;
  private readonly timeoutMs: number;

  constructor(customCliPath?: string) {
    this.timeoutMs = process.env.WAYMARK_CLI_TIMEOUT_MS
      ? parseInt(process.env.WAYMARK_CLI_TIMEOUT_MS, 10)
      : 30_000;

    if (process.env.WAYMARK_DISABLED === "true" || process.env.WAYMARK_DISABLED === "1") {
      this.fallbackMode = true;
      return;
    }

    if (customCliPath) {
      if (fs.existsSync(customCliPath)) {
        this.cliPath = customCliPath;
      } else {
        this.fallbackMode = true;
      }
      return;
    }

    if (process.env.WAYMARK_CLI_PATH && fs.existsSync(process.env.WAYMARK_CLI_PATH)) {
      this.cliPath = process.env.WAYMARK_CLI_PATH;
      return;
    }

    const candidate1 = path.resolve(
      process.cwd(),
      "../../Deepseek-Project/Waymark/dist/src/cli.js",
    );
    const candidate2 = path.resolve(
      process.cwd(),
      "../Deepseek-Project/Waymark/dist/src/cli.js",
    );

    if (fs.existsSync(candidate1)) {
      this.cliPath = candidate1;
      return;
    }

    if (fs.existsSync(candidate2)) {
      this.cliPath = candidate2;
      return;
    }

    // Probe if global "waymark" binary exists and responds
    try {
      execFileSync("waymark", ["--version"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
      this.cliPath = "waymark";
    } catch {
      // Waymark binary not found on host; activate graceful fallback adapter
      this.fallbackMode = true;
    }
  }

  public isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  public initWorktree(worktreePath: string, profile: "recording" | "capn-cli" | "none" = "recording"): boolean {
    if (this.fallbackMode || !this.cliPath) {
      const waymarkDir = path.join(worktreePath, ".waymark");
      fs.mkdirSync(waymarkDir, { recursive: true });
      return true;
    }

    try {
      const res = this.runCli(worktreePath, ["init", "--profile", profile]);
      return Boolean(res && res.ok);
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.initWorktree(worktreePath, profile);
      }
      throw err;
    }
  }

  public beginTrajectory(worktreePath: string, question: string): string {
    if (this.fallbackMode || !this.cliPath) {
      const waymarkDir = path.join(worktreePath, ".waymark");
      fs.mkdirSync(waymarkDir, { recursive: true });
      const id = `trj_mock_${crypto.randomUUID().slice(0, 8)}`;
      const stateFile = path.join(waymarkDir, "trajectory.json");
      fs.writeFileSync(
        stateFile,
        JSON.stringify(
          {
            id,
            question,
            status: "STAGED",
            steps: 0,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      return id;
    }

    try {
      const res = this.runCli(worktreePath, ["begin", question]);
      this.validateResponse(res, "begin");
      if (!res.id) {
        throw new Error(`Failed to begin Waymark trajectory: response missing trajectory ID`);
      }
      return String(res.id);
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.beginTrajectory(worktreePath, question);
      }
      throw err;
    }
  }

  public getStatus(worktreePath: string): WaymarkStatusResult {
    if (this.fallbackMode || !this.cliPath) {
      const stateFile = path.join(worktreePath, ".waymark", "trajectory.json");
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
          return {
            status: String(data.status ?? "STAGED"),
            trajectoryId: data.id ? String(data.id) : null,
            totalSteps: Number(data.steps ?? 0),
          };
        } catch {}
      }
      return { status: "NONE", trajectoryId: null, totalSteps: 0 };
    }

    try {
      const res = this.runCli(worktreePath, ["status", "--porcelain"]);
      return {
        status: String(res?.status ?? "NONE"),
        trajectoryId: res?.trajectoryId ? String(res.trajectoryId) : null,
        totalSteps: Number(res?.totalSteps ?? 0),
      };
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.getStatus(worktreePath);
      }
      throw err;
    }
  }

  public checkIntegrity(worktreePath: string): Record<string, unknown> {
    if (this.fallbackMode || !this.cliPath) {
      return { ok: true, valid: true, mode: "fallback" };
    }

    try {
      return this.runCli(worktreePath, ["check", "--active", "--porcelain"]);
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.checkIntegrity(worktreePath);
      }
      throw err;
    }
  }

  public recoverLock(worktreePath: string, force = true): Record<string, unknown> {
    if (this.fallbackMode || !this.cliPath) {
      return { ok: true, recovered: true, mode: "fallback" };
    }

    try {
      const args = ["recover-lock"];
      if (force) args.push("--force");
      return this.runCli(worktreePath, args);
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.recoverLock(worktreePath, force);
      }
      throw err;
    }
  }

  public completeTrajectory(worktreePath: string, trajectoryId: string, answer: string): WaymarkCompleteResult {
    if (this.fallbackMode || !this.cliPath) {
      const stateFile = path.join(worktreePath, ".waymark", "trajectory.json");
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
          data.status = "COMMITTED";
          data.answer = answer;
          data.completedAt = new Date().toISOString();
          fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), "utf8");
        } catch {}
      }
      return { ok: true, id: trajectoryId, published: true };
    }

    try {
      const res = this.runCli(worktreePath, ["complete", trajectoryId, answer]);
      this.validateResponse(res, "complete");
      return {
        ok: Boolean(res.ok),
        id: String(res.id ?? trajectoryId),
        published: Boolean(res.published),
      };
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.completeTrajectory(worktreePath, trajectoryId, answer);
      }
      throw err;
    }
  }

  public abandonTrajectory(worktreePath: string, trajectoryId: string, reason?: string): boolean {
    if (this.fallbackMode || !this.cliPath) {
      const stateFile = path.join(worktreePath, ".waymark", "trajectory.json");
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
          data.status = "ABANDONED";
          data.reason = reason;
          data.abandonedAt = new Date().toISOString();
          fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), "utf8");
        } catch {}
      }
      return true;
    }

    try {
      const args = ["abandon", trajectoryId];
      if (reason) {
        args.push("--reason", reason);
      }
      const res = this.runCli(worktreePath, args);
      return Boolean(res && res.ok);
    } catch (err) {
      if (this.isSpawnEnoent(err)) {
        this.fallbackMode = true;
        return this.abandonTrajectory(worktreePath, trajectoryId, reason);
      }
      throw err;
    }
  }

  private validateResponse(res: Record<string, unknown>, operation: string): void {
    if (!res || typeof res !== "object") {
      throw new Error(`Invalid response from Waymark CLI during ${operation}: expected object`);
    }
  }

  private isSpawnEnoent(error: unknown): boolean {
    const err = error as { code?: string; message?: string };
    return (
      err?.code === "ENOENT" ||
      (typeof err?.message === "string" && err.message.includes("ENOENT"))
    );
  }

  private runCli(cwd: string, args: readonly string[]): Record<string, unknown> {
    if (!this.cliPath) {
      throw new Error("Waymark CLI path is not set");
    }

    try {
      let stdout: string;
      if (this.cliPath.endsWith(".js")) {
        stdout = execFileSync(process.execPath, [this.cliPath, ...args], {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: this.timeoutMs,
        });
      } else {
        stdout = execFileSync(this.cliPath, args, {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: this.timeoutMs,
        });
      }
      return JSON.parse(stdout.trim()) as Record<string, unknown>;
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string; code?: string };
      if (this.isSpawnEnoent(err)) {
        throw error;
      }
      if (err.stdout) {
        try {
          return JSON.parse(err.stdout.trim()) as Record<string, unknown>;
        } catch {}
      }
      throw new Error(`Waymark CLI failed: ${err.stderr || err.message}`);
    }
  }
}

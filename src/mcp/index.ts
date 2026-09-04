#!/usr/bin/env node

import path from "node:path";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../db/database.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../waymark/waymarkSupervisor.js";
import { TaskService } from "../dag/taskService.js";
import { MergeQueue } from "../merge/mergeQueue.js";
import { createArbiterTools } from "./tools.js";
import { ArbiterMcpServer } from "./server.js";

function getRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return process.cwd();
  }
}

function main(): void {
  const repoRoot = getRepoRoot();
  const dbPath = path.join(repoRoot, ".arbiter", "arbiter.db");
  const db = new ArbiterDatabase(dbPath);
  const worktrees = new WorktreeManager(repoRoot);
  const waymark = new WaymarkSupervisor();
  const taskService = new TaskService(db, worktrees, waymark);
  const mergeQueue = new MergeQueue(db, worktrees, repoRoot);

  const tools = createArbiterTools(taskService, waymark, mergeQueue);
  const server = new ArbiterMcpServer(tools);

  server.listenStdio();
}

main();

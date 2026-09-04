#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../db/database.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../waymark/waymarkSupervisor.js";
import { TaskService } from "../dag/taskService.js";
import { MergeQueue } from "../merge/mergeQueue.js";
import { TaskStatus } from "../db/types.js";

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

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function main(): void {
  const repoRoot = getRepoRoot();
  const dbPath = path.join(repoRoot, ".arbiter", "arbiter.db");
  const db = new ArbiterDatabase(dbPath);
  const worktrees = new WorktreeManager(repoRoot);
  const waymark = new WaymarkSupervisor();
  const taskService = new TaskService(db, worktrees, waymark);
  const mergeQueue = new MergeQueue(db, worktrees, repoRoot);

  const argv = process.argv.slice(2);
  const command = argv[0];
  const { positionals, flags } = parseFlags(argv.slice(1));

  try {
    switch (command) {
      case "submit": {
        const title = String(flags.title ?? positionals[0] ?? "");
        const description = String(flags.description ?? flags.desc ?? title);
        if (!title) {
          console.error("Error: --title is required");
          process.exit(1);
        }
        const baseBranch = typeof flags.base === "string" ? flags.base : "main";
        const deps = typeof flags.deps === "string" ? flags.deps.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const task = taskService.submitTask({ title, description, baseBranch, dependencies: deps });
        console.log(JSON.stringify({ ok: true, task }, null, 2));
        break;
      }

      case "list": {
        const statusFilter = typeof flags.status === "string" ? (flags.status.toUpperCase() as TaskStatus) : undefined;
        const tasks = db.listTasks(statusFilter);
        console.log(JSON.stringify({ ok: true, count: tasks.length, tasks }, null, 2));
        break;
      }

      case "status": {
        const taskId = positionals[0] || (typeof flags.task === "string" ? flags.task : undefined);
        if (taskId) {
          const task = db.getTask(taskId);
          if (!task) {
            console.error(`Task ${taskId} not found`);
            process.exit(1);
          }
          const parents = db.getParentTaskIds(taskId);
          const children = db.getChildTaskIds(taskId);
          const lease = db.getWorkerLease(taskId);
          const events = db.getEvents(taskId);
          console.log(JSON.stringify({ ok: true, task, parents, children, lease, events }, null, 2));
        } else {
          const all = db.listTasks();
          const ready = db.getReadyTasks();
          const activeWorktrees = worktrees.listWorktrees();
          console.log(JSON.stringify({
            ok: true,
            totalTasks: all.length,
            readyTasks: ready.length,
            activeWorktrees: activeWorktrees.length,
            tasks: all,
          }, null, 2));
        }
        break;
      }

      case "merge": {
        const taskId = positionals[0] || (typeof flags.task === "string" ? flags.task : undefined);
        const targetBranch = typeof flags.target === "string" ? flags.target : "main";
        if (taskId) {
          const res = mergeQueue.mergeTask(taskId, targetBranch);
          console.log(JSON.stringify(res, null, 2));
        } else {
          const res = mergeQueue.mergeAllCompleted(targetBranch);
          console.log(JSON.stringify({ ok: true, merges: res }, null, 2));
        }
        break;
      }

      case "recover-lock": {
        const taskId = positionals[0] || (typeof flags.task === "string" ? flags.task : undefined);
        if (!taskId) {
          console.error("Error: task ID required");
          process.exit(1);
        }
        const task = db.getTask(taskId);
        if (!task || !task.worktreePath) {
          console.error(`Task ${taskId} has no active worktree`);
          process.exit(1);
        }
        const force = Boolean(flags.force);
        const result = waymark.recoverLock(task.worktreePath, force);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "claim": {
        const workerId = String(flags.worker ?? flags.worker_id ?? positionals[0] ?? `worker-${process.pid}`);
        const pid = typeof flags.pid === "string" ? parseInt(flags.pid, 10) : process.pid;
        const result = taskService.claimNextTask(workerId, pid);
        if (!result) {
          console.log(JSON.stringify({ ok: true, task: null, message: "No ready tasks available in queue." }, null, 2));
        } else {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        }
        break;
      }

      case "checkpoint": {
        const taskId = String(flags.task ?? flags.task_id ?? positionals[0] ?? "");
        const workerId = String(flags.worker ?? flags.worker_id ?? positionals[1] ?? "");
        const message = String(flags.message ?? flags.msg ?? positionals[2] ?? "");
        if (!taskId || !workerId || !message) {
          console.error("Error: --task, --worker, and --message are required");
          process.exit(1);
        }
        taskService.checkpoint(taskId, workerId, message);
        console.log(JSON.stringify({ ok: true, taskId, checkpointRecorded: true }, null, 2));
        break;
      }

      case "complete": {
        const taskId = String(flags.task ?? flags.task_id ?? positionals[0] ?? "");
        const workerId = String(flags.worker ?? flags.worker_id ?? positionals[1] ?? "");
        const answer = String(flags.answer ?? flags.ans ?? positionals[2] ?? "");
        if (!taskId || !workerId || !answer) {
          console.error("Error: --task, --worker, and --answer are required");
          process.exit(1);
        }
        const updated = taskService.completeTask(taskId, workerId, answer);
        console.log(JSON.stringify({ ok: true, task: updated }, null, 2));
        break;
      }

      case "fail": {
        const taskId = String(flags.task ?? flags.task_id ?? positionals[0] ?? "");
        const workerId = String(flags.worker ?? flags.worker_id ?? positionals[1] ?? "");
        const errorMsg = String(flags.error ?? flags.err ?? positionals[2] ?? "Unspecified error");
        if (!taskId || !workerId) {
          console.error("Error: --task and --worker are required");
          process.exit(1);
        }
        const updated = taskService.failTask(taskId, workerId, errorMsg);
        console.log(JSON.stringify({ ok: true, task: updated }, null, 2));
        break;
      }

      case "watchdog": {
        const timeoutMs = typeof flags.timeout === "string" ? parseInt(flags.timeout, 10) * 1000 : undefined;
        const force = flags.force !== false && flags["no-force"] !== true;
        const scanRes = taskService.watchdog.scanLeases({ heartbeatTimeoutMs: timeoutMs, forceLockRecovery: force });
        console.log(JSON.stringify({ ok: true, ...scanRes }, null, 2));
        break;
      }

      case "prune": {
        const activeWorktrees = worktrees.listWorktrees();
        const pruned: string[] = [];
        for (const wt of activeWorktrees) {
          if (wt.branch.startsWith("arbiter/task-")) {
            const taskId = wt.branch.replace("arbiter/task-", "");
            const task = db.getTask(taskId);
            if (task && (task.status === "COMPLETED" || task.status === "FAILED")) {
              worktrees.removeWorktree(taskId);
              worktrees.deleteBranch(taskId);
              pruned.push(taskId);
            }
          }
        }
        console.log(JSON.stringify({ ok: true, prunedCount: pruned.length, pruned }, null, 2));
        break;
      }

      default:
        console.log(`Arbiter Multi-Agent Orchestrator CLI

Usage:
  arbiter submit --title "<title>" [--description "<desc>"] [--deps "<task1,task2>"] [--base <branch>]
  arbiter claim [--worker <id>] [--pid <pid>]
  arbiter checkpoint --task <id> --worker <id> --message "<msg>"
  arbiter complete --task <id> --worker <id> --answer "<answer>"
  arbiter fail --task <id> --worker <id> --error "<error>"
  arbiter list [--status <PENDING|READY|ASSIGNED|IN_PROGRESS|COMPLETED|FAILED|CONFLICT>]
  arbiter status [<task-id>]
  arbiter merge [<task-id>] [--target <branch>]
  arbiter recover-lock <task-id> [--force]
  arbiter watchdog [--timeout <sec>] [--no-force]
  arbiter prune
`);
        break;
    }
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  } finally {
    db.close();
  }
}

main();

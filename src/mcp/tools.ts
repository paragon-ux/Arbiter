import { TaskService } from "../dag/taskService.js";
import { WaymarkSupervisor } from "../waymark/waymarkSupervisor.js";
import { MergeQueue } from "../merge/mergeQueue.js";
import { errorResult, jsonResult, McpToolHandler } from "./types.js";

export function createArbiterTools(
  taskService: TaskService,
  waymark: WaymarkSupervisor,
  mergeQueue?: MergeQueue,
): McpToolHandler[] {
  const claimTaskTool: McpToolHandler = {
    definition: {
      name: "arbiter_claim_task",
      description: "Claim the next available READY task from Arbiter's DAG and provision an isolated worktree with Waymark.",
      inputSchema: {
        type: "object",
        properties: {
          worker_id: {
            type: "string",
            description: "Identifier for the agent claiming the task.",
          },
          pid: {
            type: "number",
            description: "Optional PID of the agent process for lease monitoring.",
          },
        },
        required: ["worker_id"],
      },
    },
    handler: async (args) => {
      try {
        const workerId = String(args.worker_id);
        const pid = typeof args.pid === "number" ? args.pid : process.pid;
        const result = taskService.claimNextTask(workerId, pid);
        if (!result) {
          return jsonResult({ ok: true, task: null, message: "No ready tasks available in queue." });
        }
        return jsonResult({
          ok: true,
          task_id: result.task.id,
          title: result.task.title,
          description: result.task.description,
          worktree_path: result.worktreePath,
          branch: result.branch,
          waymark_trajectory_id: result.waymarkTrajectoryId,
          lease_epoch: result.leaseEpoch,
          directive: "Work strictly within worktree_path. Record hops using waymark_note. Call arbiter_complete_task when verified.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const checkpointTool: McpToolHandler = {
    definition: {
      name: "arbiter_checkpoint",
      description: "Record an intermediate progress milestone and refresh the worker lease heartbeat with Waymark telemetry.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Active task ID.",
          },
          worker_id: {
            type: "string",
            description: "Claiming worker ID.",
          },
          message: {
            type: "string",
            description: "Summary of progress made.",
          },
          lease_epoch: {
            type: "number",
            description: "Optional monotonic lease epoch for ABA fencing.",
          },
        },
        required: ["task_id", "worker_id", "message"],
      },
    },
    handler: async (args) => {
      try {
        const taskId = String(args.task_id);
        const workerId = String(args.worker_id);
        const message = String(args.message);
        const leaseEpoch = typeof args.lease_epoch === "number" ? args.lease_epoch : undefined;
        taskService.checkpoint(taskId, workerId, message, leaseEpoch);

        const task = taskService.db.getTask(taskId);
        let waymarkStatus: { status?: string; trajectoryId?: string | null; totalSteps?: number } | null = null;
        if (task && task.worktreePath) {
          try {
            waymarkStatus = waymark.getStatus(task.worktreePath);
          } catch {}
        }

        return jsonResult({
          ok: true,
          task_id: taskId,
          checkpoint_recorded: true,
          ...(waymarkStatus
            ? {
                waymark_status: waymarkStatus.status,
                waymark_trajectory_id: waymarkStatus.trajectoryId,
                waymark_total_hops: waymarkStatus.totalSteps,
              }
            : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const completeTaskTool: McpToolHandler = {
    definition: {
      name: "arbiter_complete_task",
      description: "Complete an active task, seal its Waymark trajectory, commit worktree changes, and unblock downstream DAG tasks.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID to complete.",
          },
          worker_id: {
            type: "string",
            description: "Claiming worker ID.",
          },
          answer: {
            type: "string",
            description: "Synthesized findings and summary of changes made.",
          },
          lease_epoch: {
            type: "number",
            description: "Optional monotonic lease epoch for ABA fencing.",
          },
        },
        required: ["task_id", "worker_id", "answer"],
      },
    },
    handler: async (args) => {
      try {
        const taskId = String(args.task_id);
        const workerId = String(args.worker_id);
        const answer = String(args.answer);
        const leaseEpoch = typeof args.lease_epoch === "number" ? args.lease_epoch : undefined;
        const updated = taskService.completeTask(taskId, workerId, answer, leaseEpoch);
        return jsonResult({
          ok: true,
          task_id: taskId,
          status: updated.status,
          completed_at: updated.completedAt,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const failTaskTool: McpToolHandler = {
    definition: {
      name: "arbiter_fail_task",
      description: "Mark a task as failed and abandon its active Waymark trajectory.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID.",
          },
          worker_id: {
            type: "string",
            description: "Claiming worker ID.",
          },
          error_message: {
            type: "string",
            description: "Reason for task failure.",
          },
        },
        required: ["task_id", "worker_id", "error_message"],
      },
    },
    handler: async (args) => {
      try {
        const taskId = String(args.task_id);
        const workerId = String(args.worker_id);
        const errorMessage = String(args.error_message);
        const updated = taskService.failTask(taskId, workerId, errorMessage);
        return jsonResult({
          ok: true,
          task_id: taskId,
          status: updated.status,
          error_message: updated.errorMessage,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const recoverLockTool: McpToolHandler = {
    definition: {
      name: "arbiter_recover_lock",
      description: "Inspect or recover an orphaned Waymark lock in a task's worktree.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID whose worktree lock needs inspection or recovery.",
          },
          force: {
            type: "boolean",
            description: "Force reclaim if owner PID has terminated.",
          },
        },
        required: ["task_id"],
      },
    },
    handler: async (args) => {
      try {
        const taskId = String(args.task_id);
        const task = taskService.db.getTask(taskId);
        if (!task || !task.worktreePath) {
          throw new Error(`Task ${taskId} not found or has no active worktree.`);
        }
        const force = Boolean(args.force);
        const result = waymark.recoverLock(task.worktreePath, force);
        return jsonResult({
          ok: true,
          task_id: taskId,
          ...result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const statusTool: McpToolHandler = {
    definition: {
      name: "arbiter_status",
      description: "Query task queue status or details of a specific task.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Optional specific task ID to inspect.",
          },
        },
      },
    },
    handler: async (args) => {
      try {
        if (typeof args.task_id === "string" && args.task_id.trim()) {
          const task = taskService.db.getTask(args.task_id.trim());
          if (!task) return jsonResult({ ok: false, message: `Task ${args.task_id} not found` }, true);
          const parents = taskService.db.getParentTaskIds(task.id);
          const children = taskService.db.getChildTaskIds(task.id);
          const lease = taskService.db.getWorkerLease(task.id);
          return jsonResult({
            ok: true,
            task,
            parents,
            children,
            lease,
          });
        }
        const all = taskService.db.listTasks();
        const ready = taskService.db.getReadyTasks();
        return jsonResult({
          ok: true,
          total: all.length,
          ready_count: ready.length,
          tasks: all,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const submitTaskTool: McpToolHandler = {
    definition: {
      name: "arbiter_submit_task",
      description: "Submit a new task to Arbiter's DAG with optional parent dependencies.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title." },
          description: { type: "string", description: "Detailed task instructions." },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs that must complete before this task becomes READY.",
          },
          base_branch: { type: "string", description: "Base branch to branch from (default 'main')." },
          task_id: { type: "string", description: "Optional custom task ID." },
        },
        required: ["title", "description"],
      },
    },
    handler: async (args) => {
      try {
        const title = String(args.title);
        const description = String(args.description);
        const dependencies = Array.isArray(args.dependencies) ? args.dependencies.map(String) : undefined;
        const baseBranch = typeof args.base_branch === "string" ? args.base_branch : undefined;
        const id = typeof args.task_id === "string" ? args.task_id : undefined;
        const task = taskService.submitTask({ id, title, description, dependencies, baseBranch });
        return jsonResult({ ok: true, task });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const mergeQueueTool: McpToolHandler = {
    definition: {
      name: "arbiter_process_merge_queue",
      description: "Process completed tasks in the sequential merge queue into the target branch.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Optional specific task ID to merge." },
          target_branch: { type: "string", description: "Target branch to merge into (default 'main')." },
        },
      },
    },
    handler: async (args) => {
      try {
        const queue = mergeQueue ?? new MergeQueue(taskService.db, taskService.worktrees, taskService.worktrees.repoRoot);
        const targetBranch = typeof args.target_branch === "string" ? args.target_branch : "main";
        if (typeof args.task_id === "string" && args.task_id.trim()) {
          const res = queue.mergeTask(args.task_id.trim(), targetBranch);
          return jsonResult(res);
        }
        const merges = queue.mergeAllCompleted(targetBranch);
        return jsonResult({ ok: true, merges });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const scanLeasesTool: McpToolHandler = {
    definition: {
      name: "arbiter_scan_leases",
      description: "Scan active worker leases for dead processes or heartbeat timeouts and recover orphaned Waymark locks.",
      inputSchema: {
        type: "object",
        properties: {
          heartbeat_timeout_ms: { type: "number", description: "Heartbeat timeout in milliseconds (default 300,000)." },
          force_lock_recovery: { type: "boolean", description: "Whether to force Waymark lock recovery." },
        },
      },
    },
    handler: async (args) => {
      try {
        const timeout = typeof args.heartbeat_timeout_ms === "number" ? args.heartbeat_timeout_ms : undefined;
        const force = typeof args.force_lock_recovery === "boolean" ? args.force_lock_recovery : true;
        const result = taskService.watchdog.scanLeases({ heartbeatTimeoutMs: timeout, forceLockRecovery: force });
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const pruneWorktreesTool: McpToolHandler = {
    definition: {
      name: "arbiter_prune_worktrees",
      description: "Prune worktrees and delete branches for completed or failed tasks.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      try {
        const activeWorktrees = taskService.worktrees.listWorktrees();
        const pruned: string[] = [];
        for (const wt of activeWorktrees) {
          if (wt.branch.startsWith("arbiter/task-")) {
            const taskId = wt.branch.replace("arbiter/task-", "");
            const task = taskService.db.getTask(taskId);
            if (task && (task.status === "COMPLETED" || task.status === "FAILED")) {
              taskService.worktrees.removeWorktree(taskId);
              taskService.worktrees.deleteBranch(taskId);
              pruned.push(taskId);
            }
          }
        }
        return jsonResult({ ok: true, pruned_count: pruned.length, pruned });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const metricsTool: McpToolHandler = {
    definition: {
      name: "arbiter_metrics",
      description: "Retrieve comprehensive cluster observability metrics, task breakdown, active leases, and event counts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      try {
        const metrics = taskService.db.getMetrics();
        const activeWorktrees = taskService.worktrees.listWorktrees().filter((w) => w.branch.startsWith("arbiter/task-")).length;
        return jsonResult({
          ok: true,
          metrics: {
            ...metrics,
            activeWorktrees,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  return [
    submitTaskTool,
    claimTaskTool,
    checkpointTool,
    completeTaskTool,
    failTaskTool,
    recoverLockTool,
    statusTool,
    mergeQueueTool,
    scanLeasesTool,
    pruneWorktreesTool,
    metricsTool,
  ];
}

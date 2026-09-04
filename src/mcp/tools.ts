import { TaskService } from "../dag/taskService.js";
import { WaymarkSupervisor } from "../waymark/waymarkSupervisor.js";
import { errorResult, jsonResult, McpToolHandler } from "./types.js";

export function createArbiterTools(taskService: TaskService, waymark: WaymarkSupervisor): McpToolHandler[] {
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
      description: "Record an intermediate progress milestone and refresh the worker lease heartbeat.",
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
        },
        required: ["task_id", "worker_id", "message"],
      },
    },
    handler: async (args) => {
      try {
        const taskId = String(args.task_id);
        const workerId = String(args.worker_id);
        const message = String(args.message);
        taskService.checkpoint(taskId, workerId, message);
        return jsonResult({ ok: true, task_id: taskId, checkpoint_recorded: true });
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
        },
        required: ["task_id", "worker_id", "answer"],
      },
    },
    handler: async (args) => {
      try {
        const taskId = String(args.task_id);
        const workerId = String(args.worker_id);
        const answer = String(args.answer);
        const updated = taskService.completeTask(taskId, workerId, answer);
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

  return [
    claimTaskTool,
    checkpointTool,
    completeTaskTool,
    failTaskTool,
    recoverLockTool,
    statusTool,
  ];
}

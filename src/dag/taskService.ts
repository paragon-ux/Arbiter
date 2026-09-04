import crypto from "node:crypto";
import { ArbiterDatabase } from "../db/database.js";
import { TaskRecord } from "../db/types.js";
import { TaskGraph } from "./taskGraph.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../waymark/waymarkSupervisor.js";
import { LeaseWatchdog } from "../dispatch/watchdog.js";

export interface SubmitTaskParams {
  id?: string;
  title: string;
  description: string;
  baseBranch?: string;
  dependencies?: string[];
}

export interface ClaimTaskResult {
  task: TaskRecord;
  worktreePath: string;
  branch: string;
  waymarkTrajectoryId: string;
}

export class TaskService {
  public readonly graph: TaskGraph;
  public readonly watchdog: LeaseWatchdog;
  private lastWatchdogScan = 0;
  private readonly watchdogThrottleMs = 5_000;

  constructor(
    public readonly db: ArbiterDatabase,
    public readonly worktrees: WorktreeManager,
    public readonly waymark: WaymarkSupervisor,
  ) {
    this.graph = new TaskGraph(db);
    this.watchdog = new LeaseWatchdog(db, worktrees, waymark);
  }

  public submitTask(params: SubmitTaskParams): TaskRecord {
    const id = params.id ?? `task-${crypto.randomUUID().slice(0, 8)}`;
    const baseBranch = params.baseBranch ?? "main";
    const branch = this.worktrees.getBranchNameForTask(id);

    // Initial insert with PENDING
    const task = this.db.insertTask({
      id,
      title: params.title,
      description: params.description,
      status: "PENDING",
      baseBranch,
      branch,
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    if (params.dependencies && params.dependencies.length > 0) {
      for (const parentId of params.dependencies) {
        this.graph.addDependency(parentId, id);
      }
    }

    // Check if task is already ready (no dependencies)
    this.graph.updateUnblockedTasks();
    this.db.logEvent(id, "task.submitted", { title: params.title, baseBranch });
    return this.db.getTask(id) ?? task;
  }

  public claimNextTask(workerId: string, pid = process.pid, options: { forceScan?: boolean } = {}): ClaimTaskResult | null {
    const now = Date.now();
    // Throttled watchdog scan to eliminate redundant scans on rapid claims
    if (options.forceScan || now - this.lastWatchdogScan >= this.watchdogThrottleMs) {
      this.watchdog.scanLeases();
      this.lastWatchdogScan = now;
    }

    // Ensure any unblocked ready tasks are updated
    this.graph.updateUnblockedTasks();
    const readyTasks = this.db.getReadyTasks();
    if (readyTasks.length === 0) return null;

    const task = readyTasks[0];
    if (!task) return null;

    // Transition to ASSIGNED
    this.db.updateTask(task.id, {
      status: "ASSIGNED",
      assignedWorkerId: workerId,
    });

    try {
      // 1. Create worktree
      const { path: worktreePath, branch } = this.worktrees.createWorktree(task.id, task.baseBranch);

      // 2. Bootstrap Waymark inside worktree
      this.waymark.initWorktree(worktreePath, "recording");
      const trajectoryId = this.waymark.beginTrajectory(worktreePath, task.description);

      // 3. Mark IN_PROGRESS
      const updated = this.db.updateTask(task.id, {
        status: "IN_PROGRESS",
        worktreePath,
        waymarkTrajectoryId: trajectoryId,
      });

      // 4. Set worker lease
      this.db.setWorkerLease({
        workerId,
        taskId: task.id,
        pid,
        heartbeatAt: new Date().toISOString(),
        status: "ACTIVE",
      });

      this.db.logEvent(task.id, "task.claimed", { workerId, pid, worktreePath, trajectoryId });

      return {
        task: updated,
        worktreePath,
        branch,
        waymarkTrajectoryId: trajectoryId,
      };
    } catch (error) {
      // Revert if worktree/waymark provisioning fails
      const err = error as Error;
      this.db.updateTask(task.id, {
        status: "READY",
        assignedWorkerId: null,
        errorMessage: `Failed during claim provisioning: ${err.message}`,
      });
      throw error;
    }
  }

  public checkpoint(taskId: string, workerId: string, message: string): void {
    const lease = this.db.getWorkerLease(taskId);
    if (!lease || lease.workerId !== workerId) {
      throw new Error(`Worker ${workerId} does not hold active lease for task ${taskId}`);
    }
    this.db.setWorkerLease({
      ...lease,
      heartbeatAt: new Date().toISOString(),
    });
    this.db.logEvent(taskId, "task.checkpoint", { workerId, message });
  }

  public completeTask(taskId: string, workerId: string, answer: string): TaskRecord {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const lease = this.db.getWorkerLease(taskId);
    if (!lease || lease.workerId !== workerId) {
      throw new Error(`Worker ${workerId} does not hold active lease for task ${taskId}`);
    }

    if (!task.worktreePath) {
      throw new Error(`Task ${taskId} missing worktree path`);
    }

    // 1. Finalize Waymark active trajectory
    if (task.waymarkTrajectoryId) {
      this.waymark.completeTrajectory(task.worktreePath, task.waymarkTrajectoryId, answer);
    }

    // 2. Commit worktree changes if any exist (with split-brain compensation)
    try {
      this.worktrees.commitAll(task.worktreePath, `feat(${task.id}): ${task.title}\n\n${answer}`);
    } catch (commitErr) {
      const err = commitErr as Error;
      this.db.logEvent(taskId, "task.commit_warning", {
        error: err.message,
        note: "Waymark trajectory sealed, but worktree commit threw an error or was empty.",
      });
    }

    // 3. Mark task completed
    const updated = this.db.updateTask(taskId, {
      status: "COMPLETED",
      resultAnswer: answer,
      completedAt: new Date().toISOString(),
    });

    // 4. Release worker lease
    this.db.releaseWorkerLease(workerId, taskId);

    // 5. Targeted in-degree update: unblock only direct child tasks
    this.graph.unblockChildrenOf(taskId);
    this.db.logEvent(taskId, "task.completed", { answer });

    return updated;
  }

  public failTask(taskId: string, workerId: string, errorMessage: string): TaskRecord {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const lease = this.db.getWorkerLease(taskId);
    if (lease) {
      this.db.releaseWorkerLease(workerId, taskId);
    }

    if (task.worktreePath && task.waymarkTrajectoryId) {
      try {
        this.waymark.abandonTrajectory(task.worktreePath, task.waymarkTrajectoryId, errorMessage);
      } catch {}
    }

    const updated = this.db.updateTask(taskId, {
      status: "FAILED",
      errorMessage,
    });

    this.db.logEvent(taskId, "task.failed", { errorMessage });
    return updated;
  }
}

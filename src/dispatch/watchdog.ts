import process from "node:process";
import { ArbiterDatabase } from "../db/database.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../waymark/waymarkSupervisor.js";

export interface ScanOptions {
  heartbeatTimeoutMs?: number;
  forceLockRecovery?: boolean;
}

export interface LeaseScanItem {
  taskId: string;
  workerId: string;
  pid: number;
  alive: boolean;
  heartbeatAgeMs: number;
  expired: boolean;
  reason?: string;
  lockRecovered?: boolean;
}

export interface ScanResult {
  scanned: number;
  expiredCount: number;
  recoveredTasks: string[];
  items: LeaseScanItem[];
}

export class LeaseWatchdog {
  constructor(
    private readonly db: ArbiterDatabase,
    private readonly worktrees: WorktreeManager,
    private readonly waymark: WaymarkSupervisor,
  ) {}

  public isPidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      // Sending signal 0 does not terminate the process; it tests whether it exists.
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "EPERM") {
        // Operation not permitted, but the process exists
        return true;
      }
      return false;
    }
  }

  public scanLeases(options: ScanOptions = {}): ScanResult {
    const timeoutMs = options.heartbeatTimeoutMs ?? 300_000; // default 5 minutes
    const forceLock = options.forceLockRecovery ?? true;

    const activeLeases = this.db.listActiveLeases();
    const now = Date.now();

    const recoveredTasks: string[] = [];
    const items: LeaseScanItem[] = [];

    for (const lease of activeLeases) {
      const heartbeatAgeMs = Math.max(0, now - new Date(lease.heartbeatAt).getTime());
      const alive = this.isPidAlive(lease.pid);
      const timedOut = heartbeatAgeMs > timeoutMs;

      if (!alive || timedOut) {
        const reason = !alive
          ? `Worker process PID ${lease.pid} is no longer running`
          : `Heartbeat timed out (${Math.round(heartbeatAgeMs / 1000)}s > ${Math.round(timeoutMs / 1000)}s)`;

        // 1. Expire lease in database
        this.db.expireWorkerLease(lease.workerId, lease.taskId);

        // 2. Inspect task state
        const task = this.db.getTask(lease.taskId);
        let lockRecovered = false;

        if (task && (task.status === "ASSIGNED" || task.status === "IN_PROGRESS")) {
          // 3. Reclaim Waymark lock if worktree exists
          if (task.worktreePath) {
            try {
              this.waymark.recoverLock(task.worktreePath, forceLock);
              lockRecovered = true;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.db.logEvent(task.id, "watchdog.lock_recovery_error", { error: msg });
            }
          }

          // 4. Return task to READY
          this.db.updateTask(task.id, {
            status: "READY",
            assignedWorkerId: null,
            errorMessage: `Recovered by watchdog: ${reason}`,
          });

          this.db.logEvent(task.id, "task.lease_expired", {
            workerId: lease.workerId,
            pid: lease.pid,
            reason,
            lockRecovered,
          });

          recoveredTasks.push(task.id);
        }

        items.push({
          taskId: lease.taskId,
          workerId: lease.workerId,
          pid: lease.pid,
          alive,
          heartbeatAgeMs,
          expired: true,
          reason,
          lockRecovered,
        });
      } else {
        items.push({
          taskId: lease.taskId,
          workerId: lease.workerId,
          pid: lease.pid,
          alive: true,
          heartbeatAgeMs,
          expired: false,
        });
      }
    }

    return {
      scanned: activeLeases.length,
      expiredCount: recoveredTasks.length,
      recoveredTasks,
      items,
    };
  }
}

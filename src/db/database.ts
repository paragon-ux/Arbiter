import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { TaskDependency, TaskEvent, TaskRecord, TaskStatus, WorkerLease } from "./types.js";
import { applyMigrations } from "./migrations.js";

export interface DatabaseMetrics {
  totalTasks: number;
  statusCounts: Record<string, number>;
  activeLeases: number;
  totalEvents: number;
  eventCounts: Record<string, number>;
}

export class ArbiterDatabase {
  public readonly db: DatabaseSync;
  private readonly statementCache = new Map<string, StatementSync>();

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    applyMigrations(this.db);
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.statementCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  public close(): void {
    this.statementCache.clear();
    this.db.close();
  }

  public insertTask(task: Omit<TaskRecord, "status" | "createdAt" | "updatedAt" | "completedAt"> & { status?: TaskStatus }): TaskRecord {
    const now = new Date().toISOString();
    const status = task.status ?? "PENDING";
    const stmt = this.prepare(`
      INSERT INTO tasks (
        id, title, description, status, base_branch, branch,
        worktree_path, assigned_worker_id, waymark_trajectory_id,
        result_answer, error_message, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id,
      task.title,
      task.description,
      status,
      task.baseBranch,
      task.branch,
      task.worktreePath,
      task.assignedWorkerId,
      task.waymarkTrajectoryId,
      task.resultAnswer,
      task.errorMessage,
      now,
      now,
      null,
    );
    return {
      ...task,
      status,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
  }

  public getTask(id: string): TaskRecord | null {
    const row = this.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTaskRow(row);
  }

  public listTasks(statusFilter?: TaskStatus): TaskRecord[] {
    const rows = statusFilter
      ? (this.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC").all(statusFilter) as Array<Record<string, unknown>>)
      : (this.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapTaskRow(r));
  }

  public updateTask(id: string, updates: Partial<TaskRecord>): TaskRecord {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task ${id} not found`);

    const updated: TaskRecord = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.prepare(`
      UPDATE tasks SET
        title = ?, description = ?, status = ?, base_branch = ?, branch = ?,
        worktree_path = ?, assigned_worker_id = ?, waymark_trajectory_id = ?,
        result_answer = ?, error_message = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description,
      updated.status,
      updated.baseBranch,
      updated.branch,
      updated.worktreePath,
      updated.assignedWorkerId,
      updated.waymarkTrajectoryId,
      updated.resultAnswer,
      updated.errorMessage,
      updated.updatedAt,
      updated.completedAt,
      id,
    );

    return updated;
  }

  public addDependency(parentTaskId: string, childTaskId: string): void {
    this.prepare(`
      INSERT OR IGNORE INTO task_dependencies (parent_task_id, child_task_id)
      VALUES (?, ?)
    `).run(parentTaskId, childTaskId);
  }

  public getParentTaskIds(childTaskId: string): string[] {
    const rows = this.prepare("SELECT parent_task_id FROM task_dependencies WHERE child_task_id = ?").all(childTaskId) as Array<{ parent_task_id: string }>;
    return rows.map((r) => r.parent_task_id);
  }

  public getChildTaskIds(parentTaskId: string): string[] {
    const rows = this.prepare("SELECT child_task_id FROM task_dependencies WHERE parent_task_id = ?").all(parentTaskId) as Array<{ child_task_id: string }>;
    return rows.map((r) => r.child_task_id);
  }

  public getAllDependencies(): Array<{ parent_task_id: string; child_task_id: string }> {
    return this.prepare("SELECT parent_task_id, child_task_id FROM task_dependencies").all() as Array<{ parent_task_id: string; child_task_id: string }>;
  }

  public getReadyTasks(): TaskRecord[] {
    // A task is READY if it is PENDING or READY, and all parent dependencies are COMPLETED
    const sql = `
      SELECT t.* FROM tasks t
      WHERE t.status IN ('PENDING', 'READY')
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks p ON d.parent_task_id = p.id
        WHERE d.child_task_id = t.id AND p.status != 'COMPLETED'
      )
      ORDER BY t.created_at ASC
    `;
    const rows = this.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTaskRow(r));
  }

  public claimReadyTask(workerId: string, pid: number): { task: TaskRecord; lease: WorkerLease } | null {
    // Atomically select, claim, and assign exactly one ready task under BEGIN IMMEDIATE transaction
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const selectSql = `
        SELECT t.* FROM tasks t
        WHERE t.status IN ('PENDING', 'READY')
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks p ON d.parent_task_id = p.id
          WHERE d.child_task_id = t.id AND p.status != 'COMPLETED'
        )
        ORDER BY t.created_at ASC
        LIMIT 1
      `;
      const row = this.prepare(selectSql).get() as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT;");
        return null;
      }

      const taskId = String(row.id);
      const now = new Date().toISOString();

      // Atomic CAS: ensure status has not transitioned since candidate selection
      const updateStmt = this.prepare(`
        UPDATE tasks SET
          status = 'ASSIGNED',
          assigned_worker_id = ?,
          updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'READY')
      `);
      const updateResult = updateStmt.run(workerId, now, taskId);

      // Check if another worker won the CAS race
      const changes = (updateResult as { changes?: number })?.changes ?? 1;
      if (changes === 0) {
        this.db.exec("COMMIT;");
        return null;
      }

      const epochRow = this.prepare(
        "SELECT COALESCE(MAX(lease_epoch), 0) + 1 AS next_epoch FROM worker_leases WHERE task_id = ?"
      ).get(taskId) as { next_epoch?: number } | undefined;
      const leaseEpoch = Number(epochRow?.next_epoch ?? 1);

      // Atomically register active worker lease (enforcing unique active lease index)
      this.prepare(`
        INSERT INTO worker_leases (worker_id, task_id, pid, heartbeat_at, status, lease_epoch)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?)
        ON CONFLICT(worker_id, task_id) DO UPDATE SET
          pid = excluded.pid,
          heartbeat_at = excluded.heartbeat_at,
          status = 'ACTIVE',
          lease_epoch = excluded.lease_epoch
      `).run(workerId, taskId, pid, now, leaseEpoch);

      this.db.exec("COMMIT;");

      const task = this.getTask(taskId)!;
      const lease: WorkerLease = {
        workerId,
        taskId,
        pid,
        heartbeatAt: now,
        status: "ACTIVE",
        leaseEpoch,
      };

      return { task, lease };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw err;
    }
  }


  public setWorkerLease(lease: WorkerLease): void {
    const epoch = lease.leaseEpoch ?? 1;
    this.prepare(`
      INSERT INTO worker_leases (worker_id, task_id, pid, heartbeat_at, status, lease_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id, task_id) DO UPDATE SET
        pid = excluded.pid,
        heartbeat_at = excluded.heartbeat_at,
        status = excluded.status,
        lease_epoch = excluded.lease_epoch
    `).run(lease.workerId, lease.taskId, lease.pid, lease.heartbeatAt, lease.status, epoch);
  }

  public getWorkerLease(taskId: string): WorkerLease | null {
    const row = this.prepare("SELECT * FROM worker_leases WHERE task_id = ? AND status = 'ACTIVE'").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      workerId: String(row.worker_id),
      taskId: String(row.task_id),
      pid: Number(row.pid),
      heartbeatAt: String(row.heartbeat_at),
      status: row.status as "ACTIVE" | "EXPIRED" | "RELEASED",
      leaseEpoch: Number(row.lease_epoch ?? 1),
    };
  }

  public releaseWorkerLease(workerId: string, taskId: string): void {
    this.prepare("UPDATE worker_leases SET status = 'RELEASED' WHERE worker_id = ? AND task_id = ?").run(workerId, taskId);
  }

  public listActiveLeases(): WorkerLease[] {
    const rows = this.prepare("SELECT * FROM worker_leases WHERE status = 'ACTIVE' ORDER BY heartbeat_at ASC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      workerId: String(row.worker_id),
      taskId: String(row.task_id),
      pid: Number(row.pid),
      heartbeatAt: String(row.heartbeat_at),
      status: row.status as "ACTIVE" | "EXPIRED" | "RELEASED",
      leaseEpoch: Number(row.lease_epoch ?? 1),
    }));
  }

  public expireWorkerLease(workerId: string, taskId: string): void {
    this.prepare("UPDATE worker_leases SET status = 'EXPIRED' WHERE worker_id = ? AND task_id = ?").run(workerId, taskId);
  }

  public logEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    this.prepare(`
      INSERT INTO task_events (task_id, type, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, type, JSON.stringify(payload), new Date().toISOString());
  }

  public getEvents(taskId: string): TaskEvent[] {
    const rows = this.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      type: String(r.type),
      payload: String(r.payload),
      createdAt: String(r.created_at),
    }));
  }

  public getMetrics(): DatabaseMetrics {
    const taskRows = this.prepare("SELECT status, count(*) as cnt FROM tasks GROUP BY status").all() as Array<{ status: string; cnt: number }>;
    const statusCounts: Record<string, number> = {};
    let totalTasks = 0;
    for (const r of taskRows) {
      statusCounts[r.status] = Number(r.cnt);
      totalTasks += Number(r.cnt);
    }

    const leaseRow = this.prepare("SELECT count(*) as cnt FROM worker_leases WHERE status = 'ACTIVE'").get() as { cnt: number } | undefined;
    const activeLeases = Number(leaseRow?.cnt ?? 0);

    const eventRows = this.prepare("SELECT type, count(*) as cnt FROM task_events GROUP BY type").all() as Array<{ type: string; cnt: number }>;
    const eventCounts: Record<string, number> = {};
    let totalEvents = 0;
    for (const r of eventRows) {
      eventCounts[r.type] = Number(r.cnt);
      totalEvents += Number(r.cnt);
    }

    return {
      totalTasks,
      statusCounts,
      activeLeases,
      totalEvents,
      eventCounts,
    };
  }

  private mapTaskRow(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      status: row.status as TaskStatus,
      baseBranch: String(row.base_branch),
      branch: String(row.branch),
      worktreePath: row.worktree_path ? String(row.worktree_path) : null,
      assignedWorkerId: row.assigned_worker_id ? String(row.assigned_worker_id) : null,
      waymarkTrajectoryId: row.waymark_trajectory_id ? String(row.waymark_trajectory_id) : null,
      resultAnswer: row.result_answer ? String(row.result_answer) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }
}

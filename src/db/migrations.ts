import { DatabaseSync } from "node:sqlite";

export const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CONFLICT')),
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT,
  assigned_worker_id TEXT,
  waymark_trajectory_id TEXT,
  result_answer TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  parent_task_id TEXT NOT NULL,
  child_task_id TEXT NOT NULL,
  PRIMARY KEY (parent_task_id, child_task_id),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS worker_leases (
  worker_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  heartbeat_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'EXPIRED', 'RELEASED')),
  PRIMARY KEY (worker_id, task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_deps_child ON task_dependencies(child_task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_parent ON task_dependencies(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_worker_leases_task ON worker_leases(task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
`;

export const MIGRATION_V2 = `
-- Enforce single active lease per task across entire database (P1 #4)
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_task_lease ON worker_leases(task_id) WHERE status = 'ACTIVE';

-- Index claimable tasks for sub-millisecond atomic CAS dispatch
CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(status, created_at) WHERE status IN ('PENDING', 'READY');
`;

export const MIGRATION_V3 = `
-- Monotonic lease_epoch for ABA protection and worker fencing (Part 2.5)
ALTER TABLE worker_leases ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1;
`;

export function applyMigrations(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current = db.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get() as { max_v: number | null };
  const currentVersion = current?.max_v ?? 0;

  if (currentVersion < 1) {
    db.exec(MIGRATION_V1);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
  }

  if (currentVersion < 2) {
    db.exec(MIGRATION_V2);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
  }

  if (currentVersion < 3) {
    db.exec(MIGRATION_V3);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, new Date().toISOString());
  }
}


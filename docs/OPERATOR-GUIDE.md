# Arbiter — Multi-Agent Cluster Operator Guide

This guide describes operational workflows, configuration options, lease monitoring, and merge conflict resolution for operators managing multi-agent clusters with Arbiter.

---

## 1. Installation & Environment Configuration

### System Prerequisites
- **Node.js**: $\ge 22.0.0$ (required for native `node:sqlite`)
- **Git**: $\ge 2.20.0$ (supporting `git worktree`)
- **Runtime Dependencies**: **0** (pure Node built-ins)

### Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `WAYMARK_CLI_PATH` | (auto-detected) | Explicit path to the standalone `waymark` CLI binary or JS bundle. |
| `WAYMARK_CLI_TIMEOUT_MS` | `30000` (30s) | Subprocess execution timeout for Waymark commands. |
| `WAYMARK_DISABLED` | `false` | Force Graceful Fallback Mode (useful in minimal CI runners). |

---

## 2. Cluster Health & Observability

### Inspecting System Status
To view queue size, ready tasks, and active worktrees:
```bash
arbiter status
```

To inspect cluster-wide health metrics (including task status breakdown and event counters):
```bash
arbiter metrics
```

Example metrics output:
```json
{
  "ok": true,
  "metrics": {
    "totalTasks": 12,
    "statusCounts": {
      "READY": 2,
      "IN_PROGRESS": 3,
      "COMPLETED": 7
    },
    "activeLeases": 3,
    "totalEvents": 48,
    "eventCounts": {
      "task.submitted": 12,
      "task.claimed": 8,
      "task.checkpoint": 21,
      "task.completed": 7
    },
    "activeWorktrees": 3
  }
}
```

---

## 3. Worker Lease & Watchdog Management

Arbiter automatically monitors worker health on each task dispatch. To trigger a manual watchdog scan across all active leases:

```bash
# Default scan with 5-minute heartbeat timeout and automatic lock reclamation:
arbiter watchdog

# Custom heartbeat timeout (e.g. 120 seconds):
arbiter watchdog --timeout 120

# Dry-run inspection without forcing lock recovery:
arbiter watchdog --no-force
```

If a worker process terminates without calling `arbiter_complete_task` or `arbiter_fail_task`, the watchdog automatically:
1. Reclaims the worker lease.
2. Recovers orphaned Waymark locks in `.arbiter/worktrees/task-<id>`.
3. Resets the task to `READY` status with a diagnostic error log for re-assignment.

---

## 4. Conflict Quarantine & Reconciliation Playbook

When a task finishes, its branch is queued for sequential merge into `main`. If another agent has committed overlapping changes that cannot be fast-forwarded:
1. Arbiter synchronously aborts the merge (`git merge --abort`).
2. The `main` branch remains untouched and pristine.
3. The task transitions to `CONFLICT`.

### Resolution Option A: Autonomous Agent Reconciliation (Recommended)
Submit a child reconciliation task that depends on the conflicted task:
```bash
arbiter submit \
  --title "Reconcile task-104 conflict" \
  --description "Merge main into branch arbiter/task-104 and resolve merge conflicts" \
  --deps "task-104"
```
A fresh agent will claim the task, checkout the branch, resolve conflicts, verify tests, and merge cleanly.

### Resolution Option B: Manual Operator Resolution
1. Navigate to the quarantined worktree:
   ```bash
   cd .arbiter/worktrees/task-104
   ```
2. Fetch and merge `main`:
   ```bash
   git merge main
   ```
3. Resolve conflict markers in your editor, run test suite, and commit:
   ```bash
   git add .
   git commit -m "fix(task-104): resolve conflicts with main"
   ```
4. Trigger the sequential merge queue:
   ```bash
   arbiter merge task-104
   ```
5. Prune completed worktrees:
   ```bash
   arbiter prune
   ```

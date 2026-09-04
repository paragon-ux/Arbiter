# Waymark Continuity Lifecycle in Arbiter

This document specifies the integration mechanics, state machine transitions, and fail-closed safety properties governing Waymark trajectories inside Arbiter.

---

## 1. Core Principles

Arbiter coordinates multi-agent task execution by providing **ephemeral Git worktree isolation** combined with **in-flight trajectory continuity via Waymark**:

1. **Strict 1:1:1 Invariant**: Every claimed Arbiter task maps to exactly one ephemeral Git worktree (`.arbiter/worktrees/task-<id>`) and exactly one Waymark trajectory (`.waymark/`).
2. **Pre-Merge Immutability**: A Waymark trajectory is always sealed to `COMMITTED` status *before* any Git merge is attempted.
3. **Fail-Closed Conflict Quarantine**: If a merge conflict arises during sequential queue processing, the worktree is preserved in quarantine, and the trajectory remains frozen in its `COMMITTED` state as a forensic record.

---

## 2. Trajectory State Machine

```
   [Task Claimed] 
          │
          ▼
   STAGED (Active)
   ├── Agents record verified hops via waymark_note
   ├── Context compaction recovery via waymark_resume
   └── Heartbeat refreshed via arbiter_checkpoint
          │
          ├── Task Completed ───────────────────► COMMITTED (Immutable)
          │                                           │
          │                                           ├── Merge Clean ──► Worktree Pruned
          │                                           └── Merge Conflict ► Worktree Quarantined
          │
          └── Task Failed / Timed Out ──────────► ABANDONED
```

### State Definitions

| State | Description | Invariants & Mutability |
| :--- | :--- | :--- |
| **`STAGED`** | Trajectory is actively recording. Staged immediately upon `arbiter_claim_task`. | Hops can be appended via `waymark_note`. Worktree lock held by active worker PID. |
| **`COMMITTED`** | Trajectory is permanently sealed upon `arbiter_complete_task`. | **Immutable.** No further notes can be added (`TRAJECTORY_NOT_STAGED`). Ready for merge queue. |
| **`ABANDONED`** | Trajectory was cancelled or failed via `arbiter_fail_task` or watchdog timeout. | Permanently closed. Worktree subject to operator inspection or cleanup. |

---

## 3. The Pre-Merge Sealing Guarantee

In Arbiter, merges to `main` are never attempted while a trajectory is open or mutable:

1. When a worker invokes `arbiter_complete_task`:
   - Step 1: Waymark CLI runs `waymark complete <trajectory-id> "<answer>"`. The trajectory status in `.waymark/` transitions from `STAGED` to `COMMITTED`.
   - Step 2: Arbiter commits all modified files in the worktree: `git commit -am "feat(task-<id>): <title>"`.
   - Step 3: The task status in SQLite transitions to `COMPLETED`, releasing the worker lease.
2. If the merge queue encounters a conflict when merging into `main`:
   - Arbiter immediately runs `git merge --abort`. The `main` branch remains pristine.
   - The task transitions to `CONFLICT`.
   - The sealed Waymark trajectory inside `.arbiter/worktrees/task-<id>/.waymark/` remains completely intact and uncorrupted.

---

## 4. Crash Recovery & Lock Reclamation

If an agent process crashes while holding a worktree lock:
1. **Liveness Detection**: Arbiter's `LeaseWatchdog` sends a non-destructive OS signal (`process.kill(pid, 0)`) to determine if the worker PID is alive.
2. **Heartbeat Timeout**: If the process is alive but has failed to checkpoint within `heartbeatTimeoutMs` (default: 300s), the lease is expired.
3. **Lock Recovery**: Arbiter invokes `waymark recover-lock --force` inside the task's worktree to remove the stale lock file and resets the task to `READY` for automatic re-dispatch.

---

## 5. Graceful Fallback Mode

When Arbiter runs in environments where the standalone Waymark binary is not installed (e.g. lightweight CI runners or headless Docker containers):
- `WaymarkSupervisor` automatically detects the absence of the executable and switches to **Graceful Fallback Mode**.
- In fallback mode, Arbiter creates local trajectory metadata stubs under `.waymark/trajectory.json`, tracks hops and completion status, and guarantees 100% test and workflow pass rates without external dependencies.

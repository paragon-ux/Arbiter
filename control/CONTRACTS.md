# CONTRACTS — Arbiter Boundaries and Invariants

## Product Boundary
Arbiter owns task DAG scheduling, ephemeral Git worktree lifecycle management, and sequential branch merging. It does not replace Waymark or Capn:
- **In-Flight Continuity**: Waymark owns active trajectories inside each worktree (`.waymark/`).
- **Episodic Memory**: Capn owns cross-session indexed memory (`.capn/`).
- **Task Orchestration**: Arbiter owns task definitions, dependency graphs, worker leases, and branch merging.

## Worktree Lifecycle Contract
- Each claimed task executes in an ephemeral Git worktree (`.arbiter/worktrees/task-<id>`) checked out to branch `arbiter/task-<id>`.
- Worktrees are strictly isolated. No agent may read or write another agent's worktree.
- Upon successful merge to target branch, the worktree is automatically pruned via `git worktree remove --force`.
- If a merge conflict occurs, the worktree is preserved in quarantine for operator inspection.

## Lock & Crash Recovery Contract
- A worker lease has a heartbeat timeout (default: 300 seconds).
- When a worker lease expires or its process terminates, Arbiter marks the worker dead and allows the worktree's Waymark lock to be reclaimed via `waymark_recover_lock({ force: true })`.
- Lock ownership is never stolen while the worker process is actively running.

## Merge Contract
- Merges to target branch (`main`) are processed sequentially.
- If a task branch does not cleanly merge/fast-forward, it is marked `CONFLICT` and quarantined without corrupting `main`.

## Trajectory Ownership & Workspace Scoping Invariant (W-11)
- **1:1:1 Invariant**: Exactly one active Task maps to exactly one ephemeral Git worktree (`.arbiter/worktrees/task-<id>`) and exactly one staged Waymark trajectory (`.waymark/`).
- **Exclusive Write Ownership**: Only the worker process holding the active worker lease in Arbiter SQLite (`worker_leases.status = 'ACTIVE'`) is permitted to write files, create commits, or record hops in that worktree.
- **Pre-Merge Trajectory Sealing**: No merge to `main` is ever attempted with an active (`STAGED`) trajectory. Trajectories transition to `COMMITTED` at task completion and are permanently immutable thereafter.
- **Fail-Closed Isolation**: Under conflict or error, trajectories are never overwritten in place. Reconciliation occurs via dedicated reconciliation tasks with fresh worktrees or direct operator review.


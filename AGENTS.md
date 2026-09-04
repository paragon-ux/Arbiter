# Arbiter — Multi-Agent Task Orchestration Engine

Arbiter is a local-first multi-agent task orchestration engine and worktree supervisor. It coordinates parallel coding agents across isolated Git worktrees with Waymark continuity and Capn memory integration.

## Agent Workflow & MCP Protocol

Agents interacting with Arbiter use native MCP tools:

### 1. Claim a Task (`arbiter_claim_task`)
- Call `arbiter_claim_task({ worker_id: "<id>" })`.
- Arbiter assigns the next `READY` task from the DAG, provisions an isolated Git worktree at `.arbiter/worktrees/task-<id>`, bootstraps Waymark, and returns:
  - `task_id`: The assigned task identifier.
  - `worktree_path`: The isolated worktree path where the agent MUST perform all file edits and test runs.
  - `branch`: Dedicated branch name (`arbiter/task-<id>`).
  - `trajectory_id`: Active Waymark trajectory already staged for this task.

### 2. Work in the Isolated Worktree with Waymark
- Navigate into the assigned `worktree_path`.
- **Worktree Isolation**: All file creation, edits, and test runs MUST occur strictly within `worktree_path`. Never modify files in the root checkout or other worktrees.
- Record verified code hops as you explore and modify code using `waymark_note`.
- Report progress checkpoints periodically via `arbiter_checkpoint({ task_id, worker_id, message })`. This refreshes your lease heartbeat in Arbiter and returns live Waymark trajectory telemetry (`waymark_status`, `waymark_trajectory_id`, `waymark_total_hops`).

### 3. Context Compaction & Crash Recovery Protocol (W-04 & W-10)
If your context window compacts or your process is restarted mid-task:
1. **Discover In-Progress Task**: Call `arbiter_status({})`. Look for tasks where `assigned_worker_id` matches your worker identifier and `status === "IN_PROGRESS"`.
2. **Re-establish Trajectory Continuity**:
   - Change directory into `task.worktree_path`.
   - Call `waymark_resume({ trajectory_id: task.waymark_trajectory_id, detail_level: "compact" })` (or execute `waymark status --porcelain`).
   - Read the serialized trajectory summary to recover the original question, completed hops, and active focus without re-reading the entire repository.
3. **Refresh Lease & Heartbeat**: Call `arbiter_checkpoint({ task_id: task.id, worker_id: "<id>", message: "Resumed after compaction" })`. This resets the watchdog lease timer and confirms lock acquisition.
4. **Lock Reclamation**: If a prior agent crashed or left an orphaned lock file (`.waymark/lock`), invoke `arbiter_recover_lock({ task_id: task.id, force: true })`.

### 4. Complete Task & Seal Waymark (`arbiter_complete_task`)
- When code and tests are verified, call `arbiter_complete_task({ task_id: "<id>", worker_id: "<id>", answer: "<synthesis>" })`.
- Arbiter seals the active Waymark trajectory (transitioning to immutable `COMMITTED`), commits the worktree changes, queues the branch for sequential merge into `main`, and unblocks downstream DAG tasks.

### 5. Cluster Telemetry & Observability (`arbiter_metrics`)
- Call `arbiter_metrics({})` to inspect cluster-wide state, task distributions, active leases, and recorded event counters.

---

## Operator CLI
Operators can submit tasks, view status, inspect metrics, and manage the merge queue:
`arbiter submit --title "<title>" --description "<desc>" [--deps "<task1,task2>"]`
`arbiter status [<task-id>]`
`arbiter metrics`
`arbiter merge [<task-id>]`
`arbiter watchdog [--timeout <sec>]`
`arbiter prune`


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
- Record verified code hops as you explore and modify code using `waymark_note`.
- If compaction occurs, recover context using `waymark_resume`.
- Optionally report progress checkpoints via `arbiter_checkpoint({ task_id, message })`.

### 3. Complete Task & Seal Waymark (`arbiter_complete_task`)
- When code and tests are verified, call `arbiter_complete_task({ task_id: "<id>", answer: "<synthesis>" })`.
- Arbiter seals the active Waymark trajectory, publishes findings to Capn, commits the worktree changes, queues the branch for sequential merge into `main`, and unblocks any downstream tasks.

### 4. Lock & Crash Recovery (`arbiter_recover_lock`)
- If a prior agent or container crashed holding a lock on a worktree, call `arbiter_recover_lock({ task_id, force: true })` to safely reclaim it.

---

## Operator CLI
Operators can submit tasks, view status, and manage the merge queue:
`arbiter submit --title "<title>" --description "<desc>" [--deps "<task1,task2>"]`
`arbiter status`
`arbiter merge`

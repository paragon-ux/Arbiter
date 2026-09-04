# Arbiter — Multi-Agent Task Orchestration Engine

Arbiter is a local-first, zero-daemon multi-agent orchestration engine and ephemeral Git worktree supervisor. It coordinates parallel AI coding agents across isolated Git worktrees with in-flight continuity powered by **Waymark** and episodic memory integration powered by **Capn**.

---

## Architectural Principles

1. **Zero-Daemon Overhead**:
   Arbiter uses Node.js 22 built-in native SQLite (`node:sqlite`) for ACID state, dependency graphs, and worker leases. There are no background server ports, daemon daemons, or long-running database containers.
2. **Ephemeral Worktree Isolation**:
   Every task runs in an isolated Git worktree under `.arbiter/worktrees/task-<id>` checked out to dedicated branch `arbiter/task-<id>`. Parallel agents never touch the main working copy directly and never experience cross-agent file pollution.
3. **In-Flight Continuity via Waymark**:
   When an agent claims a task, Arbiter automatically bootstraps Waymark inside the task worktree. Every file hop and code discovery can be recorded with `waymark_note`, surviving context compaction. Trajectories are sealed prior to merging.
4. **Autonomous Crash & Lock Recovery**:
   Arbiter's synchronous lease watchdog inspects worker PID liveness (`process.kill(pid, 0)`). If an agent crashes or abandons a task, Arbiter reclaims the orphaned Waymark lock via `waymark_recover_lock({ force: true })` and resets the task to `READY`.
5. **Sequential Merge Queue with Quarantine**:
   Completed tasks are sequentially merged to `main`. If merge conflicts arise, Arbiter cleanly rolls back (`git merge --abort`), isolates the task in `CONFLICT` quarantine, and preserves the worktree for inspection.

---

## Dual Interface

### Agent MCP Server (`arbiter-mcp`)
Agents interact with Arbiter over stdio using standard JSON-RPC 2.0 MCP tools:
- `arbiter_submit_task`: Submit DAG tasks with dependencies.
- `arbiter_claim_task`: Claim next ready task and provision worktree.
- `arbiter_checkpoint`: Record progress and refresh lease heartbeat.
- `arbiter_complete_task`: Finalize work, seal Waymark, and commit.
- `arbiter_fail_task`: Abandon trajectory and report error.
- `arbiter_recover_lock`: Reclaim orphaned lock.
- `arbiter_status`: Query queue or inspect specific task.
- `arbiter_process_merge_queue`: Sequentially merge completed tasks.
- `arbiter_scan_leases`: Scan leases for dead PIDs or timeouts.
- `arbiter_prune_worktrees`: Clean up completed worktrees.

### Operator CLI (`arbiter`)
Human operators and automation scripts can run:
```bash
arbiter submit --title "<title>" [--description "<desc>"] [--deps "<task1,task2>"]
arbiter claim [--worker <id>]
arbiter checkpoint --task <id> --worker <id> --message "<msg>"
arbiter complete --task <id> --worker <id> --answer "<answer>"
arbiter status [<task-id>]
arbiter merge [<task-id>] [--target <branch>]
arbiter watchdog [--timeout <sec>]
arbiter prune
```

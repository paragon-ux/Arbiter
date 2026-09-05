# Arbiter — Architectural Rationale & Continuity Design

This document details the engineering principles, architectural trade-offs, and formal state guarantees underpinning Arbiter's local-first multi-agent task orchestrator and worktree supervisor.

---

## 1. The Multi-Agent Arbitration Problem

Autonomous coding agents executing in a shared software repository encounter fundamental coordination hazards:

1. **Working Tree Race Conditions**: When two or more agents edit the same working tree simultaneously, file writes clobber in-progress modifications. Language servers and linters report spurious errors, causing agents to attempt unprompted "repairs" of each other's code.
2. **Context Compaction Amnesia**: Agent LLMs operate within sliding context windows. When an agent experiences context compaction mid-task, it loses the narrative trail of why specific lines were touched. Without an immutable in-flight journal, it falls back to full-codebase re-indexing.
3. **Deadlock from Process Crashes**: External agents or IDE sidecars can terminate unexpectedly due to memory pressure, network disconnects, or IDE reloads. If lock records lack active process liveness validation, tasks remain frozen in progress indefinitely.
4. **Merge Pollution on Main**: Simultaneous parallel merges directly to `main` produce dirty merge conflicts, half-applied patches, and broken integration builds.

---

## 2. Arbiter's Core Architecture

Arbiter resolves these challenges through a strict layered architecture built on **zero runtime npm dependencies** (powered purely by Node.js 22 built-ins: `node:sqlite`, `node:child_process`, `node:fs`, `node:crypto`):

```
┌─────────────────────────────────────────────────────────────┐
│                      Operator & Agents                      │
│             MCP Tools (JSON-RPC)  |  Operator CLI           │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    Arbiter Orchestrator                     │
│  ┌──────────────────────┐  ┌─────────────────────────────┐  │
│  │ Task DAG & Scheduler │  │ Lease Watchdog (Alive PIDs) │  │
│  └──────────┬───────────┘  └──────────────┬──────────────┘  │
│             │                             │                 │
│  ┌──────────▼───────────┐  ┌──────────────▼──────────────┐  │
│  │ SQLite WAL Store     │  │ Sequential Merge Queue      │  │
│  └──────────────────────┘  └──────────────┬──────────────┘  │
└───────────────────────────────────────────┼─────────────────┘
                                            │
┌───────────────────────────────────────────▼─────────────────┐
│                    Isolated File System                     │
│  .arbiter/worktrees/task-1/      .arbiter/worktrees/task-2/ │
│  ├── Local Worktree Checkout     ├── Local Worktree Checkout│
│  └── .waymark/ Trajectory        └── .waymark/ Trajectory   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Waymark Trajectory Conflict Handling & Quarantine Pipeline

A cornerstone guarantee of Arbiter is that **Git merge conflicts never destroy, corrupt, or truncate in-flight Waymark continuity data**. Trajectories are permanently sealed before any merge attempt. If a conflict occurs, `git merge --abort` executes synchronously to protect `main`, and the worktree is preserved in quarantine for forensic analysis and reconciliation.

The complete state machine and rollback pipeline is illustrated below:

<p align="center">
  <img src="docs/assets/conflict-quarantine-flowchart.svg" alt="Arbiter Trajectory Lifecycle & Conflict Quarantine Pipeline" width="100%" />
</p>

---

## 4. Why Ephemeral Worktrees & Waymark?

| Alternative Approach | Failure Mode | Arbiter Solution |
| :--- | :--- | :--- |
| **Shared Working Copy** | Multi-agent file stomping; linters flag partial edits across unrelated agents. | Ephemeral Git worktree per task (`.arbiter/worktrees/task-<id>`). Complete filesystem isolation. |
| **Branch Switching in Shared Dir** | Git checkout fails if uncommitted changes exist; high disk I/O churn. | Native `git worktree add -b`; directory pointers remain stable and isolated. |
| **Raw Git Branches Only** | Agent loses internal reasoning and verified hops on context compaction. | Automatic Waymark trajectory staging. Verified hops persist in append-only journal. |
| **Optimistic Parallel Merges** | Conflict markers land on `main`; breaks continuous integration build. | Strict sequential merge queue; clean fast-forward or instant synchronous rollback. |

---

## 5. Performance Engineering

Arbiter achieves microsecond-level orchestration latency:
- **Prepared Statement Caching**: Prepared SQL statements are compiled once and retained in an in-memory statement cache (`Map<string, StatementSync>`), avoiding repeated VDBE bytecode compilation.
- **Batch Dependency Loading**: Topological sort queries all dependencies once (`SELECT parent_task_id, child_task_id FROM task_dependencies`), computing in-degrees and Kahn's algorithm in $O(V + E)$ in memory.
- **Targeted In-Degree Updates**: On task completion, Arbiter evaluates only direct downstream child tasks rather than executing full database table scans.
- **Microsecond PID Liveness**: Worker process health is inspected using non-destructive OS signaling (`process.kill(pid, 0)`), completing in under 1 microsecond without background daemon overhead.

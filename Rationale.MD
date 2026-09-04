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

<div align="center">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 720" width="100%" height="100%" style="max-width: 880px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
  <defs>
    <linearGradient id="gradPrimary" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
    <linearGradient id="gradAccent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0284c7" />
      <stop offset="100%" stop-color="#0369a1" />
    </linearGradient>
    <linearGradient id="gradWarning" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#b45309" />
      <stop offset="100%" stop-color="#78350f" />
    </linearGradient>
    <linearGradient id="gradSuccess" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#15803d" />
      <stop offset="100%" stop-color="#14532d" />
    </linearGradient>
    <linearGradient id="gradDanger" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#be123c" />
      <stop offset="100%" stop-color="#881337" />
    </linearGradient>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
    </marker>
    <marker id="arrowSuccess" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#22c55e" />
    </marker>
    <marker id="arrowDanger" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#ef4444" />
    </marker>
  </defs>

  <!-- Background Canvas -->
  <rect width="880" height="720" rx="16" fill="#0b0f19" stroke="#1e293b" stroke-width="2"/>

  <!-- Stage 1: Claim Task -->
  <rect x="300" y="30" width="280" height="60" rx="10" fill="url(#gradPrimary)" stroke="#38bdf8" stroke-width="1.5" />
  <text x="440" y="55" fill="#f8fafc" font-size="14" font-weight="600" text-anchor="middle">1. Task Claimed &amp; Provisioned</text>
  <text x="440" y="75" fill="#94a3b8" font-size="11" text-anchor="middle">Worktree checked out | Waymark STAGED</text>

  <!-- Arrow 1 to 2 -->
  <path d="M 440 90 L 440 125" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)" fill="none"/>

  <!-- Stage 2: In-Progress Worker -->
  <rect x="300" y="130" width="280" height="60" rx="10" fill="url(#gradPrimary)" stroke="#38bdf8" stroke-width="1.5" />
  <text x="440" y="155" fill="#f8fafc" font-size="14" font-weight="600" text-anchor="middle">2. Agent Exploration &amp; Edits</text>
  <text x="440" y="175" fill="#94a3b8" font-size="11" text-anchor="middle">Records verified hops via waymark_note</text>

  <!-- Arrow 2 to 3 -->
  <path d="M 440 190 L 440 225" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)" fill="none"/>

  <!-- Stage 3: Complete Task -->
  <rect x="300" y="230" width="280" height="60" rx="10" fill="url(#gradAccent)" stroke="#0ea5e9" stroke-width="1.5" />
  <text x="440" y="255" fill="#ffffff" font-size="14" font-weight="600" text-anchor="middle">3. Trajectory Sealing</text>
  <text x="440" y="275" fill="#e0f2fe" font-size="11" text-anchor="middle">waymark complete → COMMITTED (Immutable)</text>

  <!-- Arrow 3 to 4 -->
  <path d="M 440 290 L 440 325" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)" fill="none"/>

  <!-- Stage 4: Merge Decision Diamond -->
  <polygon points="440,330 560,375 440,420 320,375" fill="url(#gradPrimary)" stroke="#94a3b8" stroke-width="1.5" />
  <text x="440" y="370" fill="#f8fafc" font-size="13" font-weight="600" text-anchor="middle">Sequential Merge Queue</text>
  <text x="440" y="388" fill="#94a3b8" font-size="10" text-anchor="middle">git merge --no-ff</text>

  <!-- Path Clean Merge (Left to Success) -->
  <path d="M 320 375 L 170 375 L 170 470" stroke="#22c55e" stroke-width="2" marker-end="url(#arrowSuccess)" fill="none"/>
  <text x="235" y="365" fill="#4ade80" font-size="11" font-weight="600" text-anchor="middle">Clean Merge</text>

  <!-- Success Block -->
  <rect x="60" y="475" width="220" height="70" rx="10" fill="url(#gradSuccess)" stroke="#4ade80" stroke-width="1.5" />
  <text x="170" y="502" fill="#ffffff" font-size="13" font-weight="600" text-anchor="middle">Integrated to main</text>
  <text x="170" y="522" fill="#dcfce7" font-size="10" text-anchor="middle">Fast-forward commit updated</text>
  <text x="170" y="536" fill="#dcfce7" font-size="10" text-anchor="middle">Worktree &amp; branch pruned</text>

  <!-- Path Conflict (Right to Abort & Quarantine) -->
  <path d="M 560 375 L 710 375 L 710 425" stroke="#ef4444" stroke-width="2" marker-end="url(#arrowDanger)" fill="none"/>
  <text x="645" y="365" fill="#f87171" font-size="11" font-weight="600" text-anchor="middle">Conflict Detected</text>

  <!-- Immediate Rollback Box -->
  <rect x="600" y="430" width="220" height="60" rx="10" fill="url(#gradDanger)" stroke="#f43f5e" stroke-width="1.5" />
  <text x="710" y="455" fill="#ffffff" font-size="13" font-weight="600" text-anchor="middle">Instant Rollback</text>
  <text x="710" y="475" fill="#ffe4e6" font-size="10" text-anchor="middle">git merge --abort (main untouched)</text>

  <!-- Arrow Rollback to Quarantine -->
  <path d="M 710 490 L 710 525" stroke="#ef4444" stroke-width="2" marker-end="url(#arrowDanger)" fill="none"/>

  <!-- Quarantine Block -->
  <rect x="600" y="530" width="220" height="70" rx="10" fill="url(#gradWarning)" stroke="#f59e0b" stroke-width="1.5" />
  <text x="710" y="555" fill="#ffffff" font-size="13" font-weight="600" text-anchor="middle">Worktree Quarantine</text>
  <text x="710" y="575" fill="#fef3c7" font-size="10" text-anchor="middle">Status → CONFLICT | Tree Preserved</text>
  <text x="710" y="590" fill="#fef3c7" font-size="10" text-anchor="middle">Waymark Frozen as COMMITTED</text>

  <!-- Reconciliation paths -->
  <path d="M 710 600 L 710 630 L 440 630 L 440 655" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)" fill="none"/>

  <!-- Reconciliation Options Box -->
  <rect x="260" y="660" width="360" height="45" rx="8" fill="#1e293b" stroke="#475569" stroke-width="1" />
  <text x="440" y="680" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle">Reconciliation Paths</text>
  <text x="440" y="696" fill="#94a3b8" font-size="10" text-anchor="middle">A: Automated Agent Reconciliation Task  |  B: Manual Operator Resolution</text>
</svg>
</div>

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

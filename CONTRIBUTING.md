# Contributing to Arbiter

Arbiter is a lightweight, local-first multi-agent orchestration engine and ephemeral Git worktree supervisor. It is intentionally designed with zero runtime npm dependencies, utilizing Node.js 22 built-in SQLite (`node:sqlite`) and standard stdio MCP.

## Development Prerequisites

- Node.js $\ge 22.0.0$
- Git $\ge 2.20.0$

```bash
npm install
npm run verify
```

`npm run verify` runs TypeScript compilation, executes the entire test suite (including worktree isolation, DAG cycle detection, and merge quarantine tests), performs the public hygiene security scan, and validates benchmark latency.

## Architecture & Contribution Invariants

1. **Zero Runtime Dependencies**: Arbiter relies strictly on Node 22 built-in modules (`node:sqlite`, `node:child_process`, `node:fs`, `node:crypto`, `node:process`). Do not introduce runtime npm dependencies.
2. **Ephemeral Worktree Isolation**: All agent file edits and test executions must happen inside isolated worktrees (`.arbiter/worktrees/task-<id>`). Never mutate the primary working tree during task execution.
3. **Fail-Closed Merge Invariant**: Merges to `main` are strictly sequential. In the event of a merge collision, `git merge --abort` must execute synchronously, ensuring `main` remains pristine.
4. **Waymark Continuity Discipline**: Trajectories must be sealed via `waymark complete` before worktree commits are staged or queued for merge.
5. **No Secrets or PII**: Do not commit personal machine paths, credentials, API keys, or raw database snapshots.

## Submitting Changes

- Work in a focused Git branch.
- Ensure all tests pass across platforms: `npm run verify`.
- Open a pull request against `main` with a clear explanation of behavioral changes.

# Arbiter Subsystem Feature Status Matrix

**Document Version:** 2.0.0-PROD  
**Canonical Scope:** `Arbiter` Subsystem Implementation Inventory

| Subsystem | Component / Module | Implementation Status | Implementation Notes |
| :--- | :--- | :--- | :--- |
| **Git Worktree Isolation** | `src/worktrees/worktreeManager.ts` | **SHIPPED** | Provisions `.arbiter/worktrees/task-<id>`, commits changes, prunes worktrees cleanly. |
| **SQLite WAL Persistence** | `src/db/database.ts`, `src/db/migrations.ts` | **SHIPPED** | Pure `node:sqlite`, schema migrations (v1, v2, v3), atomic CAS task leasing. |
| **Monotonic Lease Epoch Fencing** | `src/db/migrations.ts`, `src/dag/taskService.ts` | **SHIPPED** | `MIGRATION_V3` with `lease_epoch INTEGER NOT NULL DEFAULT 1`, rejects stale epoch workers (`STALE_EPOCH_REVOKED`). |
| **DAG Topological Scheduling** | `src/dag/taskGraph.ts`, `src/dag/taskService.ts` | **SHIPPED** | Kahn topological sort with O(V+E) cycle detection and dependency unblocking. |
| **Win32 Job Object Sandboxing** | `crates/arbiter-kernel`, `src/native/nativeKernel.ts` | **SHIPPED** | Native Rust N-API addon (`kernel_create_job`, `kernel_assign_process`, `kernel_terminate_job`). |
| **Zero-Daemon Watchdog** | `src/dispatch/watchdog.ts` | **SHIPPED** | Process liveness via `process.kill(pid, 0)` and configurable heartbeat timeouts. |
| **Dedicated Merge Sandbox** | `src/merge/mergeQueue.ts` | **SHIPPED** | Dedicated worktree at `.arbiter/merge-sandbox`, zero interference with operator working tree. |
| **Fail-Closed Merge Quarantine** | `src/merge/mergeQueue.ts` | **SHIPPED** | Instant rollback (`git merge --abort`), preserves quarantined branch for inspection. |
| **Automated Conflict Reconciliation** | `src/merge/mergeQueue.ts` | **SHIPPED** | Automatically spawns `reconcile-<taskId>` dependent task on merge conflict. |
| **Waymark Supervisor Bridge** | `src/waymark/waymarkSupervisor.ts` | **SHIPPED** | Dual mode: detects native `waymark` CLI binary or falls back to internal simulator. |
| **MCP Server (JSON-RPC stdio)** | `src/mcp/index.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts` | **SHIPPED** | Standardized JSON-RPC 2.0 stdio interface exposing 11 native Arbiter tools. |
| **Operator CLI** | `src/cli/index.ts` | **SHIPPED** | Full parity with MCP tools via `arbiter <command>`. |
| **Tree-sitter WASM AST Discovery** | Roadmap Specification | **PLANNED** | Polyglot AST syntax tree discovery planned for zero-dependency symbol discovery. |
| **Capn Hook Episodic Memory** | Ecosystem Specification | **COMPLEMENTARY** | Finalized episodic memory storage, distinct from Waymark's active in-flight trajectory ledger. |

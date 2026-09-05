# Changelog

All notable changes to **Arbiter** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.1] — 2026-09-05

### Added
- **Automated Version Registry (`docs/VERSION_REGISTRY.md` & `scripts/bump-version.mjs`)**:
  - Declarative living version management separating living manifests and docs from historical immutable release audits.
  - Added `check:version` and `bump:version` npm scripts, integrating version drift validation directly into `npm run verify`.
  - Added CLI bumper utility (`node scripts/bump-version.mjs <semver>`) for atomic multi-manifest version updates across `package.json`, `Cargo.toml`, `README.md`, `CLAIMS.md`, and `FEATURE_STATUS.md`.

### Fixed
- **Cross-Platform Test Hardening**:
  - Guarded Win32 Job Object process eviction test assertions against non-Windows environments (`process.platform === 'win32'`).

## [2.1.0] — 2026-09-05 ("Remediation & Anti-Regression Hardening")

### Added
- **Monotonically Increasing Lease Epochs**:
  - Implemented database migration `MIGRATION_V3` adding `lease_epoch INTEGER NOT NULL DEFAULT 1` to `tasks`.
  - Increments `lease_epoch` on lease grant and watchdog reclamation.
  - Revokes and rejects completions and heartbeats from stale/zombie workers with `STALE_EPOCH_REVOKED`.
- **Isolated Merge Sandbox Worktree**:
  - `MergeQueue.mergeTask()` executes git merges in `.arbiter/merge-sandbox` out-of-band worktree.
  - Isolates merge conflicts and aborts from polluting or dirtying the primary root checkout.
- **Automated Conflict Reconciliation Spawning**:
  - Automatically transitions conflicted tasks to `CONFLICT_QUARANTINE`.
  - Spawns dependent DAG child task `reconcile/<taskId>` pointing to conflicting branches for automated resolution.
- **Native Kernel Build Automation & Distribution**:
  - Added `scripts/build-native.mjs` with MSVC environment autodetection and cross-platform artifact relocation.
  - Automatically builds and distributes `arbiter-kernel.node` to `dist/native/` and `native/`.
- **Anti-Regression CI Gates & Claims Registry**:
  - Added `CLAIMS.md` with quantitative performance and architectural assertions.
  - Added `scripts/claims-check.mjs`, `scripts/claims-hygiene.mjs`, and `scripts/check-checklist.mjs`.
  - Added `.github/PULL_REQUEST_TEMPLATE.md` enforcing zero runtime dependencies and invariant checks.
- **Dedicated Test Suites**:
  - `test/lease-epoch.test.ts`: Validates epoch fencing and stale worker eviction.
  - `test/merge-sandbox.test.ts`: Verifies sandbox isolation and dirty working directory preservation.
  - `test/reconciliation-task.test.ts`: Verifies automatic reconciliation task creation on merge conflict.

### Changed
- Migrated all 11 test suites to Node test runner standard `describe()` and `it()` blocks with isolated per-suite SQLite databases.
- Updated `crates/arbiter-kernel/Cargo.toml` to version `2.1.0`.
- Applied `/ponytail-review` simplifications: consolidated lease assertions in `TaskService`, forwarded `this.git()` in `MergeQueue`, streamlined native candidate search in `build-native.mjs`.

---

## [2.0.0] — 2026-09-04 ("Multi-Agent Orchestration & Sandboxed Isolation")

### Added
- Multi-agent orchestration engine with Git worktree isolation.
- Native Win32 Job Object process sandboxing via Rust N-API kernel addon (`crates/arbiter-kernel`).
- Kahn topological DAG task dependency scheduling.
- Zero-daemon watchdog heartbeat and dead PID lease recovery.
- SQLite WAL transactional task ledger.
- Model Context Protocol (MCP) tool bindings.
- Zero runtime dependencies architecture.

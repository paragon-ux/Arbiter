# OWNERSHIP — Maintenance Boundaries

The project lead owns `AGENTS.md`, `control/`, parent registration in `Antigravity-Project/AGENTS.md`, and architectural invariants. Changes to those files must be intentional and auditable.

Runtime maintainers own `src/`, `test/`, and `migrations/`. Runtime changes must preserve the contracts in `control/CONTRACTS.md` and include deterministic unit and integration tests.

Generated artifacts (`dist/`, `node_modules/`, `.arbiter/`, `.waymark/`) are local runtime state and are not source-of-truth inputs.

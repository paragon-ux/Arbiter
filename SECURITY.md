# Security Policy

## Reporting Security Vulnerabilities

Arbiter is a local-first engine designed to run on a developer or agent host. It operates exclusively over local stdio JSON-RPC 2.0 (MCP) and CLI commands. It does not bind network ports, expose HTTP listeners, or execute remote shell instructions without explicit local invocation.

If you identify a security issue, vulnerability, or path escape defect:
- Please do not disclose vulnerabilities publicly in issues or pull requests.
- Report the vulnerability directly to the project maintainers or via GitHub's private vulnerability reporting feature on the repository.

## Threat Model & Invariants

1. **Path Traversal Protection**: Arbiter sanitizes task IDs when provisioning `.arbiter/worktrees/task-<id>` directories to prevent directory traversal or symlink escapes.
2. **Process Liveness**: Worker lease verification uses `process.kill(pid, 0)` which is non-destructive and safe across Windows, macOS, and Linux without elevated root privileges.
3. **Repository Cleanliness**: The main repository working directory is strictly protected against partial or conflicted merge states (`git merge --abort` on failure).
4. **Local Data Isolation**: `.arbiter/` runtime storage (including SQLite databases and worktrees) is git-ignored and should be treated as private local state.

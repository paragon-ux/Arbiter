# Arbiter Suite Version Registry & Isolation Specification

This document defines the single source of truth for version references across `Arbiter`. It establishes strict boundaries between **Living Version Targets** (which track active suite releases) and **Immutable Historical Archives**.

---

## 🎯 Architecture: Zero Blind Searching

To prevent manual grep errors and version drift, all living version references are registered in `scripts/bump-version.mjs`.

### Automated CLI Workflow
```bash
# Check version parity across all living targets (asserts 0 drift)
npm run check:version
# or: node scripts/bump-version.mjs --check

# Bump suite version atomically across all living targets
node scripts/bump-version.mjs 2.1.1
```

---

## 📋 Living Targets Registry (Synchronized via `bump-version.mjs`)

| Target File | Pattern / Field | Purpose |
| :--- | :--- | :--- |
| [`package.json`](../package.json) | `"version": "X.Y.Z"` | NPM package manifest |
| [`crates/arbiter-kernel/Cargo.toml`](../crates/arbiter-kernel/Cargo.toml) | `version = "X.Y.Z"` | Rust native kernel manifest |
| [`README.md`](../README.md) | `https://img.shields.io/badge/version-X.Y.Z-blue.svg` | Root README release badge |
| [`CLAIMS.md`](../CLAIMS.md) | `**Document Version:** X.Y.Z-PROD` | Production claims registry |
| [`docs/FEATURE_STATUS.md`](FEATURE_STATUS.md) | `**Document Version:** X.Y.Z-PROD` | Public feature matrix |
| [`CHANGELOG.md`](../CHANGELOG.md) | `## [X.Y.Z] — YYYY-MM-DD` | Release notes history |

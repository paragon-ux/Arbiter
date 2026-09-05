# Pull Request Verification Checklist

## Pre-Merge Requirements
- [ ] **Green CI Verification**: CI workflow passed on Ubuntu, macOS, and Windows. Link: 
- [ ] **Quantitative Claims Audit**: `CLAIMS.md` reviewed and updated for any changed metrics.
- [ ] **Checklist Standard**: Verified against `REMEDIATION_AND_ANTI_REGRESSION_CHECKLIST.md`.
- [ ] **Production Packaging Gate**: Executed `npm ci --omit=dev && npm run build` cleanly with zero runtime dependency regressions.

## Verification Logs & Artifacts
```
<Paste terminal output of: npm run verify>
```

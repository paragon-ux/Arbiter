# Arbiter Quantitative Claims Registry

**Document Version:** 2.1.1-PROD  
**Single Source of Truth for Benchmark & Performance Claims**

```json
[
  {
    "claim": "Zero runtime npm dependencies",
    "target": "runtime_dependencies",
    "expectedValue": 0,
    "tolerancePercent": 0,
    "generatingCommand": "node -e \"const pkg = require('./package.json'); process.stdout.write(String(Object.keys(pkg.dependencies || {}).length));\"",
    "lastVerifiedDate": "2026-09-05"
  },
  {
    "claim": "DAG topological sort 50 nodes latency",
    "target": "dag_sort_50_nodes_ms",
    "expectedValue": 4.0,
    "tolerancePercent": 200,
    "generatingCommand": "node -e \"const { ArbiterDatabase } = require('./dist/src/db/database.js'); const { TaskGraph } = require('./dist/src/dag/taskGraph.js'); const db = new ArbiterDatabase(':memory:'); const dag = new TaskGraph(db); for (let i = 1; i <= 50; i++) { db.insertTask({ id: 'T' + i, title: 'T' + i, description: '', baseBranch: 'main', branch: 'b' + i, status: 'PENDING', worktreePath: null, assignedWorkerId: null, waymarkTrajectoryId: null, resultAnswer: null, errorMessage: null }); if (i > 1) dag.addDependency('T' + (i-1), 'T' + i); } const s = performance.now(); dag.getTopologicalOrder(); process.stdout.write(String(performance.now() - s));\"",
    "lastVerifiedDate": "2026-09-05"
  },
  {
    "claim": "Formal Node test runner suites count",
    "target": "test_suites_count",
    "expectedValue": 11,
    "tolerancePercent": 0,
    "generatingCommand": "node -e \"const fs = require('fs'); process.stdout.write(String(fs.readdirSync('./test').filter(f => f.endsWith('.test.ts')).length));\"",
    "lastVerifiedDate": "2026-09-05"
  }
]
```

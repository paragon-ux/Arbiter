import assert from "node:assert/strict";
import test from "node:test";
import { ArbiterDatabase } from "../src/db/database.js";
import { TaskGraph } from "../src/dag/taskGraph.js";

test("TaskGraph detects direct and indirect cycles and rejects them", () => {
  const db = new ArbiterDatabase(":memory:");
  const graph = new TaskGraph(db);
  try {
    for (const id of ["T1", "T2", "T3"]) {
      db.insertTask({
        id,
        title: id,
        description: id,
        baseBranch: "main",
        branch: `arbiter/${id}`,
        worktreePath: null,
        assignedWorkerId: null,
        waymarkTrajectoryId: null,
        resultAnswer: null,
        errorMessage: null,
      });
    }

    graph.addDependency("T1", "T2"); // T1 -> T2
    graph.addDependency("T2", "T3"); // T2 -> T3

    // Direct cycle: T2 -> T1
    assert.equal(graph.hasCycle("T2", "T1"), true);
    assert.throws(() => graph.addDependency("T2", "T1"), /Circular dependency/i);

    // Indirect cycle: T3 -> T1
    assert.equal(graph.hasCycle("T3", "T1"), true);
    assert.throws(() => graph.addDependency("T3", "T1"), /Circular dependency/i);

    // Self dependency
    assert.throws(() => graph.addDependency("T1", "T1"), /Circular dependency/i);
  } finally {
    db.close();
  }
});

test("TaskGraph resolves topological sort order for complex diamond DAGs", () => {
  const db = new ArbiterDatabase(":memory:");
  const graph = new TaskGraph(db);
  try {
    // Diamond DAG:
    //      A
    //     / \
    //    B   C
    //     \ /
    //      D
    for (const id of ["A", "B", "C", "D"]) {
      db.insertTask({
        id,
        title: id,
        description: id,
        baseBranch: "main",
        branch: `arbiter/${id}`,
        worktreePath: null,
        assignedWorkerId: null,
        waymarkTrajectoryId: null,
        resultAnswer: null,
        errorMessage: null,
      });
    }

    graph.addDependency("A", "B");
    graph.addDependency("A", "C");
    graph.addDependency("B", "D");
    graph.addDependency("C", "D");

    const order = graph.getTopologicalOrder().map((t) => t.id);
    assert.equal(order.length, 4);
    assert.equal(order[0], "A");
    assert.ok(order.indexOf("B") < order.indexOf("D"));
    assert.ok(order.indexOf("C") < order.indexOf("D"));
    assert.equal(order[3], "D");
  } finally {
    db.close();
  }
});

test("TaskGraph transitions PENDING tasks to READY when parents complete", () => {
  const db = new ArbiterDatabase(":memory:");
  const graph = new TaskGraph(db);
  try {
    for (const id of ["Parent", "Child"]) {
      db.insertTask({
        id,
        title: id,
        description: id,
        baseBranch: "main",
        branch: `arbiter/${id}`,
        worktreePath: null,
        assignedWorkerId: null,
        waymarkTrajectoryId: null,
        resultAnswer: null,
        errorMessage: null,
      });
    }

    graph.addDependency("Parent", "Child");

    // Parent is ready, child is not
    let ready = graph.updateUnblockedTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.id, "Parent");

    // Complete parent
    db.updateTask("Parent", { status: "COMPLETED" });

    // Child should now transition to READY
    ready = graph.updateUnblockedTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.id, "Child");
    assert.equal(db.getTask("Child")?.status, "READY");
  } finally {
    db.close();
  }
});

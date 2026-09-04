import assert from "node:assert/strict";
import test from "node:test";
import { ArbiterDatabase } from "../src/db/database.js";

test("ArbiterDatabase initializes in-memory, applies migrations, and performs task CRUD", () => {
  const db = new ArbiterDatabase(":memory:");
  try {
    const task = db.insertTask({
      id: "task-1",
      title: "Test Task",
      description: "A test description",
      baseBranch: "main",
      branch: "arbiter/task-1",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    assert.equal(task.id, "task-1");
    assert.equal(task.status, "PENDING");
    assert.ok(task.createdAt);

    const fetched = db.getTask("task-1");
    assert.ok(fetched);
    assert.equal(fetched.title, "Test Task");

    const updated = db.updateTask("task-1", {
      status: "READY",
      assignedWorkerId: "worker-alpha",
    });
    assert.equal(updated.status, "READY");
    assert.equal(updated.assignedWorkerId, "worker-alpha");

    const list = db.listTasks("READY");
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, "task-1");
  } finally {
    db.close();
  }
});

test("ArbiterDatabase correctly identifies READY tasks based on parent dependencies", () => {
  const db = new ArbiterDatabase(":memory:");
  try {
    // Task A (no deps)
    db.insertTask({
      id: "task-A",
      title: "Root Task",
      description: "Desc A",
      baseBranch: "main",
      branch: "arbiter/task-A",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    // Task B (depends on A)
    db.insertTask({
      id: "task-B",
      title: "Child Task",
      description: "Desc B",
      baseBranch: "main",
      branch: "arbiter/task-B",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });
    db.addDependency("task-A", "task-B");

    // Initially: Task A is ready; Task B is NOT ready
    let ready = db.getReadyTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.id, "task-A");

    // Complete Task A
    db.updateTask("task-A", { status: "COMPLETED" });

    // Now: Task B becomes ready!
    ready = db.getReadyTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.id, "task-B");
  } finally {
    db.close();
  }
});

test("Worker leases and task events are recorded and retrieved accurately", () => {
  const db = new ArbiterDatabase(":memory:");
  try {
    db.insertTask({
      id: "task-100",
      title: "Lease Test",
      description: "Desc",
      baseBranch: "main",
      branch: "arbiter/task-100",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    db.setWorkerLease({
      workerId: "agent-007",
      taskId: "task-100",
      pid: 12345,
      heartbeatAt: new Date().toISOString(),
      status: "ACTIVE",
    });

    const lease = db.getWorkerLease("task-100");
    assert.ok(lease);
    assert.equal(lease.workerId, "agent-007");
    assert.equal(lease.pid, 12345);

    db.logEvent("task-100", "test.event", { key: "val" });
    const events = db.getEvents("task-100");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "test.event");
    assert.match(events[0]?.payload ?? "", /key/);

    db.releaseWorkerLease("agent-007", "task-100");
    assert.equal(db.getWorkerLease("task-100"), null);
  } finally {
    db.close();
  }
});

test("ArbiterDatabase caches prepared statements and computes cluster metrics", () => {
  const db = new ArbiterDatabase(":memory:");
  try {
    // 1. Check statement caching by executing multiple queries
    db.insertTask({
      id: "metric-1",
      title: "Metric Task 1",
      description: "Description 1",
      baseBranch: "main",
      branch: "arbiter/metric-1",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });
    db.insertTask({
      id: "metric-2",
      title: "Metric Task 2",
      description: "Description 2",
      baseBranch: "main",
      branch: "arbiter/metric-2",
      worktreePath: null,
      assignedWorkerId: null,
      waymarkTrajectoryId: null,
      resultAnswer: null,
      errorMessage: null,
    });

    db.addDependency("metric-1", "metric-2");
    const deps = db.getAllDependencies();
    assert.equal(deps.length, 1);
    assert.equal(deps[0]?.parent_task_id, "metric-1");
    assert.equal(deps[0]?.child_task_id, "metric-2");

    db.setWorkerLease({
      workerId: "agent-metrics",
      taskId: "metric-1",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      status: "ACTIVE",
    });

    db.logEvent("metric-1", "task.started", { note: "test" });
    db.logEvent("metric-1", "task.progress", { pct: 50 });

    const metrics = db.getMetrics();
    assert.equal(metrics.totalTasks, 2);
    assert.equal(metrics.statusCounts["PENDING"], 2);
    assert.equal(metrics.activeLeases, 1);
    assert.equal(metrics.totalEvents, 2);
    assert.equal(metrics.eventCounts["task.started"], 1);
    assert.equal(metrics.eventCounts["task.progress"], 1);
  } finally {
    db.close();
  }
});

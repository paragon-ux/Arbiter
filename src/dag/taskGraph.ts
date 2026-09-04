import { ArbiterDatabase } from "../db/database.js";
import { TaskRecord } from "../db/types.js";

export class TaskGraph {
  constructor(private readonly db: ArbiterDatabase) {}

  public hasCycle(fromParent: string, toChild: string): boolean {
    if (fromParent === toChild) return true;
    const visited = new Set<string>();
    const queue = [toChild];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === fromParent) return true;
      if (!visited.has(current)) {
        visited.add(current);
        const children = this.db.getChildTaskIds(current);
        queue.push(...children);
      }
    }
    return false;
  }

  public addDependency(parentTaskId: string, childTaskId: string): void {
    if (this.hasCycle(parentTaskId, childTaskId)) {
      throw new Error(`Circular dependency detected: cannot make task ${childTaskId} depend on ${parentTaskId}`);
    }
    this.db.addDependency(parentTaskId, childTaskId);
  }

  public updateUnblockedTasks(): TaskRecord[] {
    const readyTasks = this.db.getReadyTasks();
    const updated: TaskRecord[] = [];
    for (const task of readyTasks) {
      if (task.status === "PENDING") {
        const res = this.db.updateTask(task.id, { status: "READY" });
        this.db.logEvent(task.id, "task.ready", { reason: "dependencies_satisfied" });
        updated.push(res);
      }
    }
    return updated;
  }

  public unblockChildrenOf(parentTaskId: string): TaskRecord[] {
    const childIds = this.db.getChildTaskIds(parentTaskId);
    const unblocked: TaskRecord[] = [];

    for (const childId of childIds) {
      const child = this.db.getTask(childId);
      if (!child || child.status !== "PENDING") {
        continue;
      }

      const parentIds = this.db.getParentTaskIds(childId);
      const allParentsCompleted = parentIds.every((pid) => {
        const parent = this.db.getTask(pid);
        return parent?.status === "COMPLETED";
      });

      if (allParentsCompleted) {
        const res = this.db.updateTask(childId, { status: "READY" });
        this.db.logEvent(childId, "task.ready", { reason: "dependencies_satisfied" });
        unblocked.push(res);
      }
    }

    return unblocked;
  }

  public getTopologicalOrder(): TaskRecord[] {
    const allTasks = this.db.listTasks();
    const taskMap = new Map<string, TaskRecord>(allTasks.map((t) => [t.id, t]));
    const inDegree = new Map<string, number>();
    const parentToChildren = new Map<string, string[]>();

    for (const task of allTasks) {
      inDegree.set(task.id, 0);
      parentToChildren.set(task.id, []);
    }

    const allDeps = this.db.getAllDependencies();
    for (const dep of allDeps) {
      if (inDegree.has(dep.child_task_id)) {
        inDegree.set(dep.child_task_id, (inDegree.get(dep.child_task_id) ?? 0) + 1);
      }
      const children = parentToChildren.get(dep.parent_task_id);
      if (children) {
        children.push(dep.child_task_id);
      } else {
        parentToChildren.set(dep.parent_task_id, [dep.child_task_id]);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const order: TaskRecord[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const task = taskMap.get(currentId);
      if (task) order.push(task);

      const children = parentToChildren.get(currentId) ?? [];
      for (const childId of children) {
        const currentDeg = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, currentDeg);
        if (currentDeg === 0) queue.push(childId);
      }
    }

    return order;
  }
}

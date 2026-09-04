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

  public getTopologicalOrder(): TaskRecord[] {
    const allTasks = this.db.listTasks();
    const taskMap = new Map<string, TaskRecord>(allTasks.map((t) => [t.id, t]));
    const inDegree = new Map<string, number>();

    for (const task of allTasks) {
      inDegree.set(task.id, 0);
    }

    for (const task of allTasks) {
      const parents = this.db.getParentTaskIds(task.id);
      inDegree.set(task.id, parents.length);
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

      const children = this.db.getChildTaskIds(currentId);
      for (const childId of children) {
        const currentDeg = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, currentDeg);
        if (currentDeg === 0) queue.push(childId);
      }
    }

    return order;
  }
}

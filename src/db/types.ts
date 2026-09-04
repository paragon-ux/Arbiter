export type TaskStatus =
  | "PENDING"
  | "READY"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CONFLICT";

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  baseBranch: string;
  branch: string;
  worktreePath: string | null;
  assignedWorkerId: string | null;
  waymarkTrajectoryId: string | null;
  resultAnswer: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskDependency {
  parentTaskId: string;
  childTaskId: string;
}

export interface WorkerLease {
  workerId: string;
  taskId: string;
  pid: number;
  heartbeatAt: string;
  status: "ACTIVE" | "EXPIRED" | "RELEASED";
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  payload: string;
  createdAt: string;
}

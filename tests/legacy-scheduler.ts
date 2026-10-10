import { reserveCapability } from "../core/authority.ts";
import { enqueueMessage, sendMessage, type MessageRecord } from "../core/bus.ts";
import { withTransaction } from "../core/db.ts";
import { SideraError } from "../core/types.ts";
import type { DatabaseSync } from "node:sqlite";
import { getTask } from "../core/scheduler.ts";
/** Historical pre-Run fixtures only. Never imported by production Core/RPC. */
export function delegateTask(db: DatabaseSync, input: {
  taskId: string;
  centerNodeId: string;
  centerSessionId: string;
  workerNodeId: string;
  requestId: string;
  body: string;
}): MessageRecord {
  return withTransaction(db, "task_delegate", () => {
    const view = getTask(db, input.taskId);
    if (view.task.centerNodeId !== input.centerNodeId ||
        !view.task.workerNodeIds.includes(input.workerNodeId)) {
      throw new SideraError("denied", "Worker is not assigned to this Center");
    }
    const permit = reserveCapability(db, {
      subjectNodeId: input.centerNodeId,
      sessionId: input.centerSessionId,
      capability: "task.delegate",
      resource: `node/${input.workerNodeId}`,
      requestId: input.requestId,
      taskId: input.taskId,
    });
    const message = enqueueMessage(db, {
      requestId: input.requestId,
      taskId: input.taskId,
      fromNodeId: input.centerNodeId,
      toNodeId: input.workerNodeId,
      kind: "delegate",
      body: input.body,
      reservationId: permit.reservationId,
    });
    db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ?")
      .run(input.taskId);
    return message;
  });
}

export function completeTask(db: DatabaseSync, input: {
  taskId: string;
  fromNodeId: string;
  fromSessionId: string;
  requestId: string;
  body: string;
}): MessageRecord {
  return withTransaction(db, "task_complete", () => {
    const view = getTask(db, input.taskId);
    if (input.fromNodeId !== view.task.centerNodeId &&
        !view.task.workerNodeIds.includes(input.fromNodeId)) {
      throw new SideraError("denied", "Node is not assigned to this task");
    }
    const result = sendMessage(db, {
      requestId: input.requestId,
      taskId: input.taskId,
      fromNodeId: input.fromNodeId,
      fromSessionId: input.fromSessionId,
      toNodeId: view.task.originNodeId,
      kind: "result",
      body: input.body,
    });
    db.prepare("UPDATE tasks SET state = 'completed' WHERE task_id = ?")
      .run(input.taskId);
    return result;
  });
}

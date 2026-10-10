import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability } from "./authority.ts";
import { enqueueMessage, getMessage, type MessageRecord } from "./bus.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { SemanticStore, sameBasis, setTaskBasis, taskBasis, type SemanticBasis } from "./semantics.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { executionReality } from "./effect-gate.ts";
import { readNodeOntology } from "./ontology.ts";
import { assignExecutor,selectDispatchExecutor } from "./executors.ts";
import { bindTaskRuleContext } from "./rules.ts";

export interface TaskRecord {
  taskId: string;
  requestId: string;
  originNodeId: string;
  centerNodeId: string;
  workerNodeIds: string[];
  state: "queued" | "running" | "unknown" | "waiting_dependency" | "completed" | "failed" | "uncertain";
  schedulingState?: string;
  budgetRef: string | null;
  createdAt: string;
}

export interface DispatchInput {
  basis?: SemanticBasis;
  requestId: string;
  originNodeId: string;
  originSessionId: string;
  centerNodeId: string;
  workerNodeIds: string[];
  body: string;
  budgetRef?: string | null;
  supervisionId?: string;
  projectRef?: string;
  /** Exact previously admitted Executor selected by Runtime, not a UI title. */
  targetSessionId?: string;
  /** Trusted internal self-wake only; never copied from RPC args. */
  authorityCapability?: "self.task.resume";
}

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  return {
    taskId: String(row.task_id),
    requestId: String(row.request_id),
    originNodeId: String(row.origin_node_id),
    centerNodeId: String(row.center_node_id),
    workerNodeIds: JSON.parse(String(row.worker_node_ids)) as string[],
    state: String(row.state) as TaskRecord["state"],
    budgetRef: row.budget_ref == null ? null : String(row.budget_ref),
    createdAt: String(row.created_at),
  };
}

export function getTask(db: DatabaseSync, taskId: string): {
  task: TaskRecord;
  messages: MessageRecord[];
  runs: unknown[];
  dependencies: unknown[];
  semantic: { worldId: string; basis: unknown; runs: unknown[] };
} {
  const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?")
    .get(taskId) as Record<string, unknown> | undefined;
  if (!row) throw new SideraError("not_found", "Task was not found");
  const messageRows = db.prepare(`SELECT message_id FROM messages
    WHERE task_id = ? ORDER BY created_at, sequence`).all(taskId) as
    { message_id: string }[];
  const runs=db.prepare("SELECT * FROM task_runs WHERE task_id=? ORDER BY rowid").all(taskId).map(run=>{
    const execution=executionReality(db,String(run.run_id));
    return {...run,schedulingState:run.state,state:run.state==="running"&&!execution.authoritativeRunning?"unknown":run.state,execution};
  });
  const task=taskFromRow(row);
  if(task.state==="running" && !runs.some(run=>run.execution.authoritativeRunning)) {task.schedulingState="running";task.state="unknown";}
  return { task, messages: messageRows.map(item => getMessage(db, item.message_id)),
    semantic: { worldId: recordWorld(db, "tasks", taskId),
      basis: db.prepare("SELECT * FROM task_bases WHERE task_id=?").get(taskId),
      runs: (db.prepare("SELECT run_id FROM task_runs WHERE task_id=?").all(taskId) as {run_id:string}[])
        .map(r => new SemanticStore(db, recordWorld(db,"tasks",taskId)).runBasis(r.run_id)) },
    runs,
    dependencies: db.prepare(`SELECT d.* FROM task_dependencies d JOIN task_runs r
      ON r.run_id = d.parent_run_id WHERE r.task_id = ? OR d.child_task_id = ?`).all(taskId, taskId) };
}

export function createTask(db: DatabaseSync, input: DispatchInput): {
  task: TaskRecord;
  firstMessage: MessageRecord;
} {
  return withTransaction(db, "task_dispatch", () => {
    const worldId = recordWorld(db, "nodes", input.originNodeId);
    for (const nodeId of [input.centerNodeId, ...input.workerNodeIds]) requireWorld(db, worldId, "nodes", nodeId);
    requireWorld(db, worldId, "sessions", input.originSessionId);
    const previous = db.prepare(`SELECT task_id FROM tasks
      WHERE origin_node_id = ? AND request_id = ?`)
      .get(input.originNodeId, input.requestId) as { task_id: string } | undefined;
    if (previous) {
      const view = getTask(db, previous.task_id);
      const project=db.prepare("SELECT project_ref FROM task_rule_context WHERE task_id=?").get(previous.task_id)?.project_ref;
      if (view.task.centerNodeId !== input.centerNodeId ||
          JSON.stringify(view.task.workerNodeIds) !== JSON.stringify(input.workerNodeIds) ||
          (input.projectRef??null)!==(project??null) ||
          view.messages[0]?.body !== input.body || input.targetSessionId!==undefined&&view.messages[0]?.targetSessionId!==input.targetSessionId || !sameBasis(taskBasis(db, previous.task_id), input.basis)) {
        throw new SideraError("conflict", "Request ID was already used for another task");
      }
      return { task: view.task, firstMessage: view.messages[0] };
    }
    const selection=readNodeOntology(db,input.centerNodeId).kind==="Operator" && !input.authorityCapability
      ?selectDispatchExecutor(db,{operatorNodeRef:input.centerNodeId,targetSessionId:input.targetSessionId}):null;
    if(selection&&selection.state!=="selected")throw new SideraError("unavailable",`EXECUTOR_MACHINE_REVIEW_REQUIRED: ${selection.reason}`);
    const permit = reserveCapability(db, {
      subjectNodeId: input.originNodeId,
      sessionId: input.originSessionId,
      capability: input.authorityCapability && input.originNodeId === input.centerNodeId ? input.authorityCapability : "task.dispatch",
      resource: `node/${input.centerNodeId}`,
      requestId: input.requestId,
      projectRef:input.projectRef,
    });
    const taskId = randomUUID();
    db.prepare(`INSERT INTO tasks
      (task_id, request_id, origin_node_id, center_node_id, worker_node_ids,
       state, budget_ref, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(taskId, input.requestId, input.originNodeId, input.centerNodeId,
        JSON.stringify(input.workerNodeIds), input.budgetRef ?? null,
        new Date().toISOString());
    setTaskBasis(db, taskId, input.basis);
    if(input.projectRef)bindTaskRuleContext(db,taskId,input.projectRef);
    if(selection?.state==="selected")assignExecutor(db,{taskRef:taskId,executorRef:selection.executor.executorRef});
    const firstMessage = enqueueMessage(db, {
      requestId: input.requestId,
      taskId,
      fromNodeId: input.originNodeId,
      toNodeId: input.centerNodeId,
      kind: "task",
      body: input.body,
      reservationId: permit.reservationId,
      targetSessionId:selection?.state==="selected"?selection.executor.runtimeSessionId:input.targetSessionId,
    });
    return { task: getTask(db, taskId).task, firstMessage };
  });
}

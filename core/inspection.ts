import { humanRootedFor } from "./activation.ts";
import type { DatabaseSync } from "node:sqlite";
import { getTask } from "./scheduler.ts";
import { getResponsibility } from "./organization.ts";
import { supervisionView } from "./supervision.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { SideraError } from "./types.ts";
import { readNodeOntology,chiefConversationRole } from "./ontology.ts";
import { executorPool,taskExecutorAssignments } from "./executors.ts";
import {readSessionHostCondition} from "./condition.ts";

export type InspectionCaller = { kind: "node"; nodeId: string; sessionId: string } |
  { kind: "human"; id: string };
export interface InspectionScope { worldId?: string; limit?: number }
export interface WorkSelection extends InspectionScope {
  taskId?: string; responsibilityId?: string; supervisionId?: string;
}
type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? null : String(value);
const bounded = (value: unknown, limit = 4000) => value == null ? null : String(value).slice(0, limit);

function scope(db: DatabaseSync, caller: InspectionCaller, requested?: string): string {
  if (caller.kind === "node") {
    const session = db.prepare("SELECT node_id,state FROM sessions WHERE session_id=?").get(caller.sessionId);
    if (session?.node_id !== caller.nodeId || session.state !== "active")
      throw new SideraError("denied", "Inspection requires the caller's active exact Session");
    const world = recordWorld(db, "nodes", caller.nodeId);
    requireWorld(db, world, "sessions", caller.sessionId);
    if (requested && requested !== world) throw new SideraError("denied", "Cross-World inspection is not supported");
    return world;
  }
  const worlds = db.prepare("SELECT world_id FROM world_humans WHERE human_id=?").all(caller.id).map(r => String(r.world_id));
  if (requested && worlds.includes(requested)) return requested;
  if (!requested && worlds.length === 1) return worlds[0];
  throw new SideraError("denied", requested ? "Human is not a member of this World" : "Select an authorized World explicitly");
}

function participant(caller: InspectionCaller, task: Row): boolean {
  return caller.kind === "human" || task.origin_node_id === caller.nodeId || task.center_node_id === caller.nodeId ||
    (JSON.parse(String(task.worker_node_ids)) as string[]).includes(caller.nodeId);
}
function taskRows(db: DatabaseSync, worldId: string, caller: InspectionCaller): Row[] {
  // Same participant rule as task.get. World membership alone is not Task visibility.
  return db.prepare(`SELECT t.* FROM tasks t JOIN world_records w ON w.table_name='tasks'
    AND w.record_key=json_array(t.task_id) WHERE w.world_id=? ORDER BY t.created_at DESC,t.rowid DESC`)
    .all(worldId).filter(t => participant(caller, t));
}
function supervisionRows(db: DatabaseSync, worldId: string, caller: InspectionCaller): Row[] {
  // Match supervision.view: judgments and instructions remain the Supervisor's surface.
  return db.prepare(`SELECT * FROM supervisions WHERE world_id=? AND (? IS NULL OR chief_node_id=?)
    ORDER BY updated_at DESC,rowid DESC`).all(worldId, caller.kind === "node" ? caller.nodeId : null,
      caller.kind === "node" ? caller.nodeId : null);
}
function responsibilityRows(db: DatabaseSync, worldId: string, caller: InspectionCaller, tasks: Row[]): Row[] {
  const linked = new Set(tasks.map(t => text(db.prepare("SELECT responsibility_id FROM task_bases WHERE task_id=?")
    .get(String(t.task_id))?.responsibility_id)).filter(Boolean));
  return db.prepare(`SELECT r.* FROM responsibilities r JOIN world_records w ON w.table_name='responsibilities'
    AND w.record_key=json_array(r.responsibility_id) WHERE w.world_id=? ORDER BY r.updated_at DESC,r.rowid DESC`)
    .all(worldId).filter(r => caller.kind === "human" || r.owner_node_id === caller.nodeId || linked.has(String(r.responsibility_id)));
}

function taskView(db: DatabaseSync, worldId: string, taskId: string) {
  const view = getTask(db, taskId);
  const runs = (view.runs as Row[]).map(run => {
    const execution = run.execution as { state: string; authoritativeRunning: boolean };
    const checkpoint = db.prepare("SELECT outcome,created_at FROM run_checkpoints WHERE run_id=?").get(String(run.run_id));
    return { runId: String(run.run_id), sessionId: String(run.session_id), messageId: String(run.message_id),
      state: String(run.state), schedulingState: String(run.schedulingState), turnOpen: Boolean(run.turn_open),
      execution: { state: execution.state, authoritativeRunning: execution.authoritativeRunning },
      checkpoint: bounded(run.checkpoint), checkpointOutcome: text(checkpoint?.outcome),
      checkpointAt: text(checkpoint?.created_at), createdAt: String(run.created_at) };
  });
  const basis = db.prepare(`SELECT responsibility_id,intent_revision_id,context_basis_json,provenance
    FROM task_bases WHERE task_id=? AND world_id=?`).get(taskId, worldId);
  const supervision = db.prepare(`SELECT s.supervision_id,s.chief_node_id FROM supervision_tasks t
    JOIN supervisions s USING(supervision_id) WHERE t.task_id=? AND s.world_id=?`).get(taskId, worldId);
  const effects = db.prepare(`SELECT a.attempt_id,a.action_id,a.generation,a.source_message_id,a.target_session_id,
    s.state,a.recorded_at FROM action_attempts a JOIN messages m ON m.message_id=a.source_message_id
    LEFT JOIN effect_attempt_state s USING(attempt_id) WHERE a.world_id=? AND m.task_id=?
    ORDER BY a.recorded_at,a.generation`).all(worldId, taskId).map(attempt => ({
      attemptId: String(attempt.attempt_id), actionId: String(attempt.action_id), generation: Number(attempt.generation),
      messageId: text(attempt.source_message_id), targetSessionId: String(attempt.target_session_id),
      knowledge: text(attempt.state) ?? "UNKNOWN", recordedAt: String(attempt.recorded_at),
      // Inspection never makes a retry/reconciliation decision or issues a permit.
      retryAuthorized: false,
      evidence: db.prepare(`SELECT event_id,kind,at FROM effect_audit WHERE world_id=? AND attempt_id=? ORDER BY rowid`)
        .all(worldId, String(attempt.attempt_id)).map(e => ({ eventId: String(e.event_id), kind: String(e.kind), at: String(e.at) })),
    }));
  const messages = view.messages.map(m => ({ messageId: m.messageId, kind: m.kind, state: m.state,
    fromNodeId: m.fromNodeId, toNodeId: m.toNodeId, targetSessionId: m.targetSessionId,
    hostAccepted: m.hostRef !== null, createdAt: m.createdAt }));
  const result = view.messages.findLast(m => m.kind === "result" && m.toNodeId === view.task.originNodeId);
  return { taskId, state: view.task.state, schedulingState: view.task.schedulingState ?? view.task.state,
    originNodeId: view.task.originNodeId, executingNodeId: view.task.centerNodeId, workerNodeIds: view.task.workerNodeIds,
    supervisorNodeId: text(supervision?.chief_node_id), supervisionId: text(supervision?.supervision_id),
    createdAt: view.task.createdAt, executors:taskExecutorAssignments(db,taskId),runs, messages, effects,
    dependencies: (view.dependencies as Row[]).map(d => ({ parentRunId: String(d.parent_run_id), childTaskId: String(d.child_task_id),
      state: String(d.state), resultMessageId: text(d.result_message_id), continuationRunId: text(d.continuation_run_id) })),
    finalResult: result ? { messageId: result.messageId, body: bounded(result.body, 16000),
      truncated: result.body.length > 16000, fromNodeId: result.fromNodeId, toNodeId: result.toNodeId,
      targetSessionId: result.targetSessionId, deliveryState: result.state,
      taskCompleted: view.task.state === "completed", createdAt: result.createdAt } : null,
    provenance: { taskId, requestId: view.task.requestId, responsibilityId: text(basis?.responsibility_id),
      intentRevisionId: text(basis?.intent_revision_id), contextBasis: basis ? JSON.parse(String(basis.context_basis_json)) as string[] : [],
      source: text(basis?.provenance) ?? "UNKNOWN" } };
}

function supervisionDetail(db: DatabaseSync, row: Row) {
  const id = String(row.supervision_id), view = supervisionView(db, id);
  const rounds = db.prepare(`SELECT r.*,d.decision,d.reason,d.instruction,d.decided_by_node_id,d.decided_by_human_id,d.decided_at
    FROM supervision_rounds r LEFT JOIN supervision_decisions d USING(supervision_id,round_index)
    WHERE r.supervision_id=? ORDER BY r.round_index`).all(id).map(r => ({ roundIndex: Number(r.round_index),
      taskId: text(r.task_id), executingNodeId: String(r.agent_node_id), resultMessageId: text(r.result_message_id),
      state: String(r.state), createdAt: String(r.created_at),
      decision: r.decision == null ? null : { decision: String(r.decision), reason: bounded(r.reason), instruction: bounded(r.instruction),
        nodeId: text(r.decided_by_node_id), humanId: text(r.decided_by_human_id), decidedAt: text(r.decided_at) } }));
  return { supervisionId: id, responsibilityId: text(row.responsibility_id), supervisorNodeId: view.chiefNodeId,
    state: view.state, goal: bounded(view.goal), acceptanceCriteria: bounded(view.acceptanceCriteria),
    maxRounds: view.maxRounds, roundsCompleted: view.roundsCompleted, awaitingDecisionRound: view.awaitingDecisionRound,
    nextAction: view.nextAction,nextNodeId:view.nextNodeId, nextInstruction: bounded(view.nextInstruction), waitingFor: bounded(view.waitingFor), rounds };
}

function render(db: DatabaseSync, worldId: string, rows: { tasks: Row[]; responsibilities: Row[]; supervisions: Row[] }, limit: number) {
  const tasks = rows.tasks.slice(0, limit).map(t => taskView(db, worldId, String(t.task_id)));
  const supervisions = rows.supervisions.slice(0, limit).map(s => supervisionDetail(db, s));
  const responsibilities = rows.responsibilities.slice(0, limit).map(r => {
    const responsibility = getResponsibility(db, String(r.responsibility_id));
    return { ...responsibility, currentStage: responsibility.state === "waiting" ? "waiting" :
      responsibility.state === "completed" || responsibility.state === "cancelled" ? responsibility.state :
      responsibility.acceptance === "proposed" ? "awaiting_acceptance" : "active",
      taskIds: tasks.filter(t => t.provenance.responsibilityId === responsibility.responsibilityId).map(t => t.taskId),
      supervisionIds: supervisions.filter(s => s.responsibilityId === responsibility.responsibilityId).map(s => s.supervisionId) };
  });
  const ids = new Set([...tasks.map(t => t.taskId), ...tasks.flatMap(t => t.runs.map(r => r.runId)),
    ...responsibilities.map(r => r.responsibilityId), ...supervisions.map(s => s.supervisionId)]);
  // Event payloads may include Host stdout, private context or credentials. Return only
  // durable metadata and references to records the caller already has permission to inspect.
  const recentProgress = db.prepare(`SELECT e.event_id,e.kind,e.actor_node_id,e.created_at,e.payload FROM events e
    JOIN world_records w ON w.table_name='events' AND w.record_key=json_array(e.event_id)
    WHERE w.world_id=? ORDER BY e.rowid DESC`).all(worldId).flatMap(e => {
      const p = JSON.parse(String(e.payload)) as Row;
      const refs = ["taskId", "runId", "responsibilityId", "supervisionId"].flatMap(key =>
        typeof p[key] === "string" && ids.has(p[key]) ? [{ kind: key, id: p[key] }] : []);
      return refs.length ? [{ eventId: String(e.event_id), kind: String(e.kind), actorNodeId: text(e.actor_node_id),
        createdAt: String(e.created_at), refs, requiresAttention: /blocked|failed|uncertain|reconcil|escalat/.test(String(e.kind)) }] : [];
    }).slice(0, limit);
  return { worldId, readOnly: true as const, responsibilities, tasks, supervisions, recentProgress,
    truncated: rows.tasks.length > limit || rows.responsibilities.length > limit || rows.supervisions.length > limit,
    semantics: { source: "canonical_records" as const, hostAcceptanceIsCompletion: false as const,
      subjectivityIncluded: false as const, inspectionAuthorizesRetry: false as const } };
}
function boundLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new SideraError("conflict", "Inspection limit must be 1..200");
  return limit;
}

/** Compact, on-demand view over canonical records; never a materialized second truth. */
export function inspectWorld(db: DatabaseSync, caller: InspectionCaller, input: InspectionScope = {}) {
  const worldId = scope(db, caller, input.worldId), limit = boundLimit(input.limit), tasks = taskRows(db, worldId, caller);
  const nodes = db.prepare(`SELECT n.node_id,n.display_name,n.lifecycle FROM nodes n JOIN world_records w
    ON w.table_name='nodes' AND w.record_key=json_array(n.node_id) WHERE w.world_id=? ORDER BY n.created_at,n.rowid`)
    .all(worldId).slice(0, limit).map(n => ({ nodeId: String(n.node_id), ...readNodeOntology(db,String(n.node_id)), displayName: String(n.display_name), lifecycle: String(n.lifecycle),
      executors:executorPool(db,String(n.node_id),{sync:false}),
      conversations:db.prepare("SELECT conversation_ref AS conversationRef,frontend_kind AS frontendKind FROM communicator_conversations WHERE communicator_node_ref=?").all(String(n.node_id)),
      dispatchAuthority:caller.kind==="node"?humanRootedFor(db,caller.nodeId,worldId,{capability:"task.dispatch",resource:`node/${n.node_id}`}):"not_evaluated",
      returnAuthority:caller.kind==="node"?humanRootedFor(db,String(n.node_id),worldId,{capability:"message.send",resource:`node/${caller.nodeId}`}):"not_evaluated",
      sessions: db.prepare("SELECT session_id,hythe_id,host_kind,state FROM sessions WHERE node_id=? ORDER BY created_at")
        .all(String(n.node_id)).map(s => ({ sessionId: String(s.session_id), adapterId: String(s.hythe_id), hostKind: String(s.host_kind), state: String(s.state),
          health:{...readSessionHostCondition(db,String(s.session_id)),meaning:"time-scoped exact Host observation only; not Chat Presence"} })) }));
  return { ...render(db, worldId, { tasks, responsibilities: responsibilityRows(db, worldId, caller, tasks),
    supervisions: supervisionRows(db, worldId, caller) }, limit), nodes,
    console:{kind:"Console",isNode:false,sovereignty:false,decisionAuthority:"Human"},
    chiefConversations:db.prepare(`SELECT c.project_space_id FROM chief_conversations c JOIN world_records w
      ON w.table_name='nodes' AND w.record_key=json_array(c.chief_node_id) WHERE c.state='active' AND w.world_id=?`).all(worldId)
      .map(c=>chiefConversationRole(db,String(c.project_space_id))) };
}

/** Inspect one owned/participating work graph. No general SQL, logs, config or Memory access. */
export function inspectWork(db: DatabaseSync, caller: InspectionCaller, input: WorkSelection) {
  if ([input.taskId, input.responsibilityId, input.supervisionId].filter(Boolean).length !== 1)
    throw new SideraError("conflict", "Choose exactly one Task, Responsibility or Supervision");
  const worldId = scope(db, caller, input.worldId), limit = boundLimit(input.limit);
  let tasks = taskRows(db, worldId, caller), supervisions = supervisionRows(db, worldId, caller);
  let responsibilities = responsibilityRows(db, worldId, caller, tasks);
  if (input.taskId) {
    requireWorld(db, worldId, "tasks", input.taskId);
    tasks = tasks.filter(t => t.task_id === input.taskId);
    if (!tasks.length) throw new SideraError("denied", "Node is not a participant in this Task");
    const basis = db.prepare("SELECT responsibility_id FROM task_bases WHERE task_id=?").get(input.taskId);
    responsibilities = responsibilities.filter(r => r.responsibility_id === basis?.responsibility_id);
    const linked = db.prepare("SELECT supervision_id FROM supervision_tasks WHERE task_id=?").get(input.taskId);
    supervisions = supervisions.filter(s => s.supervision_id === linked?.supervision_id);
  } else if (input.responsibilityId) {
    requireWorld(db, worldId, "responsibilities", input.responsibilityId);
    responsibilities = responsibilities.filter(r => r.responsibility_id === input.responsibilityId);
    if (!responsibilities.length) throw new SideraError("denied", "Responsibility is outside this Node's work");
    tasks = tasks.filter(t => db.prepare("SELECT 1 FROM task_bases WHERE task_id=? AND responsibility_id=?")
      .get(String(t.task_id), input.responsibilityId!));
    supervisions = supervisions.filter(s => s.responsibility_id === input.responsibilityId);
  } else {
    const target = db.prepare("SELECT world_id FROM supervisions WHERE supervision_id=?").get(input.supervisionId!);
    if (!target) throw new SideraError("not_found", "Supervision was not found");
    if (target.world_id !== worldId) throw new SideraError("denied", "Cross-World inspection is not supported");
    supervisions = supervisions.filter(s => s.supervision_id === input.supervisionId);
    if (!supervisions.length) throw new SideraError("denied", "Supervision belongs to another supervising Node");
    tasks = tasks.filter(t => db.prepare("SELECT 1 FROM supervision_tasks WHERE task_id=? AND supervision_id=?")
      .get(String(t.task_id), input.supervisionId!));
    responsibilities = responsibilities.filter(r => r.responsibility_id === supervisions[0].responsibility_id);
  }
  return render(db, worldId, { tasks, responsibilities, supervisions }, limit);
}

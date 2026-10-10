import { randomUUID } from "node:crypto";
import { setResponsibilityBasis, type SemanticBasis } from "./semantics.ts";
import { recordWorld } from "./worlds.ts";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { consumeHumanAct } from "./human-admission.ts";

export type OrgActor = { kind: "human"; id: string; actId?: string } |
  { kind: "node"; nodeId: string; sessionId: string };
export type Role = "ChiefSupervisor" | "Supervisor" | "Worker" | "Reviewer";

export interface RoleAppointment {
  appointmentId: string;
  subjectNodeId: string;
  role: Role;
  scope: string;
  label: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface Responsibility {
  responsibilityId: string;
  title: string;
  scope: string;
  ownerNodeId: string;
  parentResponsibilityId: string | null;
  state: "active" | "waiting" | "completed" | "cancelled";
  deferredAt: string | null;
  deferredReason: string | null;
  createdAt: string;
  updatedAt: string;
  acceptance: "proposed" | "accepted";
}

export interface OrganizationEvent {
  eventId: string;
  actorNodeId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function nonempty(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim())
    throw new SideraError("conflict", `${name} is required`);
}

function activeNode(db: DatabaseSync, nodeId: string): void {
  if (!db.prepare("SELECT 1 FROM nodes WHERE node_id = ? AND lifecycle = 'active'").get(nodeId))
    throw new SideraError("not_found", "Node is unavailable");
}

function rowResponsibility(row: Record<string, unknown>): Responsibility {
  return {
    responsibilityId: String(row.responsibility_id), title: String(row.title),
    scope: String(row.scope), ownerNodeId: String(row.owner_node_id),
    parentResponsibilityId: row.parent_responsibility_id == null ? null :
      String(row.parent_responsibility_id),
    state: row.state === "active" && row.deferred_at != null ? "waiting" : String(row.state) as Responsibility["state"],
    deferredAt: row.deferred_at == null ? null : String(row.deferred_at),
    deferredReason: row.deferred_reason == null ? null : String(row.deferred_reason),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    acceptance: row.accepted_at == null ? "proposed" : "accepted",
  };
}

export function getResponsibility(db: DatabaseSync, responsibilityId: string): Responsibility {
  const row = db.prepare("SELECT * FROM responsibilities WHERE responsibility_id = ?")
    .get(responsibilityId) as Record<string, unknown> | undefined;
  if (!row) throw new SideraError("not_found", "Responsibility was not found");
  return rowResponsibility(row);
}

export function listResponsibilities(db: DatabaseSync, filter: {
  ownerNodeId?: string; state?: Responsibility["state"];
} = {}): Responsibility[] {
  return (db.prepare(`SELECT * FROM responsibilities
    WHERE (? IS NULL OR owner_node_id = ?) AND (? IS NULL OR
      CASE WHEN state = 'active' AND deferred_at IS NOT NULL THEN 'waiting' ELSE state END = ?)
    ORDER BY created_at, rowid`).all(
    filter.ownerNodeId ?? null, filter.ownerNodeId ?? null,
    filter.state ?? null, filter.state ?? null,
  ) as Record<string, unknown>[]).map(rowResponsibility);
}

/** Public scheduling decision. No self baseline permits a Node to defer a commitment. */
export function deferResponsibility(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; responsibilityId: string; reason: string;
}): Responsibility {
  return mutate(db, actor, "responsibility.defer", input.requestId, input, () => {
    nonempty(input.reason, "reason");
    const before = getResponsibility(db, input.responsibilityId);
    if (!["active", "waiting"].includes(before.state))
      throw new SideraError("conflict", "Responsibility is no longer pending");
    const reservation = authorize(db, actor, input.requestId, "responsibility.defer",
      `node/${before.ownerNodeId}/responsibilities/${before.responsibilityId}`);
    const now = new Date().toISOString();
    db.prepare("UPDATE responsibilities SET deferred_at = ?, deferred_reason = ?, updated_at = ? WHERE responsibility_id = ?")
      .run(now, input.reason, now, before.responsibilityId);
    emit(db, actor, "responsibility.deferred", { responsibilityId: before.responsibilityId,
      targetNodeId: before.ownerNodeId, reason: input.reason });
    if (reservation) settleReservation(db, reservation, "consumed");
    return getResponsibility(db, before.responsibilityId);
  });
}

/** Append a disposition to the original escalation; this grants no capability. */
export function deferEscalation(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; escalationId: string; reason: string;
}): { escalationId: string; disposition: "deferred" } {
  return mutate(db, actor, "escalation.defer", input.requestId, input, () => {
    nonempty(input.reason, "reason");
    const original = db.prepare("SELECT payload FROM events WHERE event_id = ? AND kind = 'escalation.raised'")
      .get(input.escalationId) as { payload: string } | undefined;
    if (!original) throw new SideraError("not_found", "Escalation was not found");
    const source = JSON.parse(original.payload) as { sourceNodeId: string };
    const reservation = authorize(db, actor, input.requestId, "escalation.defer", `event/${input.escalationId}`);
    emit(db, actor, "escalation.deferred", { escalationId: input.escalationId,
      targetNodeId: source.sourceNodeId, reason: input.reason, disposition: "deferred" });
    if (reservation) settleReservation(db, reservation, "consumed");
    return { escalationId: input.escalationId, disposition: "deferred" };
  });
}

export function listRoles(db: DatabaseSync, subjectNodeId: string): RoleAppointment[] {
  const rows = db.prepare(`SELECT * FROM role_appointments WHERE subject_node_id = ?
    AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid`)
    .all(subjectNodeId, new Date().toISOString()) as Record<string, unknown>[];
  return rows.map(row => ({ appointmentId: String(row.appointment_id),
    subjectNodeId: String(row.subject_node_id), role: String(row.role) as Role,
    scope: String(row.scope), label: row.label == null ? null : String(row.label),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    createdAt: String(row.created_at) }));
}

/** Durable event cursor; callers choose when to resume a responsible Node. */
export function listResponsibilityEvents(db: DatabaseSync, nodeId: string,
  afterEventId?: string, limit = 100): OrganizationEvent[] {
  const after = afterEventId == null ? 0 :
    (db.prepare("SELECT rowid AS position FROM events WHERE event_id = ?")
      .get(afterEventId) as { position: number } | undefined)?.position;
  if (after === undefined) throw new SideraError("not_found", "Event cursor was not found");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new SideraError("conflict", "Event limit is invalid");
  const rows = db.prepare(`SELECT * FROM events WHERE rowid > ?
    AND json_extract(payload, '$.targetNodeId') = ? ORDER BY rowid LIMIT ?`)
    .all(after, nodeId, limit) as Record<string, unknown>[];
  return rows.map(row => ({ eventId: String(row.event_id),
    actorNodeId: row.actor_node_id == null ? null : String(row.actor_node_id),
    kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    createdAt: String(row.created_at) }));
}

function canonical(value: unknown): string {
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
    return input;
  }
  return JSON.stringify(sorted(value));
}

function actorKey(actor: OrgActor): string {
  return actor.kind === "human" ? `human:${actor.id}` : `node:${actor.nodeId}`;
}

function emit(db: DatabaseSync, actor: OrgActor, kind: string,
  payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), actor.kind === "node" ? actor.nodeId : null,
      kind, JSON.stringify(payload), new Date().toISOString());
}

function authorize(db: DatabaseSync, actor: OrgActor, requestId: string,
  capability: string, resource: string): string | null {
  if (actor.kind === "human") return null;
  const permit = reserveCapability(db, { subjectNodeId: actor.nodeId,
    sessionId: actor.sessionId, requestId, capability, resource });
  return permit.reservationId;
}

function mutate<T>(db: DatabaseSync, actor: OrgActor, method: string, requestId: string,
  input: unknown, operation: () => T): T {
  nonempty(requestId, "requestId");
  return withTransaction(db, "organization_action", () => {
    const key = actorKey(actor);
    const inputJson = canonical(input);
    const previous = db.prepare(`SELECT method, input_json, result_json FROM organization_actions
      WHERE actor = ? AND request_id = ?`).get(key, requestId) as
      { method: string; input_json: string; result_json: string } | undefined;
    if (previous) {
      if (previous.method !== method || previous.input_json !== inputJson)
        throw new SideraError("conflict", "Request ID was already used for another action");
      return JSON.parse(previous.result_json) as T;
    }
    if(actor.kind==="human") {
      const target=humanOrganizationTarget(db,input as Record<string,unknown>);
      consumeHumanAct(db,actor,target.worldId,method,target.objectRef,target.scope,input);
    }
    const result = operation();
    db.prepare("INSERT INTO organization_actions VALUES (?, ?, ?, ?, ?)")
      .run(key, requestId, method, inputJson, JSON.stringify(result));
    return result;
  });
}

/** Exact Human mutation target, shared by trusted frontends and admission. */
export function humanOrganizationTarget(db:DatabaseSync,input:Record<string,unknown>) {
  if(input.responsibilityId) {
    const id=String(input.responsibilityId), r=getResponsibility(db,id);
    return {worldId:recordWorld(db,"responsibilities",id),objectRef:id,scope:r.scope};
  }
  if(input.escalationId) {
    const row=db.prepare("SELECT actor_node_id FROM events WHERE event_id=?").get(String(input.escalationId));
    if(!row?.actor_node_id)throw new SideraError("not_found","Escalation source is unknown");
    return {worldId:recordWorld(db,"nodes",String(row.actor_node_id)),objectRef:String(input.escalationId),scope:`event/${input.escalationId}`};
  }
  const node=String(input.ownerNodeId??input.subjectNodeId??"");
  return {worldId:recordWorld(db,"nodes",node),objectRef:node,scope:String(input.scope??`node/${node}`)};
}

export function appointRole(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; subjectNodeId: string; role: string; scope?: string;
  label?: string; expiresAt?: string;
}): RoleAppointment {
  return mutate(db, actor, "role.appoint", input.requestId, input, () => {
    activeNode(db, input.subjectNodeId);
    if (!["ChiefSupervisor", "Supervisor", "Worker", "Reviewer"].includes(input.role))
      throw new SideraError("conflict", "Role is invalid");
    const scope = input.scope ?? "*";
    nonempty(scope, "scope");
    if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) ||
        Date.parse(input.expiresAt) <= Date.now()))
      throw new SideraError("conflict", "Role expiration must be in the future");
    const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
    const reservation = authorize(db, actor, input.requestId, "role.appoint",
      `node/${input.subjectNodeId}`);
    const appointmentId = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO role_appointments VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(appointmentId, input.subjectNodeId, input.role, scope,
        input.label ?? null, expiresAt, now);
    emit(db, actor, "role.appointed", { appointmentId,
      targetNodeId: input.subjectNodeId, role: input.role, scope, label: input.label ?? null });
    if (reservation) settleReservation(db, reservation, "consumed");
    return { appointmentId, subjectNodeId: input.subjectNodeId, role: input.role as Role,
      scope, label: input.label ?? null, expiresAt, createdAt: now };
  });
}

export function createResponsibility(db: DatabaseSync, actor: OrgActor, input: {
  basis?: Omit<SemanticBasis, "responsibilityId">;
  requestId: string; title: string; scope: string; ownerNodeId: string;
  parentResponsibilityId?: string;
}): Responsibility {
  return mutate(db, actor, "responsibility.create", input.requestId, input, () => {
    nonempty(input.title, "title");
    nonempty(input.scope, "scope");
    activeNode(db, input.ownerNodeId);
    if (input.parentResponsibilityId) {
      const parent = getResponsibility(db, input.parentResponsibilityId);
      if (parent.state !== "active" || parent.acceptance !== "accepted")
        throw new SideraError("conflict", "Parent responsibility is inactive");
      if (actor.kind === "node" && parent.ownerNodeId !== actor.nodeId)
        throw new SideraError("denied", "Only the parent owner can create a child responsibility");
    }
    const own = actor.kind === "node" && actor.nodeId === input.ownerNodeId;
    const reservation = authorize(db, actor, input.requestId,
      own ? "self.responsibility.create" : "responsibility.create",
      own ? `node/${actor.nodeId}/responsibilities` : `node/${input.ownerNodeId}`);
    const responsibilityId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO responsibilities
      (responsibility_id,title,scope,owner_node_id,parent_responsibility_id,state,created_at,updated_at,accepted_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(responsibilityId, input.title, input.scope, input.ownerNodeId,
        input.parentResponsibilityId ?? null, now, now, own ? now : null);
    if (input.basis) setResponsibilityBasis(db, responsibilityId, input.basis);
    emit(db, actor, "responsibility.created", { responsibilityId,
      targetNodeId: input.ownerNodeId, ownerNodeId: input.ownerNodeId,
      parentResponsibilityId: input.parentResponsibilityId ?? null });
    if (reservation) settleReservation(db, reservation, "consumed");
    return getResponsibility(db, responsibilityId);
  });
}

/** Acceptance belongs to the intended owner; a proposal alone creates no commitment tension. */
export function acceptResponsibility(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; responsibilityId: string;
}): Responsibility {
  return mutate(db, actor, "responsibility.accept", input.requestId, input, () => {
    const before = getResponsibility(db, input.responsibilityId);
    if (actor.kind !== "node" || actor.nodeId !== before.ownerNodeId)
      throw new SideraError("denied", "Only the intended owner can accept a responsibility");
    if (!["active", "waiting"].includes(before.state) || before.acceptance !== "proposed")
      throw new SideraError("conflict", "Responsibility is not a pending proposal");
    authorize(db, actor, input.requestId, "self.responsibility.accept",
      `node/${actor.nodeId}/responsibilities/${before.responsibilityId}`);
    const now = new Date().toISOString();
    db.prepare("UPDATE responsibilities SET accepted_at = ?, updated_at = ? WHERE responsibility_id = ?")
      .run(now, now, before.responsibilityId);
    emit(db, actor, "responsibility.accepted", { responsibilityId: before.responsibilityId,
      targetNodeId: actor.nodeId });
    return getResponsibility(db, before.responsibilityId);
  });
}

export function transferResponsibility(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; responsibilityId: string; nextOwnerNodeId: string;
  expectedOwnerNodeId: string;
}): Responsibility {
  return mutate(db, actor, "responsibility.transfer", input.requestId, input, () => {
    const before = getResponsibility(db, input.responsibilityId);
    if (!["active", "waiting"].includes(before.state) || before.ownerNodeId !== input.expectedOwnerNodeId)
      throw new SideraError("conflict", "Responsibility owner or state changed");
    if (actor.kind === "node" && actor.nodeId !== before.ownerNodeId)
      throw new SideraError("denied", "Only the owner can hand off responsibility");
    if (input.nextOwnerNodeId === before.ownerNodeId)
      throw new SideraError("conflict", "Next owner must differ");
    activeNode(db, input.nextOwnerNodeId);
    const reservation = authorize(db, actor, input.requestId,
      "responsibility.transfer", `node/${input.nextOwnerNodeId}`);
    // Ownership transfer cannot cancel the Project Manager's scheduling constraint.
    db.prepare("UPDATE responsibilities SET owner_node_id = ?, updated_at = ?, accepted_at = NULL WHERE responsibility_id = ?")
      .run(input.nextOwnerNodeId, new Date().toISOString(), input.responsibilityId);
    emit(db, actor, "responsibility.reassigned", {
      responsibilityId: input.responsibilityId, previousOwnerNodeId: before.ownerNodeId,
      nextOwnerNodeId: input.nextOwnerNodeId, targetNodeId: input.nextOwnerNodeId });
    if (reservation) settleReservation(db, reservation, "consumed");
    return getResponsibility(db, input.responsibilityId);
  });
}

export type ResponsibilityClosureBasis =
  | { kind: "supervision-accept"; supervisionId: string; roundIndex: number }
  | { kind: "human-judgment"; reason: string };

/** C14: completion is a judgment with evidence, never an executor's done claim. */
function closureEvidence(db: DatabaseSync, actor: OrgActor, responsibility: Responsibility,
  basis: ResponsibilityClosureBasis | undefined): Record<string, unknown> {
  if (!basis) throw new SideraError("denied", "Responsibility closure requires an ACCEPT review or exact Human judgment");
  if (actor.kind === "human") {
    // mutate() has already consumed this exact admitted Human closure input in
    // the same transaction; this branch cannot turn a Node interpretation into it.
    if (basis.kind !== "human-judgment" || !actor.actId)
      throw new SideraError("denied", "Human closure requires its admitted judgment basis");
    nonempty(basis.reason, "Human closure reason");
    return { kind: basis.kind, reason: basis.reason, humanId: actor.id,
      evidenceRefs: [`human-act:${actor.actId}`] };
  }
  if (basis.kind !== "supervision-accept" || !basis.supervisionId || !Number.isSafeInteger(basis.roundIndex) || basis.roundIndex < 1)
    throw new SideraError("denied", "Node closure requires a specific supervised ACCEPT round");
  const proof = db.prepare(`SELECT s.world_id,s.chief_node_id,s.acceptance_criteria,
      d.reason,d.decided_by_node_id,r.task_id,r.result_message_id,run.run_id,source.host_ref
    FROM supervisions s
    JOIN supervision_rounds r ON r.supervision_id=s.supervision_id
    JOIN supervision_decisions d ON d.supervision_id=r.supervision_id AND d.round_index=r.round_index
    JOIN supervision_tasks st ON st.task_id=r.task_id AND st.supervision_id=s.supervision_id AND st.agent_node_id=r.agent_node_id
    JOIN tasks t ON t.task_id=r.task_id AND t.origin_node_id=s.chief_node_id AND t.center_node_id=r.agent_node_id
    JOIN task_bases tb ON tb.task_id=t.task_id AND tb.responsibility_id=s.responsibility_id
    JOIN messages m ON m.message_id=r.result_message_id AND m.task_id=t.task_id
      AND m.kind='result' AND m.from_node_id=r.agent_node_id AND m.to_node_id=s.chief_node_id
    JOIN task_runs run ON run.task_id=t.task_id AND m.request_id='result:'||run.run_id
    JOIN messages source ON source.message_id=run.message_id AND source.to_node_id=r.agent_node_id
    WHERE s.supervision_id=? AND s.responsibility_id=? AND s.chief_node_id=? AND s.state='completed'
      AND r.round_index=? AND r.state='decided' AND d.decision='ACCEPT' AND d.decided_by_node_id=s.chief_node_id
      AND t.state='completed' AND run.state='completed' AND run.turn_open=0
      AND source.host_ref IS NOT NULL AND length(trim(m.body))>0
      AND NOT EXISTS(SELECT 1 FROM supervision_rounds later WHERE later.supervision_id=s.supervision_id AND later.round_index>r.round_index)`)
    .get(basis.supervisionId, responsibility.responsibilityId, responsibility.ownerNodeId, basis.roundIndex);
  if (!proof || proof.world_id !== recordWorld(db, "responsibilities", responsibility.responsibilityId))
    throw new SideraError("denied", "Closure ACCEPT lacks matching Responsibility, owner and completed canonical result evidence");
  return { kind: basis.kind, supervisionId: basis.supervisionId, roundIndex: basis.roundIndex,
    supervisorNodeId: proof.chief_node_id, acceptanceCriteria: proof.acceptance_criteria, reason: proof.reason,
    taskId: proof.task_id, runId: proof.run_id, resultMessageId: proof.result_message_id, hostTurn: proof.host_ref,
    evidenceRefs: [`supervision:${basis.supervisionId}:round:${basis.roundIndex}:decision`,
      `task:${proof.task_id}`, `run:${proof.run_id}`, `message:${proof.result_message_id}`] };
}

export function completeResponsibility(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; responsibilityId: string; expectedOwnerNodeId: string;
  /** Optional for source compatibility only; absence is rejected at the boundary. */
  closureBasis?: ResponsibilityClosureBasis;
}): Responsibility {
  return mutate(db, actor, "responsibility.complete", input.requestId, input, () => {
    const before = getResponsibility(db, input.responsibilityId);
    if (before.state !== "active" || before.acceptance !== "accepted" || before.ownerNodeId !== input.expectedOwnerNodeId)
      throw new SideraError("conflict", "Responsibility owner or state changed");
    if (actor.kind === "node" && actor.nodeId !== before.ownerNodeId)
      throw new SideraError("denied", "Only the owner can complete responsibility");
    const closure = closureEvidence(db, actor, before, input.closureBasis);
    const reservation = authorize(db, actor, input.requestId,
      "self.responsibility.complete", `node/${before.ownerNodeId}/responsibilities/${before.responsibilityId}`);
    db.prepare("UPDATE responsibilities SET state = 'completed', updated_at = ? WHERE responsibility_id = ?")
      .run(new Date().toISOString(), input.responsibilityId);
    emit(db, actor, "responsibility.completed", { responsibilityId: input.responsibilityId,
      ownerNodeId: before.ownerNodeId, targetNodeId: before.ownerNodeId, closureBasis: closure });
    if (reservation) settleReservation(db, reservation, "consumed");
    return getResponsibility(db, input.responsibilityId);
  });
}

export function raiseEscalation(db: DatabaseSync, actor: OrgActor, input: {
  requestId: string; responsibilityId?: string; reason: string; details?: string;
}): OrganizationEvent {
  return mutate(db, actor, "escalation.raise", input.requestId, input, () => {
    nonempty(input.reason, "reason");
    if (actor.kind === "human")
      throw new SideraError("denied", "Escalation must originate from a Node");
    let targetNodeId: string | null = null;
    if (input.responsibilityId) {
      const responsibility = getResponsibility(db, input.responsibilityId);
      if (responsibility.ownerNodeId !== actor.nodeId)
        throw new SideraError("denied", "Node does not own this responsibility");
      let parentId = responsibility.parentResponsibilityId;
      while (parentId) {
        const parent = getResponsibility(db, parentId);
        if (parent.ownerNodeId !== actor.nodeId) {
          targetNodeId = parent.ownerNodeId;
          break;
        }
        parentId = parent.parentResponsibilityId;
      }
    }
    if (!targetNodeId) {
      const chief = db.prepare(`SELECT r.subject_node_id FROM role_appointments r
        JOIN nodes n ON n.node_id = r.subject_node_id
        WHERE r.role = 'ChiefSupervisor' AND r.subject_node_id != ?
          AND n.lifecycle = 'active'
          AND EXISTS (SELECT 1 FROM world_records w WHERE w.table_name='nodes' AND w.record_key=json_array(n.node_id) AND w.world_id=?)
          AND (r.expires_at IS NULL OR r.expires_at > ?)
        ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`)
        .get(actor.nodeId, recordWorld(db, "nodes", actor.nodeId), new Date().toISOString()) as
        { subject_node_id: string } | undefined;
      targetNodeId = chief?.subject_node_id ?? null;
    }
    const reservation = authorize(db, actor, input.requestId,
      "self.escalate", `node/${actor.nodeId}/escalations`);
    const eventId = randomUUID();
    const now = new Date().toISOString();
    const payload = { responsibilityId: input.responsibilityId ?? null,
      reason: input.reason, details: input.details ?? null,
      sourceNodeId: actor.nodeId, targetNodeId };
    db.prepare("INSERT INTO events VALUES (?, ?, 'escalation.raised', ?, ?)")
      .run(eventId, actor.nodeId, JSON.stringify(payload), now);
    if (reservation) settleReservation(db, reservation, "consumed");
    return { eventId, actorNodeId: actor.nodeId, kind: "escalation.raised", payload,
      createdAt: now };
  });
}

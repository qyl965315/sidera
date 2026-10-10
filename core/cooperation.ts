import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability } from "./authority.ts";
import { enqueueMessage, getMessage, type MessageRecord } from "./bus.ts";
import { withTransaction } from "./db.ts";
import { canonical } from "./human-admission.ts";
import { getResponsibility } from "./organization.ts";
import { SemanticStore, type SemanticBasis } from "./semantics.ts";
import { SideraError } from "./types.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { hasPendingStandaloneTurn } from "./continuations.ts";

export interface CooperationInput { requestId: string; goal: string; basis: SemanticBasis }
export interface CooperationReceipt {
  worldId: string; responsibilityId: string; messageId: string; targetSessionId: string;
  state: MessageRecord["state"]; eventId: string; replay: boolean; taskId: null;
}

function validInput(input: CooperationInput): CooperationInput {
  if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 200)
    throw new SideraError("conflict", "Cooperation requires a bounded requestId");
  if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 16000)
    throw new SideraError("conflict", "Cooperation requires a goal of 1..16000 characters");
  const basis = input.basis;
  if (!basis || typeof basis.responsibilityId !== "string" || !basis.responsibilityId.trim() ||
      typeof basis.intentRevisionId !== "string" || !basis.intentRevisionId.trim() ||
      !Array.isArray(basis.contextBasis) || basis.contextBasis.length > 64 ||
      basis.contextBasis.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 1024))
    throw new SideraError("conflict", "Cooperation requires an explicit bounded SemanticBasis");
  return { requestId: input.requestId, goal: input.goal.trim(), basis: { responsibilityId: basis.responsibilityId,
    intentRevisionId: basis.intentRevisionId, contextBasis: [...basis.contextBasis] } };
}

function receipt(db: DatabaseSync, eventId: string, worldId: string, responsibilityId: string,
  messageId: string, replay: boolean): CooperationReceipt {
  const message = getMessage(db, messageId);
  return { worldId, responsibilityId, messageId, targetSessionId: message.targetSessionId,
    state: message.state, eventId, replay, taskId: null };
}

function assertCurrentBasis(db: DatabaseSync, caller: { nodeId: string; sessionId: string }, basis: SemanticBasis): string {
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  if (!db.prepare(`SELECT 1 FROM sessions s JOIN nodes n USING(node_id)
    WHERE s.session_id=? AND s.node_id=? AND s.state='active' AND n.lifecycle='active'`).get(caller.sessionId, caller.nodeId))
    throw new SideraError("denied", "Cooperation requires the Node's exact active execution Session");
  requireWorld(db, worldId, "responsibilities", basis.responsibilityId);
  const responsibility = getResponsibility(db, basis.responsibilityId);
  if (responsibility.ownerNodeId !== caller.nodeId || responsibility.acceptance !== "accepted" || responsibility.state !== "active")
    throw new SideraError("denied", "Cooperation requires an accepted active Responsibility owned by the caller");
  const stored = db.prepare(`SELECT intent_revision_id,context_basis_json FROM responsibility_bases
    WHERE responsibility_id=? AND world_id=?`).get(basis.responsibilityId, worldId);
  if (!stored || stored.intent_revision_id !== basis.intentRevisionId ||
      canonical(JSON.parse(String(stored.context_basis_json))) !== canonical(basis.contextBasis))
    throw new SideraError("conflict", "Cooperation must preserve the exact Responsibility basis");
  const semantics = new SemanticStore(db, worldId), revision = semantics.revision(basis.intentRevisionId);
  const current = semantics.currentIntent(String(revision.intent_id));
  if (current.state !== "CURRENT" || current.candidates[0]?.revision_id !== basis.intentRevisionId)
    throw new SideraError("conflict", "Cooperation requires a current, unambiguous admitted Intent revision");
  return worldId;
}

/** Re-run inside the serialized Effect validation immediately before send. A
 * standalone message intentionally has no synthetic Run to supply its basis. */
export function assertCooperationBasis(db: DatabaseSync, messageId: string) {
  const message = getMessage(db, messageId);
  const source = db.prepare(`SELECT event_id,actor_node_id,payload FROM events WHERE kind='cooperation.started'
    AND json_extract(payload,'$.messageId')=?`).get(messageId);
  if (!source || message.kind !== "cooperation" || message.taskId !== null || message.fromNodeId !== message.toNodeId ||
      source.actor_node_id !== message.fromNodeId)
    throw new SideraError("denied", "Canonical standalone cooperation provenance is missing");
  const saved = JSON.parse(String(source.payload)) as { fingerprint: string; worldId: string; targetSessionId: string;
    targetNodeId: string; requestId: string; basis: SemanticBasis; bodyDigest?: string };
  const input = validInput(JSON.parse(saved.fingerprint) as CooperationInput);
  if (message.targetSessionId !== saved.targetSessionId || message.toNodeId !== saved.targetNodeId ||
      message.requestId !== saved.requestId || input.requestId !== saved.requestId || canonical(input.basis) !== canonical(saved.basis) ||
      !saved.bodyDigest || createHash("sha256").update(message.body).digest("hex") !== saved.bodyDigest)
    throw new SideraError("denied", "Cooperation message differs from its admitted exact intent");
  const worldId = assertCurrentBasis(db, { nodeId: message.fromNodeId, sessionId: message.targetSessionId }, input.basis);
  if (worldId !== saved.worldId) throw new SideraError("denied", "Cooperation World changed");
  return { eventId: String(source.event_id), worldId, basis: input.basis, bodyDigest: saved.bodyDigest };
}

/** A real subject receives the goal and chooses the work; Core does not choose workers,
 * acceptance decisions, models or a synthetic Task on its behalf. Delivery remains the
 * existing Bus/Effect path and is deliberately outside this synchronous admission. */
export function startCooperation(db: DatabaseSync, caller: { nodeId: string; sessionId: string }, raw: CooperationInput): CooperationReceipt {
  const input = validInput(raw), worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  if (!db.prepare(`SELECT 1 FROM sessions s JOIN nodes n USING(node_id)
    WHERE s.session_id=? AND s.node_id=? AND s.state='active' AND n.lifecycle='active'`).get(caller.sessionId, caller.nodeId))
    throw new SideraError("denied", "Cooperation requires the Node's exact active execution Session");
  const fingerprint = canonical(input);
  return withTransaction(db, "cooperation_start", () => {
    const prior = db.prepare(`SELECT event_id,payload FROM events WHERE actor_node_id=? AND kind='cooperation.started'
      AND json_extract(payload,'$.requestId')=?`).get(caller.nodeId, input.requestId);
    if (prior) {
      const saved = JSON.parse(String(prior.payload)) as { fingerprint: string; messageId: string; responsibilityId: string };
      if (saved.fingerprint !== fingerprint) throw new SideraError("conflict", "Cooperation requestId already names another intent");
      // Reading an old receipt does not resend, retarget after handoff, or renew Authority.
      return receipt(db, String(prior.event_id), worldId, saved.responsibilityId, saved.messageId, true);
    }
    if (db.prepare("SELECT 1 FROM messages WHERE from_node_id=? AND request_id=?").get(caller.nodeId, input.requestId))
      throw new SideraError("conflict", "RequestId is already used by another canonical message");
    assertCurrentBasis(db, caller, input.basis);
    if(db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state='uncertain')").get(caller.sessionId) ||
      hasPendingStandaloneTurn(db,caller.sessionId) || db.prepare("SELECT 1 FROM messages WHERE target_session_id=? AND kind='cooperation' AND state='queued'").get(caller.sessionId))
      throw new SideraError("unavailable","Supervisor Session already has an open or uncertain turn; await/reconcile that turn instead of starting another");
    const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
      requestId: input.requestId, capability: "self.task.resume", resource: `node/${caller.nodeId}/session/${caller.sessionId}` });
    const body = `SIDERA_COOPERATION_V1\n${JSON.stringify({ protocolVersion: 1, worldId, supervisorNodeId: caller.nodeId,
      requestId: input.requestId, goal: input.goal, basis: input.basis })}\n\n` +
      "You are the accountable Supervisor for this accepted Responsibility. The goal is work within the existing admitted Intent and Authority, not a new Human grant.\n" +
      "Use world_inspect and work_inspect to inspect actual Nodes, available adapters/capabilities and work state. Choose suitable workers and reviewers yourself; Human does not select models, effort, workers or concurrency. Capability presence never grants Authority.\n" +
      "Call supervision_open with this responsibilityId, your goal, explicit acceptance criteria and a reasonable bounded round count. Then call task_dispatch for your selected Node with supervisionId and the exact SemanticBasis above. Use fresh requestIds for genuinely new actions.\n" +
      "After dispatch, end your turn and wait for the canonical result event; do not poll, repeat dispatch, or ask Human to continue. On each result, inspect the actual work and call supervision_decide with your own judgment. CONTINUE/REWORK/RECONCILE require a self-contained next instruction; optional nextNodeId selects another worker/reviewer through the same canonical dispatch path. Core schedules that next round, so do not dispatch it twice.\n" +
      "Handle ordinary errors within the organization. Preserve uncertain effects for reconciliation; never resend them blindly. WAIT names a real dependency/event. Use ACCEPT only for evidenced acceptance, ESCALATE only when Human must decide, and STOP when the work should stop. Only the canonical supervised ACCEPT/ESCALATE path presents the outcome to the bound Human Chat. A plain 'done', Host acceptance, or tool admission is not final completion.\n" +
      "After evidenced ACCEPT, close your Responsibility with responsibility_complete and closureBasis={kind:'supervision-accept',supervisionId,roundIndex}. Do not close it merely because a Host accepted a message.\n" +
      "For ACCEPT/ESCALATE, put your self-contained final Human summary in reason, using your post-completion observations and preserving evidence limits. It is the canonical Human-facing output; the Worker draft is retained separately.\n" +
      "Keep D + Exp private. Do not create Human-visible Chats, use browser transport, copy internal messages through Human, mint permissions or change the admitted basis.";
    const message = enqueueMessage(db, { requestId: input.requestId, fromNodeId: caller.nodeId, toNodeId: caller.nodeId,
      targetSessionId: caller.sessionId, kind: "cooperation", body, reservationId: permit.reservationId });
    const eventId = randomUUID();
    db.prepare("INSERT INTO events VALUES (?,?,'cooperation.started',?,?)").run(eventId, caller.nodeId,
      JSON.stringify({ requestId: input.requestId, fingerprint, worldId, responsibilityId: input.basis.responsibilityId,
        basis: input.basis, messageId: message.messageId, targetNodeId: caller.nodeId, targetSessionId: message.targetSessionId,
        bodyDigest: createHash("sha256").update(message.body).digest("hex"),
        semanticSource: `intent_revision:${input.basis.intentRevisionId}`, dispatchByRealSupervisor: true }), new Date().toISOString());
    return receipt(db, eventId, worldId, input.basis.responsibilityId, message.messageId, false);
  });
}

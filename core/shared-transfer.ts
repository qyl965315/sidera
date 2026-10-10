import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { grantEffectiveNow, getGrant, reserveCapability, settleReservation } from "./authority.ts";
import { enqueueMessage, getMessage } from "./bus.ts";
import { withTransaction } from "./db.ts";
import { canonical } from "./human-admission.ts";
import { SemanticStore, type SemanticBasis } from "./semantics.ts";
import { SideraError } from "./types.ts";
import { recordWorld, requireWorld } from "./worlds.ts";

type Caller = { nodeId: string; sessionId: string };
export interface TransferSource { kind: "artifact" | "message"; id: string }
export interface ArtifactInput {
  requestId: string; taskId: string; runId?: string; reference: string; versionRef?: string;
  title?: string; sourceRefs?: TransferSource[];
  accessibility?: { status: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"; sourceRef?: string };
}
export interface ContextHandoffInput {
  requestId: string; targetNodeId: string; basis: SemanticBasis; purpose: string;
  selector: string; sourceRefs: TransferSource[]; disclosureGrantId?: string;
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function bounded(value: unknown, name: string, limit = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008]/.test(value))
    throw new SideraError("conflict", `${name} must be a bounded nonempty string`);
  return value;
}

export function migrateSharedTransfer(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_references (
    artifact_id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
    owner_node_id TEXT NOT NULL REFERENCES nodes(node_id),request_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),run_id TEXT REFERENCES task_runs(run_id),
    definition_json TEXT NOT NULL,provenance_json TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(owner_node_id,request_id));
    CREATE TABLE IF NOT EXISTS context_handoffs (
      handoff_id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      actor_node_id TEXT NOT NULL REFERENCES nodes(node_id),request_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL REFERENCES nodes(node_id),target_session_id TEXT NOT NULL REFERENCES sessions(session_id),
      message_id TEXT UNIQUE REFERENCES messages(message_id),manifest_json TEXT NOT NULL,
      disclosure_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(actor_node_id,request_id));`);
  for (const table of ["artifact_references", "context_handoffs"])
    for (const op of ["UPDATE", "DELETE"])
      db.exec(`CREATE TRIGGER IF NOT EXISTS retain_${table}_${op} BEFORE ${op} ON ${table}
        BEGIN SELECT RAISE(ABORT,'Shared transfer provenance is immutable'); END;`);
}

function callerWorld(db: DatabaseSync, caller: Caller): string {
  const world = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, world, "sessions", caller.sessionId);
  if (!db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND node_id=? AND state='active'").get(caller.sessionId, caller.nodeId))
    throw new SideraError("denied", "Shared transfer requires the exact active caller Session");
  return world;
}
function participant(db: DatabaseSync, world: string, caller: Caller, taskId: string): void {
  requireWorld(db, world, "tasks", taskId);
  const task = db.prepare("SELECT origin_node_id,center_node_id,worker_node_ids FROM tasks WHERE task_id=?").get(taskId)!;
  if (task.origin_node_id !== caller.nodeId && task.center_node_id !== caller.nodeId &&
      !(JSON.parse(String(task.worker_node_ids)) as string[]).includes(caller.nodeId))
    throw new SideraError("denied", "Source Task is outside this Node's work");
}
function artifact(db: DatabaseSync, world: string, caller: Caller, id: string) {
  const row = db.prepare("SELECT * FROM artifact_references WHERE artifact_id=? AND world_id=?").get(id, world);
  if (!row) throw new SideraError("not_found", "ArtifactReference was not found in this World");
  participant(db, world, caller, String(row.task_id));
  return { artifactId: id, ownerNodeId: String(row.owner_node_id), taskId: String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    definition: JSON.parse(String(row.definition_json)), provenance: JSON.parse(String(row.provenance_json)), createdAt: String(row.created_at) };
}
function sources(db: DatabaseSync, world: string, caller: Caller, refs: TransferSource[]) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 16) throw new SideraError("conflict", "Select 1..16 exact source references");
  const seen = new Set<string>();
  return refs.map(ref => {
    if (!ref || typeof ref !== "object") throw new SideraError("conflict", "An exact source reference is required");
    const key = `${ref.kind}:${bounded(ref.id, "source id", 200)}`;
    if (seen.has(key)) throw new SideraError("conflict", "Duplicate selected source");
    seen.add(key);
    if (ref.kind === "artifact") {
      const data = artifact(db, world, caller, ref.id);
      return { ...ref, revision: digest(data), access: "reference_metadata_only_no_content_fetch" as const, data };
    }
    if (ref.kind !== "message") throw new SideraError("conflict", "Only canonical messages and registered ArtifactReferences may be selected");
    requireWorld(db, world, "messages", ref.id);
    const message = getMessage(db, ref.id);
    if (message.fromNodeId !== caller.nodeId && message.toNodeId !== caller.nodeId) {
      if (!message.taskId) throw new SideraError("denied", "Message is outside the caller's observations");
      participant(db, world, caller, message.taskId);
    }
    // Explicit selected content only. No wakeContext, Memory, Host history or raw logs.
    const data = { messageId: message.messageId, taskId: message.taskId, fromNodeId: message.fromNodeId,
      toNodeId: message.toNodeId, targetSessionId: message.targetSessionId, kind: message.kind, body: message.body };
    return { ...ref, revision: digest(data), access: "selected_canonical_message_content" as const, data };
  });
}

/** Registration stores a reference, not a file copy or an assertion that the bytes were verified. */
export function registerArtifact(db: DatabaseSync, caller: Caller, input: ArtifactInput) {
  const world = callerWorld(db, caller);
  bounded(input.requestId, "requestId", 200); bounded(input.reference, "reference", 4096);
  if (input.title != null) bounded(input.title, "title");
  if (input.versionRef != null) bounded(input.versionRef, "versionRef");
  if (input.accessibility && !["AVAILABLE", "UNAVAILABLE", "UNKNOWN"].includes(input.accessibility.status))
    throw new SideraError("conflict", "Invalid accessibility claim");
  if (/^[a-z]+:\/\/[^/]*@/i.test(input.reference)) throw new SideraError("denied", "Credential-bearing references are not ArtifactReferences");
  participant(db, world, caller, input.taskId);
  if (input.runId) {
    requireWorld(db, world, "task_runs", input.runId);
    const run = db.prepare("SELECT task_id,session_id FROM task_runs WHERE run_id=?").get(input.runId);
    if (run?.task_id !== input.taskId || run.session_id !== caller.sessionId)
      throw new SideraError("denied", "Artifact producing Run must belong to the exact caller Session and Task");
  }
  const selected = input.sourceRefs?.length ? sources(db, world, caller, input.sourceRefs) : [];
  const definition = { reference: input.reference, versionRef: input.versionRef ?? null, title: input.title ?? null,
    sourceRefs: input.sourceRefs ?? [], accessibility: { status: input.accessibility?.status ?? "UNKNOWN",
      evidenceClass: "NODE_CLAIM", sourceRef: input.accessibility?.sourceRef ?? null },
    contentVerified: false, referenceOnly: true };
  return withTransaction(db, "artifact_register", () => {
    const prior = db.prepare("SELECT artifact_id,task_id,run_id,definition_json FROM artifact_references WHERE owner_node_id=? AND request_id=?")
      .get(caller.nodeId, input.requestId);
    if (prior) {
      if (prior.task_id !== input.taskId || (prior.run_id ?? null) !== (input.runId ?? null) || prior.definition_json !== canonical(definition))
        throw new SideraError("conflict", "Artifact requestId already names another reference");
      return { ...artifact(db, world, caller, String(prior.artifact_id)), replay: true };
    }
    const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId, requestId: input.requestId,
      capability: "self.artifact.register", resource: `node/${caller.nodeId}/artifacts` });
    const run = input.runId ? db.prepare(`SELECT r.session_id,r.message_id,m.host_ref FROM task_runs r
      JOIN messages m USING(message_id) WHERE r.run_id=?`).get(input.runId) : null;
    const provenance = { sourceNodeId: caller.nodeId, sourceSessionId: caller.sessionId, taskId: input.taskId,
      runId: input.runId ?? null, messageId: run?.message_id ?? null, hostTurnRef: run?.host_ref ?? null,
      sourceVersions: selected.map(s => ({ kind: s.kind, id: s.id, revision: s.revision })),
      lineageKnowledge: selected.length ? "DECLARED_REFERENCED_SOURCES" : "UNKNOWN",
      officialProductParticipation: run?.host_ref ? "CORRELATED_HOST_REFERENCE_NOT_ARTIFACT_VERIFICATION" : "UNKNOWN" };
    const id = randomUUID();
    db.prepare("INSERT INTO artifact_references VALUES (?,?,?,?,?,?,?,?,?)").run(id, world, caller.nodeId, input.requestId,
      input.taskId, input.runId ?? null, canonical(definition), canonical(provenance), new Date().toISOString());
    if (permit.reservationId) settleReservation(db, permit.reservationId, "consumed");
    return { ...artifact(db, world, caller, id), replay: false };
  });
}

/** Reading a reference does not fetch its external bytes or assert current accessibility. */
export function getArtifactReference(db: DatabaseSync, caller: Caller, artifactId: string) {
  return artifact(db, callerWorld(db, caller), caller, bounded(artifactId, "artifactId", 200));
}

/** A pure preview suitable for an existing Human grant review. It grants nothing. */
export function previewContextHandoff(db: DatabaseSync, caller: Caller, input: ContextHandoffInput) {
  const worldId = callerWorld(db, caller);
  bounded(input.requestId, "requestId", 200); bounded(input.purpose, "purpose", 4000); bounded(input.selector, "selector", 4000);
  requireWorld(db, worldId, "nodes", input.targetNodeId);
  if (!input.basis || !Array.isArray(input.basis.contextBasis) || input.basis.contextBasis.some(v => typeof v !== "string" || !v.trim()))
    throw new SideraError("conflict", "Context Handoff requires an explicit SemanticBasis");
  requireWorld(db, worldId, "responsibilities", input.basis.responsibilityId);
  const store = new SemanticStore(db, worldId), revision = store.revision(input.basis.intentRevisionId);
  const responsible = db.prepare(`SELECT r.owner_node_id,i.intent_id FROM responsibilities r JOIN responsibility_bases b USING(responsibility_id)
    JOIN intent_revisions i ON i.revision_id=b.intent_revision_id WHERE r.responsibility_id=?`).get(input.basis.responsibilityId);
  if (responsible?.intent_id !== revision.intent_id) throw new SideraError("conflict", "Handoff basis must belong to the Responsibility Intent lineage");
  const involved = responsible.owner_node_id === caller.nodeId || db.prepare(`SELECT 1 FROM task_bases b JOIN tasks t USING(task_id)
    WHERE b.responsibility_id=? AND (t.origin_node_id=? OR t.center_node_id=? OR EXISTS(SELECT 1 FROM json_each(t.worker_node_ids) WHERE value=?))`)
    .get(input.basis.responsibilityId, caller.nodeId, caller.nodeId, caller.nodeId);
  if (!involved) throw new SideraError("denied", "Handoff Responsibility is outside this Node's work");
  const current = store.currentIntent(String(revision.intent_id));
  if (current.state !== "CURRENT" || current.candidates[0]?.revision_id !== input.basis.intentRevisionId)
    throw new SideraError("conflict", "Handoff requires current unambiguous Intent basis");
  const target = db.prepare("SELECT * FROM sessions WHERE node_id=? AND state='active'").get(input.targetNodeId);
  if (!target) throw new SideraError("unavailable", "Target has no active exact Session");
  const account = db.prepare("SELECT identity_id,knowledge FROM presence_accounts WHERE world_id=? AND session_id=?").get(worldId, target.session_id);
  const selected = sources(db, worldId, caller, input.sourceRefs);
  const envelope = { protocol: "SIDERA_CONTEXT_HANDOFF_V1", worldId, requestId: input.requestId,
    sourceNodeId: caller.nodeId, sourceSessionId: caller.sessionId, selectorSubject: caller.nodeId,
    selector: input.selector, purpose: input.purpose, basis: input.basis,
    target: { nodeId: input.targetNodeId, sessionId: String(target.session_id), product: String(target.host_kind),
      locatorDigest: digest(target.locator_ref), externalIdentityId: account?.identity_id ?? null,
      identityKnowledge: String(account?.knowledge ?? "UNKNOWN") }, sources: selected,
    constraints: ["Transformation is not declassification", "Artifact references do not grant content-fetch access",
      "Unknown source lineage remains UNKNOWN; exact Human scope is an independent disclosure basis"] };
  return { envelope, envelopeId: digest(envelope), requiredDisclosureScope: `SIDERA_DISCLOSURE_V1:${canonical(envelope)}` };
}

type DisclosureDecision = { status: "ALLOWED" | "DENIED" | "UNKNOWN"; reason: string; grantId: string | null; evidenceRef: string | null };
function disclosure(db: DatabaseSync, caller: Caller, preview: ReturnType<typeof previewContextHandoff>, grantId?: string): DisclosureDecision {
  const grant = grantId ? getGrant(db, grantId) : null;
  const provenance = grantId ? db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(grantId) : null;
  const base = { grantId: grantId ?? null, evidenceRef: provenance ? `human-act:${provenance.human_act_id}` : null };
  if (!grant || !provenance) return { ...base, status: "UNKNOWN", reason: "No existing exact Human-rooted disclosure scope" };
  if (grant.subjectNodeId !== caller.nodeId || !grantEffectiveNow(db,grant,`node/${preview.envelope.target.nodeId}`))
    return { ...base, status: "DENIED", reason: "Disclosure basis is not effective for this source subject" };
  if (![preview.envelope.target.product, "*"].includes(String(provenance.product_scope)))
    return { ...base, status: "DENIED", reason: "Recipient product is outside disclosure basis" };
  if (provenance.disclosure_scope === "UNKNOWN" || provenance.disclosure_scope === "handoff_bounded")
    return { ...base, status: "UNKNOWN", reason: "Legacy disclosure label does not bind selected source versions or recipient" };
  if (provenance.disclosure_scope !== preview.requiredDisclosureScope)
    return { ...base, status: "DENIED", reason: "Materialized content, source versions, purpose or recipient differ from admitted disclosure scope" };
  if (preview.envelope.target.identityKnowledge === "UNKNOWN")
    return { ...base, status: "UNKNOWN", reason: "Final recipient ExternalIdentity is unknown" };
  return { ...base, status: "ALLOWED", reason: "Exact materialization envelope covered by existing Human-rooted disclosure scope" };
}
const handoffBody = (handoffId: string, preview: ReturnType<typeof previewContextHandoff>) =>
  `SIDERA_CONTEXT_HANDOFF_V1\n${canonical({ handoffId, envelopeId: preview.envelopeId, envelope: preview.envelope })}`;

export function createContextHandoff(db: DatabaseSync, caller: Caller, input: ContextHandoffInput) {
  const worldId = callerWorld(db, caller), fingerprint = canonical(input);
  return withTransaction(db, "context_handoff", () => {
    const prior = db.prepare("SELECT handoff_id,manifest_json FROM context_handoffs WHERE actor_node_id=? AND request_id=?").get(caller.nodeId, input.requestId);
    if (prior) {
      if (JSON.parse(String(prior.manifest_json)).fingerprint !== fingerprint) throw new SideraError("conflict", "Handoff requestId already names another envelope");
      return { ...getContextHandoff(db, caller, String(prior.handoff_id)), replay: true };
    }
    const preview = previewContextHandoff(db, caller, input), decision = disclosure(db, caller, preview, input.disclosureGrantId);
    const id = randomUUID();
    let messageId: string | null = null;
    if (decision.status === "ALLOWED") {
      // CanAct is checked independently; ALLOWED disclosure itself grants no action.
      const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
        capability: "message.send", resource: `node/${input.targetNodeId}`, requestId: input.requestId });
      messageId = enqueueMessage(db, { requestId: input.requestId, fromNodeId: caller.nodeId, toNodeId: input.targetNodeId,
        targetSessionId: preview.envelope.target.sessionId, kind: "context-handoff", body: handoffBody(id, preview),
        reservationId: permit.reservationId }).messageId;
    }
    db.prepare("INSERT INTO context_handoffs VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, worldId, caller.nodeId, input.requestId,
      input.targetNodeId, preview.envelope.target.sessionId, messageId,
      canonical({ fingerprint, input, caller, ...preview }), canonical(decision), new Date().toISOString());
    return { ...getContextHandoff(db, caller, id), replay: false };
  });
}

/** Invoke at the actual Bus send boundary, not only at manifest creation. */
export function assertContextHandoffDisclosure(db: DatabaseSync, messageId: string) {
  const row = db.prepare("SELECT * FROM context_handoffs WHERE message_id=?").get(messageId);
  if (!row) throw new SideraError("denied", "Canonical Context Handoff manifest is missing");
  const saved = JSON.parse(String(row.manifest_json)) as { input: ContextHandoffInput; caller: Caller; envelopeId: string };
  const preview = previewContextHandoff(db, saved.caller, saved.input), decision = disclosure(db, saved.caller, preview, saved.input.disclosureGrantId);
  const message = getMessage(db, messageId);
  if (decision.status !== "ALLOWED" || preview.envelopeId !== saved.envelopeId || message.kind !== "context-handoff" ||
      message.fromNodeId !== saved.caller.nodeId || message.toNodeId !== preview.envelope.target.nodeId ||
      message.targetSessionId !== preview.envelope.target.sessionId || message.body !== handoffBody(String(row.handoff_id), preview))
    throw new SideraError("denied", `Final disclosure revalidation failed: ${decision.reason}`);
  return { handoffId: String(row.handoff_id), envelopeId: preview.envelopeId, decision,
    authorityEpoch: Number(db.prepare("SELECT epoch FROM authority_epochs WHERE world_id=?").get(row.world_id)!.epoch),
    policyEpoch: Number(db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(row.world_id)!.epoch) };
}

export function getContextHandoff(db: DatabaseSync, caller: Caller, handoffId: string) {
  const worldId = callerWorld(db, caller), row = db.prepare("SELECT * FROM context_handoffs WHERE handoff_id=? AND world_id=?").get(handoffId, worldId);
  if (!row) throw new SideraError("not_found", "Context Handoff was not found in this World");
  if (row.actor_node_id !== caller.nodeId && row.target_node_id !== caller.nodeId)
    throw new SideraError("denied", "Context Handoff belongs to other subjects");
  const saved = JSON.parse(String(row.manifest_json)), decision = JSON.parse(String(row.disclosure_json)) as DisclosureDecision;
  const message = row.message_id ? getMessage(db, String(row.message_id)) : null;
  if (row.actor_node_id !== caller.nodeId && !["delivered", "observed"].includes(message?.state ?? ""))
    throw new SideraError("denied", "Undelivered selection metadata has not been disclosed to this target");
  const created = true, delivered = message?.state === "delivered" || message?.state === "observed", observed = message?.state === "observed";
  return { handoffId, worldId, sourceNodeId: String(row.actor_node_id), targetNodeId: String(row.target_node_id),
    targetSessionId: String(row.target_session_id), messageId: message?.messageId ?? null,
    basis: saved.input.basis as SemanticBasis, sourceRefs: saved.input.sourceRefs as TransferSource[], envelopeId: String(saved.envelopeId),
    disclosure: decision, disclosureCheckedAt: String(row.created_at), finalGateRequired: true,
    state: !message ? "BLOCKED" : observed ? "OBSERVED" : delivered ? "DELIVERED" : message.state === "uncertain" ? "UNCERTAIN" : "CREATED",
    created, delivered, observed, transportState: message?.state ?? null, hostAccepted: message?.hostRef != null,
    observationMeans: "Exact canonical message ACK; not interpretation, acceptance or Responsibility completion",
    createdAt: String(row.created_at), replayAuthorized: false };
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { recordWorld, requireWorld, scopeNewNode } from "./worlds.ts";
import { SideraError } from "./types.ts";
import { consumeHumanAct, type HumanActProof } from "./human-admission.ts";
import { initializeNodeSovereignty } from "./sovereignty-store.ts";

const now = () => new Date().toISOString();
export interface SemanticBasis { responsibilityId: string; intentRevisionId: string; contextBasis: string[] }
export function sameBasis(a: SemanticBasis | undefined, b: SemanticBasis | undefined): boolean {
  const key = (basis: SemanticBasis | undefined) => basis ? JSON.stringify([basis.responsibilityId, basis.intentRevisionId, basis.contextBasis]) : null;
  return key(a) === key(b);
}
type BasisRow = { world_id: string; responsibility_id: string | null; intent_revision_id: string | null; context_basis_json: string; provenance: string };

/** Trusted Core storage, deliberately not an Agent-callable HumanSemanticAct admission API. */
export class SemanticStore {
  readonly db: DatabaseSync;
  readonly worldId: string;
  constructor(db: DatabaseSync, worldId: string) {
    if (!db.prepare("SELECT 1 FROM sidera_worlds WHERE world_id=?").get(worldId)) throw new SideraError("not_found", "World not found");
    this.db = db; this.worldId = worldId;
  }
  createHuman(label: string, provenance: string): string {
    return withTransaction(this.db, "human_create", () => {
      const id = randomUUID();
      this.db.prepare("INSERT INTO human_principals VALUES (?,?,?,?)").run(id, label, provenance, now());
      this.db.prepare("INSERT INTO world_humans VALUES (?,?,?)").run(this.worldId, id, provenance);
      return id;
    });
  }
  /** Trusted registration, not a bypass around the Registry's Agent Authority API. */
  registerNode(label: string): string {
    return withTransaction(this.db, "world_node_registration", () => {
      const id = randomUUID();
      scopeNewNode(this.db, this.worldId, id);
      this.db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id, label, now());
      initializeNodeSovereignty(this.db, id);
      return id;
    });
  }
  addExternalIdentity(humanId: string, provider: string, externalSubjectRef: string, provenance: string, id: string = randomUUID()): string {
    this.db.prepare("INSERT INTO external_identities VALUES (?,?,?,?,?,?,'active',?)")
      .run(id, this.worldId, humanId, provider, externalSubjectRef, provenance, now());
    return id;
  }
  setIdentityState(identityId: string, state: "active" | "suspended" | "unavailable" | "lost"): void {
    this.get("external_identities", "identity_id", identityId);
    this.db.prepare("UPDATE external_identities SET state=? WHERE identity_id=? AND world_id=?").run(state, identityId, this.worldId);
  }
  recordEntitlement(identityId: string, rule: Record<string, unknown>, sourceRef: string, validFrom: string, validUntil: string | null = null): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO entitlements VALUES (?,?,?,?,?,?,?)").run(id, this.worldId, identityId, JSON.stringify(rule), sourceRef, validFrom, validUntil);
    return id;
  }
  observeResource(entitlementId: string, observation: { knowledge: "KNOWN" | "UNKNOWN"; value: unknown; sourceRef: string; observedAt: string; freshUntil: string | null }): string {
    if (observation.knowledge === "UNKNOWN" && observation.value !== null) throw new SideraError("conflict", "UNKNOWN has no invented resource value");
    const id = randomUUID();
    this.db.prepare("INSERT INTO resource_observations VALUES (?,?,?,?,?,?,?,?)").run(id, this.worldId, entitlementId,
      observation.knowledge, observation.value === null ? null : JSON.stringify(observation.value), observation.sourceRef, observation.observedAt, observation.freshUntil);
    return id;
  }
  assessFeasibility(actionId: string, executable: "true" | "false" | "unknown", sourceRef: string, freshUntil: string | null = null): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO feasibility_assessments VALUES (?,?,?,?,?,?,?)").run(id, this.worldId, actionId, executable, sourceRef, now(), freshUntil);
    return id;
  }
  entitlement(id: string) { return this.get("entitlements", "entitlement_id", id); }
  resourceObservation(id: string, at = Date.now()): Record<string, unknown> & { freshness: string } {
    const observation = this.get("resource_observations", "observation_id", id);
    const until = observation.fresh_until == null ? NaN : Date.parse(String(observation.fresh_until));
    return { ...observation, freshness: !Number.isFinite(until) ? "UNKNOWN" : until > at ? "FRESH" : "STALE" };
  }
  feasibility(id: string) { return this.get("feasibility_assessments", "assessment_id", id); }
  createIntent(humanId: string, provenance: string, id: string = randomUUID()): string {
    this.db.prepare("INSERT INTO intents VALUES (?,?,?,?)").run(id, this.worldId, humanId, provenance);
    return id;
  }
  /** Caller supplies the causal parent; concurrent children are both retained. */
  reviseIntent(intentId: string, parentRevisionId: string | null, content: string, sourceRef: string, proof?:HumanActProof): string {
    return withTransaction(this.db,"intent_revision",()=>{
      const intent=this.get("intents", "intent_id", intentId);
      if(!proof || proof.id!==intent.human_id)throw new SideraError("denied","Intent revision requires its Human's admitted act");
      consumeHumanAct(this.db,proof,this.worldId,"intent.revise",intentId,`intent/${intentId}`,
        {intentId,parentRevisionId,content,sourceRef});
      const id = randomUUID();
      this.db.prepare("INSERT INTO intent_revisions VALUES (?,?,?,?,?,?,?)").run(id, this.worldId, intentId, parentRevisionId, content, sourceRef, now());
      return id;
    });
  }
  revision(revisionId: string) { return this.get("intent_revisions", "revision_id", revisionId); }
  currentIntent(intentId: string) {
    this.get("intents", "intent_id", intentId);
    const candidates = this.db.prepare(`SELECT r.* FROM intent_revisions r WHERE r.world_id=? AND r.intent_id=?
      AND NOT EXISTS(SELECT 1 FROM intent_revisions child WHERE child.parent_revision_id=r.revision_id)
      ORDER BY r.revision_id`).all(this.worldId, intentId);
    return { state: candidates.length === 0 ? "UNKNOWN" : candidates.length === 1 ? "CURRENT" : "CONFLICT", candidates };
  }
  runBasis(runId: string) {
    requireWorld(this.db, this.worldId, "task_runs", runId);
    const basis = this.db.prepare("SELECT * FROM run_bases WHERE run_id=? AND world_id=?").get(runId, this.worldId) as BasisRow;
    if (!basis?.intent_revision_id) return { ...basis, currency: "UNKNOWN", stale: null, intentConflict: null };
    const revision = this.revision(basis.intent_revision_id);
    const current = this.currentIntent(String(revision.intent_id));
    const currency = current.state === "CONFLICT" ? "CONFLICT" : current.candidates.some(r => r.revision_id === basis.intent_revision_id) ? "CURRENT" : "STALE";
    return { ...basis, currency, stale: !current.candidates.some(r => r.revision_id === basis.intent_revision_id),
      intentConflict: current.state === "CONFLICT", currentCandidates: current.candidates.map(r => r.revision_id) };
  }
  logicalAction(actorNodeId: string, targetNodeId: string, operation: string, semanticRef: string): string {
    requireWorld(this.db, this.worldId, "nodes", actorNodeId);
    requireWorld(this.db, this.worldId, "nodes", targetNodeId);
    const id = randomUUID();
    this.db.prepare("INSERT INTO logical_actions VALUES (?,?,?,?,?,?,?,?)").run(id, this.worldId, actorNodeId, targetNodeId, operation, semanticRef, "explicit_logical_action", now());
    return id;
  }
  /** Metadata allocation only. It grants no permission to send or retry. */
  attempt(actionId: string, targetSessionId: string, messageId: string | null = null): string {
    return withTransaction(this.db, "attempt_metadata", () => {
      this.get("logical_actions", "action_id", actionId);
      requireWorld(this.db, this.worldId, "sessions", targetSessionId);
      const session = this.db.prepare("SELECT host_kind,locator_ref FROM sessions WHERE session_id=?").get(targetSessionId)!;
      if (messageId) {
        const mapping = this.db.prepare("SELECT action_id FROM message_actions WHERE message_id=? AND world_id=?").get(messageId, this.worldId);
        if (mapping?.action_id !== actionId) throw new SideraError("conflict", "Attempt must refer to its original logical action");
      }
      const generation = Number(this.db.prepare("SELECT coalesce(max(generation),0)+1 AS next FROM action_attempts WHERE action_id=?").get(actionId)!.next);
      const id = randomUUID();
      this.db.prepare("INSERT INTO action_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, this.worldId, actionId, generation, randomUUID(), targetSessionId,
        session.host_kind, session.locator_ref, messageId, "execution_metadata_only; no send permit or fence enforcement", now());
      return id;
    });
  }
  action(actionId: string) {
    const action = this.get("logical_actions", "action_id", actionId);
    return { action, attempts: this.db.prepare("SELECT * FROM action_attempts WHERE world_id=? AND action_id=? ORDER BY generation").all(this.worldId, actionId) };
  }
  private get(table: string, key: string, id: string) {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=? AND world_id=?`).get(id, this.worldId);
    if (!row) throw new SideraError("not_found", "Semantic record not found in this World");
    return row;
  }
}

export function setResponsibilityBasis(db: DatabaseSync, responsibilityId: string, basis: Omit<SemanticBasis, "responsibilityId">): void {
  const world = recordWorld(db, "responsibilities", responsibilityId);
  new SemanticStore(db, world).revision(basis.intentRevisionId);
  validateContext(basis.contextBasis);
  const changed = db.prepare(`UPDATE responsibility_bases SET intent_revision_id=?,context_basis_json=?,provenance='explicit_basis_at_creation'
    WHERE responsibility_id=? AND provenance='compatibility_call: basis UNKNOWN'`).run(basis.intentRevisionId, JSON.stringify(basis.contextBasis), responsibilityId);
  if (!changed.changes) throw new SideraError("conflict", "Responsibility basis already recorded");
}
function validateContext(refs: string[]) {
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== "string" || !ref.trim())) throw new SideraError("conflict", "Context basis must contain explicit references");
}
export function setTaskBasis(db: DatabaseSync, taskId: string, basis?: SemanticBasis): void {
  if (!basis) return; // Explicit compatibility UNKNOWN, never inferred from prompt text.
  const world = recordWorld(db, "tasks", taskId);
  requireWorld(db, world, "responsibilities", basis.responsibilityId);
  const revision = new SemanticStore(db, world).revision(basis.intentRevisionId);
  const responsibility = db.prepare(`SELECT i.intent_id FROM responsibility_bases b JOIN intent_revisions i ON i.revision_id=b.intent_revision_id
    WHERE b.responsibility_id=? AND b.world_id=?`).get(basis.responsibilityId, world);
  if (!responsibility || responsibility.intent_id !== revision.intent_id) throw new SideraError("conflict", "Run basis must belong to Responsibility's Intent lineage");
  validateContext(basis.contextBasis);
  const changed = db.prepare(`UPDATE task_bases SET responsibility_id=?,intent_revision_id=?,context_basis_json=?,provenance='explicit_dispatch_basis'
    WHERE task_id=? AND provenance='compatibility_call: basis UNKNOWN' AND NOT EXISTS(SELECT 1 FROM task_runs WHERE task_id=?)`)
    .run(basis.responsibilityId, basis.intentRevisionId, JSON.stringify(basis.contextBasis), taskId, taskId);
  if (!changed.changes) throw new SideraError("conflict", "Task basis already recorded");
}
export function taskBasis(db: DatabaseSync, taskId: string): SemanticBasis | undefined {
  const row = db.prepare("SELECT * FROM task_bases WHERE task_id=?").get(taskId) as BasisRow | undefined;
  return row?.responsibility_id && row.intent_revision_id ? { responsibilityId: row.responsibility_id, intentRevisionId: row.intent_revision_id, contextBasis: JSON.parse(row.context_basis_json) } : undefined;
}
export function ensureMessageAction(db: DatabaseSync, messageId: string, existingActionId?: string): string {
  const prior = db.prepare("SELECT action_id FROM message_actions WHERE message_id=?").get(messageId);
  if (prior) return String(prior.action_id);
  const message = db.prepare("SELECT * FROM messages WHERE message_id=?").get(messageId)!;
  const world = recordWorld(db, "messages", messageId), store = new SemanticStore(db, world);
  const actionId = existingActionId ?? store.logicalAction(String(message.from_node_id), String(message.to_node_id), "message.receive", messageId);
  const action = store.action(actionId).action;
  if (action.target_node_id !== message.to_node_id) throw new SideraError("conflict", "Logical action target cannot change with Presence");
  db.prepare("INSERT INTO message_actions VALUES (?,?,?)").run(messageId, world, actionId);
  return actionId;
}

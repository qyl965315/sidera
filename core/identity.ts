import { randomUUID } from "node:crypto";
import { recordWorld, scopeNewNode } from "./worlds.ts";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError, type ModelBindingRecord, type NodeRecord } from "./types.ts";
import { consumeHumanAct } from "./human-admission.ts";
import { initializeNodeSovereignty, readLocalSovereignty } from "./sovereignty-store.ts";
import { readNodeOntology, registerNodeOntology } from "./ontology.ts";
import { appendHistory } from "./history.ts";

export type IdentityCaller = { nodeId: string; sessionId: string };
export type ModelChoice = { provider: string; modelId: string;
  reasoningConfig?: Record<string, unknown> };

/** Display rename changes no identity, sovereign documents, bindings or history. */
export function renameNode(db: DatabaseSync, actor: IdentityCaller | { kind: "human"; id: string; actId?: string }, input: {
  requestId: string; nodeId: string; expectedDisplayName: string; displayName: string;
}) {
  for (const [key, value] of Object.entries(input)) nonempty(value, key);
  const humanId = "kind" in actor && actor.kind === "human" ? nonempty(actor.id, "Human actor") : null;
  const caller = "nodeId" in actor ? actor : null;
  if (!humanId && !caller) throw new SideraError("denied", "Authenticated actor required");
  const issuer = humanId ? `human:${humanId}` : `node:${caller!.nodeId}`;
  const fingerprint = JSON.stringify(input);
  return withTransaction(db, "node_rename", () => {
    const permit = humanId ? null : reserveCapability(db, { subjectNodeId: caller!.nodeId,
      sessionId: caller!.sessionId, requestId: input.requestId,
      capability: `${caller!.nodeId === input.nodeId ? "self." : ""}node.rename`, resource: `node/${input.nodeId}` });
    const prior = db.prepare(`SELECT payload FROM events WHERE kind='node.renamed'
      AND json_extract(payload,'$.issuer')=? AND json_extract(payload,'$.requestId')=?`)
      .get(issuer, input.requestId) as { payload: string } | undefined;
    if (prior) {
      const result = JSON.parse(prior.payload);
      if (result.fingerprint !== fingerprint) throw new SideraError("conflict", "Rename request ID reused");
      return result.result as { nodeId: string; displayName: string };
    }
    const row = db.prepare("SELECT display_name FROM nodes WHERE node_id=? AND lifecycle='active'")
      .get(input.nodeId) as { display_name: string } | undefined;
    if (!row) throw new SideraError("not_found", "Active Node was not found");
    if (row.display_name !== input.expectedDisplayName) throw new SideraError("conflict", "Display name changed");
    if("kind" in actor)consumeHumanAct(db,actor,recordWorld(db,"nodes",input.nodeId),"node.rename",input.nodeId,`node/${input.nodeId}`,input);
    db.prepare("UPDATE nodes SET display_name=? WHERE node_id=?").run(input.displayName, input.nodeId);
    const result = { nodeId: input.nodeId, displayName: input.displayName };
    db.prepare("INSERT INTO events VALUES (?, ?, 'node.renamed', ?, ?)").run(randomUUID(),
      humanId ? null : caller!.nodeId, JSON.stringify({ issuer, requestId: input.requestId, fingerprint,
        targetNodeId: input.nodeId, previousDisplayName: row.display_name, result }), new Date().toISOString());
    if (permit?.reservationId) settleReservation(db, permit.reservationId, "consumed");
    return result;
  });
}

function nonempty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new SideraError("conflict", `${name} must be nonempty`);
  return value;
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SideraError("conflict", `${name} must be an object`);
  return value as Record<string, unknown>;
}

function bindingFromRow(row: Record<string, unknown>): ModelBindingRecord {
  return { bindingId: String(row.binding_id), nodeId: String(row.node_id),
    provider: String(row.provider), modelId: String(row.model_id),
    reasoningConfig: asObject(JSON.parse(String(row.reasoning_config)), "reasoningConfig"),
    validFrom: String(row.valid_from),
    validUntil: row.valid_until == null ? null : String(row.valid_until),
    migrationFrom: row.migration_from == null ? null : String(row.migration_from) };
}

/** Node continuity is canonical in SQLite, independently of models and sessions. */
export class IdentityStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  currentModel(nodeId: string): ModelBindingRecord | null {
    const row = this.db.prepare(`SELECT * FROM model_bindings
      WHERE node_id = ? AND valid_until IS NULL`).get(nodeId) as
      Record<string, unknown> | undefined;
    return row ? bindingFromRow(row) : null;
  }

  /** @deprecated Legacy local data only; Sovereign Memory is Description + Explanation. */
  memory(nodeId: string, key: string): unknown | null {
    const row = this.db.prepare(`SELECT value_json FROM sovereign_memory
      WHERE node_id = ? AND memory_key = ?`).get(nodeId, key) as
      { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }

  lineage(nodeId: string): Record<string, unknown>[] {
    return this.db.prepare(`SELECT lineage_id AS lineageId, node_id AS nodeId,
      kind, parent_lineage_id AS parentLineageId, source_node_id AS sourceNodeId,
      source_self_head AS sourceSelfHead, from_binding_id AS fromBindingId,
      to_binding_id AS toBindingId, created_at AS createdAt
      FROM identity_lineage WHERE node_id = ? ORDER BY rowid`).all(nodeId) as
      Record<string, unknown>[];
  }

  bindModel(caller: IdentityCaller, requestId: string, choice: ModelChoice): ModelBindingRecord {
    const normalized = this.choice(choice);
    return this.action(caller, requestId, "model.bind", normalized,
      "self.model.bind", `node/${caller.nodeId}/model`, () => {
        const current = this.currentModel(caller.nodeId);
        if (current) {
          if (current.provider !== normalized.provider || current.modelId !== normalized.modelId)
            throw new SideraError("conflict", "Changing model requires model.migrate");
          // Reasoning effort and related run configuration do not change identity.
          this.db.prepare("UPDATE model_bindings SET reasoning_config = ? WHERE binding_id = ?")
            .run(JSON.stringify(normalized.reasoningConfig), current.bindingId);
          this.event(caller.nodeId, "model.configured", { requestId,
            bindingId: current.bindingId, reasoningConfig: normalized.reasoningConfig });
          return this.currentModel(caller.nodeId)!;
        }
        const bindingId = randomUUID();
        const at = new Date().toISOString();
        this.db.prepare(`INSERT INTO model_bindings
          (binding_id, node_id, provider, model_id, reasoning_config, valid_from)
          VALUES (?, ?, ?, ?, ?, ?)`).run(bindingId, caller.nodeId,
            normalized.provider, normalized.modelId,
            JSON.stringify(normalized.reasoningConfig), at);
        this.advanceLineage(caller.nodeId, "model_bind", { toBindingId: bindingId }, at);
        return this.currentModel(caller.nodeId)!;
      });
  }

  migrateModel(caller: IdentityCaller, requestId: string,
    expectedBindingId: string, choice: ModelChoice): ModelBindingRecord {
    const normalized = this.choice(choice);
    return this.action(caller, requestId, "model.migrate",
      { expectedBindingId: nonempty(expectedBindingId, "expectedBindingId"), ...normalized },
      "self.model.migrate", `node/${caller.nodeId}/model`, () => {
        const current = this.currentModel(caller.nodeId);
        if (!current || current.bindingId !== expectedBindingId)
          throw new SideraError("conflict", "Current ModelBinding changed");
        if (current.provider === normalized.provider && current.modelId === normalized.modelId)
          throw new SideraError("conflict", "Use model.bind for reasoning configuration");
        const at = new Date().toISOString();
        const bindingId = randomUUID();
        this.db.prepare("UPDATE model_bindings SET valid_until = ? WHERE binding_id = ?")
          .run(at, current.bindingId);
        this.db.prepare(`INSERT INTO model_bindings
          (binding_id, node_id, provider, model_id, reasoning_config,
           valid_from, migration_from) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          bindingId, caller.nodeId, normalized.provider, normalized.modelId,
          JSON.stringify(normalized.reasoningConfig), at, current.bindingId);
        this.advanceLineage(caller.nodeId, "model_migration", {
          fromBindingId: current.bindingId, toBindingId: bindingId }, at);
        return this.currentModel(caller.nodeId)!;
      });
  }

  putMemory(_caller:IdentityCaller,_requestId:string,_key:string,_value:unknown):never {
    throw new SideraError("unavailable","Historical memory archive is read-only; revise Description + Explanation");
  }
  setSelfState(_caller:IdentityCaller,_requestId:string,_state:Record<string,unknown>):never {
    throw new SideraError("unavailable","Historical self_state is read-only; revise Description + Explanation");
  }

  forkNode(caller: IdentityCaller, requestId: string, displayName: string,
    expectedSelfHead: string): NodeRecord {
    nonempty(displayName, "displayName");
    return this.action(caller, requestId, "node.fork",
      { displayName, expectedSelfHead: nonempty(expectedSelfHead, "expectedSelfHead") },
      "node.fork", `node/${caller.nodeId}/fork`, () => {
        const source = this.node(caller.nodeId);
        if (source.activeSelfHead !== expectedSelfHead)
          throw new SideraError("conflict", "Source self head changed before fork");
        const nodeId = randomUUID();
        scopeNewNode(this.db, recordWorld(this.db, "nodes", caller.nodeId), nodeId);
        const at = new Date().toISOString();
        this.db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)")
          .run(nodeId, displayName, at);
        const current = this.currentModel(caller.nodeId);
        let clonedBindingId: string | null = null;
        if (current) {
          clonedBindingId = randomUUID();
          this.db.prepare(`INSERT INTO model_bindings
            (binding_id, node_id, provider, model_id, reasoning_config, valid_from)
            VALUES (?, ?, ?, ?, ?, ?)`).run(clonedBindingId, nodeId,
              current.provider, current.modelId,
              JSON.stringify(current.reasoningConfig), at);
        }
        const ontology = readNodeOntology(this.db, caller.nodeId);
        registerNodeOntology(this.db, nodeId, { kind: ontology.kind,
          operatorKind: ontology.operatorKind ?? undefined });
        // An explicitly authorized self-fork copies its own D/E into an independent local region.
        // No arbitrary source Node selector or parent responsibility transfer exists.
        const sovereign = readLocalSovereignty(this.db, caller.nodeId);
        initializeNodeSovereignty(this.db, nodeId, {
          description: sovereign.description, explanation: sovereign.explanation });
        const lineageId = randomUUID();
        this.db.prepare(`INSERT INTO identity_lineage
          (lineage_id, node_id, kind, parent_lineage_id, source_node_id,
           source_self_head, to_binding_id, created_at)
          VALUES (?, ?, 'fork', ?, ?, ?, ?, ?)`).run(lineageId, nodeId,
            source.lineageRef, caller.nodeId, source.activeSelfHead, clonedBindingId, at);
        this.db.prepare(`UPDATE node_identity SET identity_metadata = ?, self_state = ?,
          lineage_ref = ? WHERE node_id = ?`).run(
            JSON.stringify(source.identityMetadata), "{}",
            lineageId, nodeId);
        this.event(caller.nodeId, "node.forked", { requestId, sourceNodeId: caller.nodeId,
          forkNodeId: nodeId, sourceSelfHead: source.activeSelfHead,
          forkSelfHead: this.node(nodeId).activeSelfHead });
        appendHistory(this.db, { id: `fork:${nodeId}`, kind: "Fork", source: "node.self.fork",
          nodeRef: caller.nodeId, payload: { parentNodeRef: caller.nodeId, childNodeRef: nodeId,
            parentLineageRef: source.lineageRef, lineageRef: lineageId, requestId } });
        return this.node(nodeId);
      });
  }

  private choice(input: ModelChoice): Required<ModelChoice> {
    return { provider: nonempty(input.provider, "provider"),
      modelId: nonempty(input.modelId, "modelId"),
      reasoningConfig: asObject(input.reasoningConfig ?? {}, "reasoningConfig") };
  }

  private node(nodeId: string): NodeRecord {
    const row = this.db.prepare(`SELECT n.node_id AS nodeId, n.display_name AS displayName,
      n.lifecycle, n.created_at AS createdAt, i.identity_metadata AS identityMetadata,
      i.self_state AS selfState, i.active_self_head AS activeSelfHead,
      i.lineage_ref AS lineageRef FROM nodes n JOIN node_identity i
      ON i.node_id = n.node_id WHERE n.node_id = ?`).get(nodeId) as
      Record<string, unknown> | undefined;
    if (!row) throw new SideraError("not_found", "Node identity was not found");
    return { ...row, identityMetadata: JSON.parse(String(row.identityMetadata)),
      selfState: JSON.parse(String(row.selfState)) } as unknown as NodeRecord;
  }

  private rotateSelfHead(nodeId: string): string {
    const head = randomUUID();
    this.db.prepare("UPDATE node_identity SET active_self_head = ? WHERE node_id = ?")
      .run(head, nodeId);
    return head;
  }

  private advanceLineage(nodeId: string, kind: "model_bind" | "model_migration",
    links: { fromBindingId?: string; toBindingId: string }, at: string): void {
    const previous = this.node(nodeId).lineageRef;
    const lineageId = randomUUID();
    this.db.prepare(`INSERT INTO identity_lineage
      (lineage_id, node_id, kind, parent_lineage_id, from_binding_id,
       to_binding_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
         lineageId, nodeId, kind, previous, links.fromBindingId ?? null,
         links.toBindingId, at);
    this.db.prepare("UPDATE node_identity SET lineage_ref = ? WHERE node_id = ?")
      .run(lineageId, nodeId);
  }

  private event(nodeId: string, kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), nodeId, kind, JSON.stringify(payload), new Date().toISOString());
  }

  private action<T>(caller: IdentityCaller, requestId: string, kind: string,
    input: unknown, capability: string, resource: string, work: () => T): T {
    nonempty(requestId, "requestId");
    return withTransaction(this.db, "identity_action", () => {
      const source = this.node(caller.nodeId);
      const session = this.db.prepare(`SELECT 1 FROM sessions WHERE session_id = ?
        AND node_id = ? AND state = 'active'`).get(caller.sessionId, caller.nodeId);
      if (source.lifecycle !== "active" || !session)
        throw new SideraError("denied", "Identity action requires the active Node Session");
      const encoded = JSON.stringify(input);
      const prior = this.db.prepare(`SELECT kind, input_json, result_json FROM identity_actions
        WHERE actor_node_id = ? AND request_id = ?`).get(caller.nodeId, requestId) as
        { kind: string; input_json: string; result_json: string } | undefined;
      if (prior) {
        if (prior.kind !== kind || prior.input_json !== encoded)
          throw new SideraError("conflict", "Identity request ID was reused");
        return JSON.parse(prior.result_json) as T;
      }
      const permit = reserveCapability(this.db, { subjectNodeId: caller.nodeId,
        sessionId: caller.sessionId, capability, resource, requestId });
      const result = work();
      this.db.prepare(`INSERT INTO identity_actions
        (actor_node_id, request_id, kind, input_json, result_json)
        VALUES (?, ?, ?, ?, ?)`).run(caller.nodeId, requestId,
          kind, encoded, JSON.stringify(result));
      if (permit.reservationId) settleReservation(this.db, permit.reservationId, "consumed");
      return result;
    });
  }
}

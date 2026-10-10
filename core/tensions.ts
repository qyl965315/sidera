import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";

export type TensionKind = "commitment" | "subjective" | "evidence" | "coordination";
export type TensionStatus = "open" | "waiting" | "resolved" | "relinquished" | "escalated";
export type SourceRef = { kind: "responsibility" | "task" | "message" | "event" | "dependency" | "subjectivity"; id: string };
export interface Tension {
  tensionId: string; nodeId: string; kind: TensionKind; statement: string;
  sourceRefs: SourceRef[]; status: TensionStatus; createdAt: string; updatedAt: string;
}
type Caller = { nodeId: string; sessionId: string };

function row(value: Record<string, unknown>): Tension {
  return { tensionId: String(value.tension_id), nodeId: String(value.node_id),
    kind: String(value.kind) as TensionKind, statement: String(value.statement),
    sourceRefs: JSON.parse(String(value.source_refs)) as SourceRef[],
    status: String(value.status) as TensionStatus,
    createdAt: String(value.created_at), updatedAt: String(value.updated_at) };
}

export function getTension(db: DatabaseSync, id: string): Tension {
  const value = db.prepare("SELECT * FROM tensions WHERE tension_id = ?").get(id) as Record<string, unknown> | undefined;
  if (!value) throw new SideraError("not_found", "Tension was not found");
  return row(value);
}

export function listTensions(db: DatabaseSync, nodeId: string, actionableOnly = false, limit = 32): Tension[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new SideraError("conflict", "Tension limit must be between 1 and 100");
  return (db.prepare(`SELECT * FROM tensions WHERE node_id = ?
    AND (? = 0 OR status IN ('open','waiting')) ORDER BY created_at, tension_id LIMIT ?`)
    .all(nodeId, actionableOnly ? 1 : 0, limit) as Record<string, unknown>[]).map(row);
}

export function mutateTension(db: DatabaseSync, caller: Caller, input: {
  requestId: string; tensionId?: string; kind?: TensionKind;
  statement?: string; sourceRefs?: SourceRef[]; status?: TensionStatus;
}): Tension {
  if (!input.requestId) throw new SideraError("conflict", "requestId is required");
  if (input.statement !== undefined && (!input.statement.trim() || Buffer.byteLength(input.statement) > 8000))
    throw new SideraError("conflict", "Tension statement must be nonempty and at most 8 KB");
  if (input.sourceRefs !== undefined && (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 32 ||
      input.sourceRefs.some(ref => !ref || !["responsibility","task","message","event","dependency","subjectivity"].includes(ref.kind) ||
        typeof ref.id !== "string" || !ref.id || ref.id.length > 200)))
    throw new SideraError("conflict", "Invalid source references");
  if (input.status !== undefined && !["open","waiting","resolved","relinquished","escalated"].includes(input.status))
    throw new SideraError("conflict", "Invalid Tension status");
  return withTransaction(db, "tension_action", () => {
    const json = JSON.stringify(input);
    const prior = db.prepare("SELECT input_json, result_json FROM tension_actions WHERE node_id = ? AND request_id = ?")
      .get(caller.nodeId, input.requestId) as { input_json: string; result_json: string } | undefined;
    if (prior) {
      if (prior.input_json !== json) throw new SideraError("conflict", "Tension request ID was reused");
      return JSON.parse(prior.result_json) as Tension;
    }
    const before = input.tensionId ? getTension(db, input.tensionId) : null;
    if (before && before.nodeId !== caller.nodeId)
      throw new SideraError("denied", "Tension is outside your subject domain; send an observation instead");
    if (before?.kind === "commitment") {
      if (input.kind || input.sourceRefs) throw new SideraError("denied", "Commitment provenance belongs to Core");
      const active = db.prepare(`SELECT r.deferred_at FROM responsibilities r JOIN tensions t
        ON t.responsibility_id = r.responsibility_id WHERE t.tension_id = ?
        AND r.owner_node_id = t.node_id AND r.state = 'active' AND r.accepted_at IS NOT NULL`).get(before.tensionId) as { deferred_at: string | null } | undefined;
      if (active && input.status && input.status !== (active.deferred_at == null ? "open" : "waiting"))
        throw new SideraError("denied", "Unresolved accepted Responsibility cannot be erased or hidden; use a public Responsibility operation");
      if (!active && input.status && input.status !== before.status)
        throw new SideraError("denied", "Commitment lifecycle belongs to Responsibility");
    }
    if (!before && (!input.statement || !input.kind || !["subjective","evidence","coordination"].includes(input.kind)))
      throw new SideraError("denied", "Only Core derives commitment tensions; supply a self-authored kind and statement");
    if (before && input.kind && input.kind !== before.kind)
      throw new SideraError("conflict", "Tension kind is stable");
    reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
      requestId: input.requestId, capability: before ? "self.tension.update" : "self.tension.register",
      resource: `node/${caller.nodeId}/tensions` });
    const now = new Date().toISOString();
    const id = before?.tensionId ?? randomUUID();
    if (before) db.prepare("UPDATE tensions SET statement = ?, source_refs = ?, status = ?, updated_at = ? WHERE tension_id = ?")
      .run(input.statement ?? before.statement, JSON.stringify(input.sourceRefs ?? before.sourceRefs), input.status ?? before.status, now, id);
    else db.prepare(`INSERT INTO tensions VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, caller.nodeId, input.kind!, input.statement!, JSON.stringify(input.sourceRefs ?? []), input.status ?? "open", now, now);
    const result = getTension(db, id);
    db.prepare("INSERT INTO tension_actions VALUES (?, ?, ?, ?)").run(caller.nodeId, input.requestId, json, JSON.stringify(result));
    db.prepare("INSERT INTO events VALUES (?, ?, 'tension.updated', ?, ?)")
      .run(randomUUID(), caller.nodeId, JSON.stringify({ tensionId: id, kind: result.kind, status: result.status }), now);
    return result;
  });
}

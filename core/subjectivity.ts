import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { listTensions, type Tension } from "./tensions.ts";
import { commitLocalSovereignty, readLocalSovereignty } from "./sovereignty-store.ts";
import { appendHistory } from "./history.ts";
import { isExecutorRuntimeSession } from "./executors.ts";

export interface NodeSubjectivity {
  nodeId: string;
  description: string;
  explanation: string;
  revision: number;
  updatedAt: string;
}

export interface SubjectivityRevision {
  nodeId: string;
  revision: number;
  updatedAt: string;
}

type Caller = { nodeId: string; sessionId: string };

function document(value: string, field: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 100_000)
    throw new SideraError("conflict", `${field} must be text of at most 100 KB`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Infrastructure read for this Node's own wake context; RPC always derives NodeRef from its principal. */
export function getSubjectivity(db: DatabaseSync, nodeId: string): NodeSubjectivity {
  return readLocalSovereignty(db, nodeId);
}

/** The Node authors both documents. Core checks ownership, revision and Authority. */
export function reviseSubjectivity(db: DatabaseSync, caller: Caller, input: {
  requestId: string;
  expectedRevision: number;
  description: string;
  explanation: string;
}): SubjectivityRevision {
  if (!input.requestId || typeof input.requestId !== "string")
    throw new SideraError("conflict", "requestId is required");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new SideraError("conflict", "expectedRevision must be a nonnegative integer");
  const description = document(input.description, "description");
  const explanation = document(input.explanation, "explanation");
  const inputJson = JSON.stringify({ expectedRevision: input.expectedRevision,
    descriptionHash: digest(description), explanationHash: digest(explanation) });
  return withTransaction(db, "subjectivity_revision", () => {
    const session = db.prepare(`SELECT 1 FROM sessions WHERE session_id = ?
      AND node_id = ? AND state = 'active'`).get(caller.sessionId, caller.nodeId);
    if (!session && !isExecutorRuntimeSession(db, caller.nodeId, caller.sessionId))
      throw new SideraError("denied", "Active own runtime context is required");
    // The local source must exist even on a deduplicated request; stale SQL cannot fabricate D/E.
    getSubjectivity(db, caller.nodeId);
    const previous = db.prepare(`SELECT kind, input_json, result_json FROM identity_actions
      WHERE actor_node_id = ? AND request_id = ?`).get(caller.nodeId, input.requestId) as
      { kind: string; input_json: string; result_json: string } | undefined;
    if (previous) {
      if (previous.kind !== "subjectivity.revise" || previous.input_json !== inputJson)
        throw new SideraError("conflict", "Subjectivity request ID was reused");
      return JSON.parse(previous.result_json) as SubjectivityRevision;
    }
    const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
      capability: "self.subjectivity.write",
      resource: `node/${caller.nodeId}/subjectivity`, requestId: input.requestId });
    const receipt = commitLocalSovereignty(db, caller.nodeId, { ...input, description, explanation,
      fingerprint: digest(inputJson) }, committed => {
      db.prepare("UPDATE node_identity SET active_self_head = ? WHERE node_id = ?")
        .run(randomUUID(), caller.nodeId);
      const result = { nodeId: caller.nodeId, revision: committed.revision, updatedAt: committed.updatedAt };
      db.prepare(`INSERT INTO identity_actions
        (actor_node_id, request_id, kind, input_json, result_json)
        VALUES (?, ?, 'subjectivity.revise', ?, ?)`)
        .run(caller.nodeId, input.requestId, inputJson, JSON.stringify(result));
      const eventId = randomUUID();
      db.prepare("INSERT INTO events VALUES (?, ?, 'subjectivity.revised', ?, ?)")
        .run(eventId, caller.nodeId,
          JSON.stringify({ requestId: input.requestId, revision: committed.revision }), committed.updatedAt);
      appendHistory(db, { id: `sovereignty:${caller.nodeId}:${input.requestId}`, kind: "Action",
        source: "node.self.sovereignty", nodeRef: caller.nodeId,
        payload: { operation: "self.subjectivity.write", revision: committed.revision,
          requestId: input.requestId } });
      if (permit.reservationId) settleReservation(db, permit.reservationId, "consumed");
    });
    return { nodeId: caller.nodeId, revision: receipt.revision, updatedAt: receipt.updatedAt };
  });
}

/** Small present context for a fresh Host turn; no transcript or old revision. */
export function wakeContext(db: DatabaseSync, nodeId: string): {
  identity: { nodeId: string; displayName: string; lineageRef: string; activeSelfHead: string };
  subjectivity: NodeSubjectivity;
  roles: Array<{ role: string; scope: string }>;
  responsibilities: Array<{ responsibilityId: string; title: string; scope: string; status: string; deferredReason: string | null }>;
  proposals: Array<{ responsibilityId: string; title: string; scope: string; status: string; deferredReason: string | null }>;
  tensions: Tension[];
} {
  const node = db.prepare(`SELECT display_name, lineage_ref, active_self_head FROM nodes
    JOIN node_identity USING(node_id) WHERE node_id = ? AND lifecycle = 'active'`)
    .get(nodeId) as { display_name: string; lineage_ref: string; active_self_head: string } | undefined;
  if (!node) throw new SideraError("not_found", "Active Node was not found");
  const roles = db.prepare(`SELECT role, scope FROM role_appointments
    WHERE subject_node_id = ? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at LIMIT 16`).all(nodeId, new Date().toISOString()) as Array<{
    role: string; scope: string;
  }>;
  const responsibilities = db.prepare(`SELECT responsibility_id AS responsibilityId,
    title, scope, CASE WHEN deferred_at IS NULL THEN 'active' ELSE 'waiting' END AS status,
    deferred_reason AS deferredReason FROM responsibilities WHERE owner_node_id = ? AND state = 'active' AND accepted_at IS NOT NULL
    ORDER BY created_at LIMIT 32`).all(nodeId) as Array<{
    responsibilityId: string; title: string; scope: string; status: string; deferredReason: string | null;
  }>;
  const proposals = db.prepare(`SELECT responsibility_id AS responsibilityId, title, scope,
    CASE WHEN deferred_at IS NULL THEN 'active' ELSE 'waiting' END AS status, deferred_reason AS deferredReason
    FROM responsibilities WHERE owner_node_id = ? AND state = 'active' AND accepted_at IS NULL
    ORDER BY created_at LIMIT 16`).all(nodeId) as Array<{ responsibilityId: string; title: string; scope: string; status: string; deferredReason: string | null }>;
  return { identity: { nodeId, displayName: node.display_name,
    lineageRef: node.lineage_ref, activeSelfHead: node.active_self_head },
    subjectivity: getSubjectivity(db, nodeId), roles, responsibilities, proposals,
    tensions: listTensions(db, nodeId, true) };
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { recordWorld, requireWorld } from "./worlds.ts";

/**
 * Durable Sidera Resources: the product's machine-interface file/attachment
 * boundary. A Resource is world-scoped, content-addressed and provider-agnostic;
 * it is never a Node, Session, Host or MCP connection.
 *
 * Shape: external input (Chat attachment / MCP / local operator)
 *        -> Resource (durable bytes + provenance)
 *        -> authorized Node read
 *        -> ArtifactReference (result provenance, artifact_references)
 *        -> requesting Chat / Human
 *
 * Bytes live in a content-addressed store beside the journal; the journal holds
 * only metadata, digest and provenance. A missing blob is an unresolved
 * reference, never a fabricated resource.
 */

export const RESOURCE_MAX_BYTES = 256 * 1024 * 1024;
const RESOURCE_MAX_READ_BYTES = 64 * 1024 * 1024;
const RESOURCE_MAX_NAME = 300;
const RESOURCE_MAX_MEDIA_TYPE = 200;
const RESOURCE_MAX_SOURCE_REF = 2000;
const RESOURCE_MAX_LIST = 200;

export type ResourceOrigin = "human" | "node" | "host" | "local-operator";

export interface ResourcePutInput {
  requestId: string;
  name: string;
  mediaType?: string | null;
  origin?: ResourceOrigin;
  sourceRef?: string | null;
  taskId?: string | null;
  runId?: string | null;
  /** Base64 for binary or unknown-encoding input; bytes must round-trip exactly. */
  dataBase64?: string | null;
  /** Literal UTF-8 text, stored with its exact bytes. */
  dataText?: string | null;
  /** Optional linkage to an already-registered result Artifact. */
  artifactId?: string | null;
}

export interface ResourceRecord {
  resourceId: string;
  worldId: string;
  name: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  origin: ResourceOrigin;
  createdByNodeId: string | null;
  createdByHumanId: string | null;
  sourceRef: string | null;
  taskId: string | null;
  runId: string | null;
  artifactId: string | null;
  createdAt: string;
}

interface StoredRow extends Record<string, unknown> { resource_id: string }

export function resourceStoreRoot(project: string): string {
  return join(project, ".sidera-dev", "sol", "data", "resources");
}

export function migrateResources(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      resource_id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      sha256 TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('human','node','host','local-operator')),
      created_by_node_id TEXT REFERENCES nodes(node_id),
      created_by_human_id TEXT,
      source_ref TEXT,
      task_id TEXT REFERENCES tasks(task_id),
      run_id TEXT REFERENCES task_runs(run_id),
      artifact_id TEXT REFERENCES artifact_references(artifact_id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resources_world_created ON resources(world_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS resources_task ON resources(task_id);
    CREATE INDEX IF NOT EXISTS resources_digest ON resources(sha256);
    CREATE TABLE IF NOT EXISTS resource_scopes (
      resource_id TEXT NOT NULL REFERENCES resources(resource_id),
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      basis TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (resource_id, node_id)
    );
  `);
}

function bounded(value: string, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new SideraError("conflict", `${field} must be 1..${max} characters`);
  return value.trim();
}

function row(db: DatabaseSync, resourceId: string): StoredRow & {
  resource_id: string; world_id: string; name: string; media_type: string; byte_size: number;
  sha256: string; origin: string; created_by_node_id: string | null; created_by_human_id: string | null;
  source_ref: string | null; task_id: string | null; run_id: string | null; artifact_id: string | null;
  created_at: string;
} {
  const found = db.prepare("SELECT * FROM resources WHERE resource_id=?").get(resourceId) as never;
  if (!found) throw new SideraError("not_found", "Resource was not found in this World");
  return found;
}

function view(value: ReturnType<typeof row>): ResourceRecord {
  return { resourceId: value.resource_id, worldId: value.world_id, name: value.name,
    mediaType: value.media_type, byteSize: Number(value.byte_size), sha256: value.sha256,
    origin: value.origin as ResourceOrigin, createdByNodeId: value.created_by_node_id,
    createdByHumanId: value.created_by_human_id, sourceRef: value.source_ref,
    taskId: value.task_id, runId: value.run_id, artifactId: value.artifact_id, createdAt: value.created_at };
}

function decode(input: ResourcePutInput): Buffer {
  const hasBase64 = typeof input.dataBase64 === "string" && input.dataBase64.length > 0;
  const hasText = typeof input.dataText === "string" && input.dataText.length > 0;
  if (hasBase64 === hasText)
    throw new SideraError("conflict", "A Resource needs exactly one of dataBase64 or dataText");
  if (hasText) return Buffer.from(input.dataText!, "utf8");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64!) || input.dataBase64!.length % 4 !== 0)
    throw new SideraError("conflict", "dataBase64 is not valid base64");
  return Buffer.from(input.dataBase64!, "base64");
}

function storePath(project: string, digest: string): string {
  return join(resourceStoreRoot(project), digest.slice(0, 2), `${digest}.bin`);
}

function writeBlob(project: string, digest: string, bytes: Buffer): void {
  const target = storePath(project, digest);
  if (existsSync(target)) {
    const actual = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (actual !== digest) throw new SideraError("conflict", "Content-addressed Resource blob does not match its digest");
    return;
  }
  const dir = join(resourceStoreRoot(project), digest.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
}

function readBlob(project: string, digest: string): Buffer {
  const target = storePath(project, digest);
  if (!existsSync(target)) throw new SideraError("unavailable", "Resource bytes are not resolvable in the local store");
  const bytes = readFileSync(target);
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new SideraError("conflict", "Resource bytes no longer match their recorded digest");
  return bytes;
}

/** A Resource may read a Node it belongs to, its creator, a World Human, or a
 * Node it was explicitly scoped to. Existence never implies visibility (C20). */
function authorized(db: DatabaseSync, worldId: string, caller: { nodeId?: string; humanId?: string }, resourceId: string): void {
  if (caller.nodeId) {
    const direct = db.prepare(`SELECT 1 FROM resources r WHERE r.resource_id=? AND r.world_id=?
      AND (r.created_by_node_id=? OR EXISTS(SELECT 1 FROM resource_scopes s WHERE s.resource_id=r.resource_id AND s.node_id=?))`)
      .get(resourceId, worldId, caller.nodeId, caller.nodeId);
    if (direct) return;
  }
  if (caller.humanId) {
    const member = db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(worldId, caller.humanId);
    if (member) return;
  }
  throw new SideraError("denied", "Resource is outside this subject's authorized scope");
}

export function putResource(db: DatabaseSync, project: string,
  caller: { nodeId: string; sessionId: string },
  input: ResourcePutInput): { resource: ResourceRecord; replay: boolean; blobPath: string } {
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  const requestId = bounded(input.requestId, "requestId", 200);
  const name = bounded(input.name, "name", RESOURCE_MAX_NAME);
  const mediaType = typeof input.mediaType === "string" && input.mediaType.trim()
    ? bounded(input.mediaType, "mediaType", RESOURCE_MAX_MEDIA_TYPE) : "application/octet-stream";
  const origin = (input.origin ?? "node") as ResourceOrigin;
  if (!["human", "node", "host", "local-operator"].includes(origin))
    throw new SideraError("conflict", "Unknown Resource origin");
  if (input.sourceRef != null) bounded(input.sourceRef, "sourceRef", RESOURCE_MAX_SOURCE_REF);
  const bytes = decode(input);
  if (bytes.byteLength > RESOURCE_MAX_BYTES)
    throw new SideraError("conflict", `Resource exceeds ${RESOURCE_MAX_BYTES} bytes`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const prior = db.prepare(`SELECT resource_id FROM resources WHERE world_id=? AND created_by_node_id=? AND source_ref=?
    AND name=? AND sha256=?`).get(worldId, caller.nodeId, input.sourceRef ?? null, name, digest) as { resource_id: string } | undefined;
  if (prior) {
    const existing = view(row(db, prior.resource_id));
    return { resource: existing, replay: true, blobPath: storePath(project, existing.sha256) };
  }
  const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
    requestId, capability: "self.resource.publish", resource: `node/${caller.nodeId}`,
    taskId: input.taskId ?? undefined });
  try {
    const record = withTransaction(db, "resource_put", () => {
      if (input.taskId) requireWorld(db, worldId, "tasks", input.taskId);
      if (input.runId) requireWorld(db, worldId, "task_runs", input.runId);
      if (input.artifactId) requireWorld(db, worldId, "artifact_references", input.artifactId);
      const id = randomUUID(), at = new Date().toISOString();
      db.prepare(`INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, worldId, name, mediaType,
        bytes.byteLength, digest, origin, caller.nodeId, null, input.sourceRef ?? null,
        input.taskId ?? null, input.runId ?? null, input.artifactId ?? null, at);
      writeBlob(project, digest, bytes);
      db.prepare("INSERT INTO events VALUES (?,?, 'resource.published', ?, ?)").run(randomUUID(), caller.nodeId,
        JSON.stringify({ resourceId: id, worldId, name, mediaType, byteSize: bytes.byteLength, sha256: digest,
          origin, taskId: input.taskId ?? null, runId: input.runId ?? null, artifactId: input.artifactId ?? null,
          requestId }), at);
      return id;
    });
    if (permit.reservationId) settleReservation(db, permit.reservationId, "consumed");
    return { resource: view(row(db, record)), replay: false, blobPath: storePath(project, digest) };
  } catch (error) {
    if (permit.reservationId && db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(permit.reservationId)?.status === "reserved")
      settleReservation(db, permit.reservationId, "released");
    throw error;
  }
}

export function resourceMetadata(db: DatabaseSync,
  caller: { nodeId: string; sessionId: string }, resourceId: string) {
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  const value = row(db, bounded(resourceId, "resourceId", 200));
  if (value.world_id !== worldId) throw new SideraError("not_found", "Resource was not found in this World");
  authorized(db, worldId, { nodeId: caller.nodeId }, value.resource_id);
  return view(value);
}

export function readResource(db: DatabaseSync, project: string,
  caller: { nodeId: string; sessionId: string }, resourceId: string,
  options: { asBase64?: boolean } = {}) {
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  const value = row(db, bounded(resourceId, "resourceId", 200));
  if (value.world_id !== worldId) throw new SideraError("not_found", "Resource was not found in this World");
  // Visibility can change when the owner explicitly scopes a Resource later.
  // Check that before reserving the reader's own capability: a denied safe read
  // must not consume/settle a deterministic reservation and poison a later
  // authorized retry after the scope legitimately changes.
  authorized(db, worldId, { nodeId: caller.nodeId }, value.resource_id);
  const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
    requestId: `resource-read:${value.resource_id}:${caller.sessionId}`, capability: "self.resource.read",
    resource: `node/${caller.nodeId}` });
  try {
    if (Number(value.byte_size) > RESOURCE_MAX_READ_BYTES)
      throw new SideraError("conflict", `Resource exceeds the inline read limit of ${RESOURCE_MAX_READ_BYTES} bytes; use its local path`);
    const bytes = readBlob(project, value.sha256);
    if (permit.reservationId) settleReservation(db, permit.reservationId, "consumed");
    return { resource: view(value), asBase64: options.asBase64 === true,
      data: options.asBase64 === true ? bytes.toString("base64") : bytes.toString("utf8") };
  } catch (error) {
    if (permit.reservationId && db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(permit.reservationId)?.status === "reserved")
      settleReservation(db, permit.reservationId, "released");
    throw error;
  }
}

export function listResources(db: DatabaseSync,
  caller: { nodeId: string; sessionId: string }, filter: { taskId?: string; runId?: string; limit?: number } = {}) {
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  const limit = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), RESOURCE_MAX_LIST);
  const rows = db.prepare(`SELECT * FROM resources WHERE world_id=?
    AND (? IS NULL OR task_id=?) AND (? IS NULL OR run_id=?)
    ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(worldId, filter.taskId ?? null, filter.taskId ?? null, filter.runId ?? null, filter.runId ?? null, limit * 4) as ReturnType<typeof row>[];
  const visible: ResourceRecord[] = [];
  for (const candidate of rows) {
    try { authorized(db, worldId, { nodeId: caller.nodeId }, candidate.resource_id); visible.push(view(candidate)); }
    catch { /* Outside this subject's scope; existence is not visibility. */ }
    if (visible.length >= limit) break;
  }
  return { resources: visible, truncated: rows.length > visible.length };
}

/** Machine-interface-only convenience: scope a Resource to another Node as the
 * explicit basis for a later read. It grants no capability; a read still needs
 * the reader's own Human-rooted grant. */
export function scopeResource(db: DatabaseSync,
  caller: { nodeId: string; sessionId: string },
  input: { requestId: string; resourceId: string; targetNodeId: string; basis: string }) {
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", caller.sessionId);
  bounded(input.requestId, "requestId", 200);
  bounded(input.basis, "basis", 1000);
  const value = row(db, bounded(input.resourceId, "resourceId", 200));
  if (value.world_id !== worldId) throw new SideraError("not_found", "Resource was not found in this World");
  requireWorld(db, worldId, "nodes", input.targetNodeId);
  authorized(db, worldId, { nodeId: caller.nodeId }, value.resource_id);
  withTransaction(db, "resource_scope", () => {
    db.prepare("INSERT INTO resource_scopes VALUES (?,?,?,?) ON CONFLICT(resource_id,node_id) DO NOTHING")
      .run(value.resource_id, input.targetNodeId, input.basis, new Date().toISOString());
    db.prepare("INSERT INTO events VALUES (?,?, 'resource.scoped', ?, ?)").run(randomUUID(), caller.nodeId,
      JSON.stringify({ resourceId: value.resource_id, targetNodeId: input.targetNodeId,
        basis: input.basis, requestId: input.requestId }), new Date().toISOString());
  });
  return { resourceId: value.resource_id, targetNodeId: input.targetNodeId, basis: input.basis };
}

/** Local resolution path for a Resource's bytes. Reading the path proves nothing;
 * it exists so a local Host can open a large file without an inline transfer. */
export function resourcePathFor(project: string, db: DatabaseSync, resourceId: string): string {
  const value = row(db, bounded(resourceId, "resourceId", 200));
  return storePath(project, value.sha256);
}

export function resourceStats(project: string): { storeRoot: string; stored: number } {
  let stored = 0;
  const root = resourceStoreRoot(project);
  if (existsSync(root)) {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (next.endsWith(".bin") && statSync(next).isFile()) stored++;
      }
    };
    walk(root);
  }
  return { storeRoot: root, stored };
}



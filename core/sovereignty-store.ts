import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";

export interface SovereigntySnapshot {
  nodeId: string; description: string; explanation: string; revision: number; updatedAt: string;
}
export interface SovereigntyReceipt {
  requestId: string; fingerprint: string; revision: number; updatedAt: string;
}
interface StoredSovereignty extends SovereigntySnapshot {
  format: 1;
  /** Private operation metadata permits reconciliation without retaining past D/E. */
  receipts: SovereigntyReceipt[];
}
const stores = new WeakMap<DatabaseSync, { root: string }>();

/** Infrastructure-only storage location; this is never a Node semantic read capability. */
export function sovereigntyRoot(db: DatabaseSync): string {
  const store = stores.get(db);
  if (!store) throw new SideraError("unavailable", "Local Sovereignty storage is not initialized");
  if (lstatSync(store.root).isSymbolicLink())
    throw new SideraError("denied", "Sovereignty region cannot be a symbolic link");
  return store.root;
}

/** Semantic file brokers must not turn a filesystem Grant into a cross-Node D/E capability. */
export function assertOutsideSovereignty(db: DatabaseSync, file: string): void {
  const root = realpathSync(sovereigntyRoot(db));
  const actual = existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
  const local = relative(root, actual);
  if (local === "" || !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))
    throw new SideraError("denied", "Sovereignty is not a semantic filesystem surface; use own subjectivity capability");
}

function nodeDirectory(db: DatabaseSync, nodeId: string): string {
  if (!db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(nodeId))
    throw new SideraError("not_found", "Node Sovereignty was not found");
  // NodeRef remains in the document. Non-path-safe historical identifiers cannot escape the region.
  const segment = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(nodeId) ? nodeId
    : `ref-${createHash("sha256").update(nodeId).digest("hex")}`;
  const directory = join(sovereigntyRoot(db), segment);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw new SideraError("denied", "Node Sovereignty region cannot redirect to another region");
  return directory;
}

function currentFile(db: DatabaseSync, nodeId: string): string {
  return join(nodeDirectory(db, nodeId), "current.json");
}

function decode(text: string, nodeId: string): StoredSovereignty {
  let value: StoredSovereignty;
  try { value = JSON.parse(text) as StoredSovereignty; }
  catch { throw new SideraError("unavailable", "Local Sovereignty document is invalid; reconciliation is required"); }
  if (value?.format !== 1 || value.nodeId !== nodeId || typeof value.description !== "string"
    || typeof value.explanation !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.updatedAt !== "string" || !Array.isArray(value.receipts)
    || value.receipts.some(r => typeof r.requestId !== "string" || typeof r.fingerprint !== "string"
      || !Number.isSafeInteger(r.revision) || r.revision > value.revision || typeof r.updatedAt !== "string"))
    throw new SideraError("unavailable", "Local Sovereignty document metadata is invalid");
  return value;
}

function readStored(db: DatabaseSync, nodeId: string): StoredSovereignty {
  const file = currentFile(db, nodeId);
  if (!existsSync(file))
    throw new SideraError("unavailable", "Canonical local Sovereignty is missing; SQLite content is not a recovery source");
  if (lstatSync(file).isSymbolicLink())
    throw new SideraError("denied", "Canonical Sovereignty document cannot be a symbolic link");
  return decode(readFileSync(file, "utf8"), nodeId);
}

function withNodeLock<T>(db: DatabaseSync, nodeId: string, work: () => T): T {
  const directory = nodeDirectory(db, nodeId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // SQLite coordinates writers only; D/E never enters this row. An engine-owned
  // lock is released on process death, avoiding stale PID locks or lock stealing.
  db.exec("SAVEPOINT sovereignty_file_write");
  try {
    db.prepare(`INSERT INTO sovereignty_write_locks(node_id) VALUES (?)
      ON CONFLICT(node_id) DO UPDATE SET node_id=excluded.node_id`).run(nodeId);
    const value = work();
    db.exec("RELEASE sovereignty_file_write");
    return value;
  } catch (error) {
    db.exec("ROLLBACK TO sovereignty_file_write; RELEASE sovereignty_file_write");
    throw error;
  }
}

function publish(db: DatabaseSync, nodeId: string, record: StoredSovereignty): void {
  const directory = nodeDirectory(db, nodeId);
  const temporary = join(directory, `.current-${randomUUID()}.tmp`);
  const encoded = JSON.stringify(record);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, encoded, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    // The pair D/E and all CAS metadata replace together, never as separate document writes.
    renameSync(temporary, currentFile(db, nodeId));
    if (process.platform !== "win32") {
      const dir = openSync(directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function index(db: DatabaseSync, value: SovereigntySnapshot): void {
  // Compatibility index only. Content is never mirrored back into SQLite.
  db.prepare(`UPDATE node_subjectivity SET description='',explanation='',revision=?,updated_at=? WHERE node_id=?`)
    .run(value.revision, value.updatedAt, value.nodeId);
  db.prepare(`INSERT INTO sovereignty_storage(node_id,format,revision,updated_at)
    VALUES (?,1,?,?) ON CONFLICT(node_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`)
    .run(value.nodeId, value.revision, value.updatedAt);
}

/** Additive startup migration. A verified fsynced local copy always precedes legacy content removal. */
export function migrateSovereignty(db: DatabaseSync, databaseFile: string): void {
  if (!stores.has(db)) {
    const temporary = databaseFile === ":memory:";
    const root = temporary ? mkdtempSync(join(tmpdir(), "sidera-sovereignty-"))
      : `${realpathSync(resolve(databaseFile))}.sovereignty`;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    stores.set(db, { root });
    if (temporary) {
      const originalClose = db.close.bind(db);
      db.close = () => {
        originalClose();
        // This exact mkdtemp-created region belongs only to this in-memory database.
        rmSync(root, { recursive: true, force: true });
      };
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sovereignty_storage(
    node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),format INTEGER NOT NULL CHECK(format=1),
    revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sovereignty_write_locks(node_id TEXT PRIMARY KEY REFERENCES nodes(node_id))`);
  for (const row of db.prepare("SELECT node_id FROM nodes").all())
    initializeNodeSovereignty(db, String(row.node_id));
}

/** Registry/fork infrastructure only. No target-Node selector is exposed to subjectivity RPC. */
export function initializeNodeSovereignty(db: DatabaseSync, nodeId: string,
  initial?: { description: string; explanation: string }): SovereigntySnapshot {
  return withNodeLock(db, nodeId, () => {
    const metadata = db.prepare("SELECT 1 FROM sovereignty_storage WHERE node_id=?").get(nodeId);
    if (metadata) {
      const existing = readStored(db, nodeId);
      if (initial) throw new SideraError("conflict", "Node Sovereignty already exists");
      index(db, existing);
      return snapshot(existing);
    }
    let record: StoredSovereignty;
    if (existsSync(currentFile(db, nodeId))) {
      // A prior migration may have published the file before SQLite committed its metadata.
      record = readStored(db, nodeId);
    } else {
      const row = db.prepare("SELECT * FROM node_subjectivity WHERE node_id=?").get(nodeId);
      if (!row) throw new SideraError("not_found", "Legacy Node Sovereignty metadata was not found");
      record = { format: 1, nodeId, description: initial?.description ?? String(row.description),
        explanation: initial?.explanation ?? String(row.explanation), revision: initial ? 0 : Number(row.revision),
        updatedAt: initial ? new Date().toISOString() : String(row.updated_at), receipts: [] };
      publish(db, nodeId, record);
      const verified = readStored(db, nodeId);
      if (JSON.stringify(record) !== JSON.stringify(verified))
        throw new SideraError("unavailable", "Sovereignty migration could not verify its local copy");
    }
    index(db, record);
    return snapshot(record);
  });
}

function snapshot(record: StoredSovereignty): SovereigntySnapshot {
  const { nodeId, description, explanation, revision, updatedAt } = record;
  return { nodeId, description, explanation, revision, updatedAt };
}

export function readLocalSovereignty(db: DatabaseSync, nodeId: string): SovereigntySnapshot {
  if (!db.prepare("SELECT 1 FROM sovereignty_storage WHERE node_id=?").get(nodeId))
    return initializeNodeSovereignty(db, nodeId);
  return snapshot(readStored(db, nodeId));
}

/** Self ownership/Authority are enforced by subjectivity.ts. This function is the private CAS substrate. */
export function commitLocalSovereignty(db: DatabaseSync, nodeId: string, input: {
  requestId: string; fingerprint: string; expectedRevision: number; description: string; explanation: string;
}, recordMetadata: (receipt: SovereigntyReceipt) => void): SovereigntyReceipt {
  readLocalSovereignty(db, nodeId);
  return withNodeLock(db, nodeId, () => {
    const current = readStored(db, nodeId);
    const previous = current.receipts.find(r => r.requestId === input.requestId);
    if (previous) {
      if (previous.fingerprint !== input.fingerprint)
        throw new SideraError("conflict", "Subjectivity request ID was reused");
      // Repair only metadata after a file publication / SQL commit interruption; no model re-execution.
      index(db, current);
      recordMetadata(previous);
      return previous;
    }
    if (current.revision !== input.expectedRevision)
      throw new SideraError("conflict", "Subjectivity revision changed");
    const receipt: SovereigntyReceipt = { requestId: input.requestId, fingerprint: input.fingerprint,
      revision: current.revision + 1, updatedAt: new Date().toISOString() };
    const next: StoredSovereignty = { ...current, description: input.description, explanation: input.explanation,
      revision: receipt.revision, updatedAt: receipt.updatedAt, receipts: [...current.receipts, receipt] };
    index(db, next);
    recordMetadata(receipt);
    // All SQL validation and metadata construction precede the sole canonical write. Its metadata receipt
    // remains in the private file if the surrounding SQL transaction is interrupted after publication.
    publish(db, nodeId, next);
    return receipt;
  });
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";

type Column = { name: string; pk: number };
type ForeignKey = { table: string; from: string; to: string };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const keys = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[])
  .filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);

/** Sidecar scope keeps old row shapes (and their exact routing/history) intact.
 * Assignments are authoritative, immutable records, not an active-World cache. */
export function migrateWorlds(db: DatabaseSync): void {
  db.exec("SAVEPOINT m1_worlds");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sidera_worlds (
        world_id TEXT PRIMARY KEY, label TEXT NOT NULL, provenance TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS semantic_migrations (
        migration_id TEXT PRIMARY KEY, compatibility_world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
        provenance TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS world_record_catalog (table_name TEXT PRIMARY KEY, key_columns TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_records (
        table_name TEXT NOT NULL REFERENCES world_record_catalog(table_name), record_key TEXT NOT NULL,
        world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), provenance TEXT NOT NULL,
        PRIMARY KEY(table_name,record_key)
      );
      CREATE INDEX IF NOT EXISTS records_by_world ON world_records(world_id,table_name);
      CREATE TRIGGER IF NOT EXISTS immutable_world_assignment BEFORE UPDATE ON world_records
        BEGIN SELECT RAISE(ABORT,'World assignment is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS retain_world_assignment BEFORE DELETE ON world_records
        BEGIN SELECT RAISE(ABORT,'World assignment history must be retained'); END;
    `);
    if (!db.prepare("SELECT 1 FROM semantic_migrations WHERE migration_id='M1'").get()) {
      const id = randomUUID(), at = new Date().toISOString();
      db.prepare("INSERT INTO sidera_worlds VALUES (?,?,?,?)").run(id, "Legacy import World",
        "M1 migration container; historical World membership was not recorded; Human owner UNKNOWN", at);
      db.prepare("INSERT INTO semantic_migrations VALUES ('M1',?,?,?)").run(id,
        "Explicit legacy import. Unscoped compatibility writes stay here; never follow a current/active World.", at);
    }
    const compatibility = literal(compatibilityWorld(db));
    // The catalog is frozen before M1 semantic tables are created. Never infer scope
    // for a newly introduced table merely because it happens to exist on restart.
    if (!db.prepare("SELECT 1 FROM world_record_catalog LIMIT 1").get()) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      for (const { name } of tables) {
        if (["sidera_worlds", "semantic_migrations", "world_record_catalog", "world_records"].includes(name)) continue;
        const pk = keys(db, name);
        if (!pk.length) throw new Error(`M1: table ${name} has no stable key`);
        db.prepare("INSERT INTO world_record_catalog VALUES (?,?)").run(name, JSON.stringify(pk));
      }
      for (const { table_name: table, key_columns } of catalog(db)) {
        const pk = JSON.parse(key_columns) as string[];
        db.exec(`INSERT INTO world_records SELECT ${literal(table)},json_array(${pk.map(quote).join(",")}),
          ${compatibility},'legacy_import: original World UNKNOWN' FROM ${quote(table)}`);
      }
    }
    for (const { table_name: table, key_columns } of catalog(db)) {
      const pk = JSON.parse(key_columns) as string[];
      const key = `json_array(${pk.map(c => `NEW.${quote(c)}`).join(",")})`;
      const oldKey = `json_array(${pk.map(c => `OLD.${quote(c)}`).join(",")})`;
      const lookup = (parent: string, expr: string) => `(SELECT world_id FROM world_records WHERE table_name=${literal(parent)} AND record_key=json_array(${expr}))`;
      const references = (db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as ForeignKey[])
        // Process owners are infrastructure: one Core may host several Worlds.
        .filter(f => f.table !== "execution_owners" && keys(db, f.table).length === 1)
        .map(f => lookup(f.table, `NEW.${quote(f.from)}`));
      const columns = (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[]).map(c => c.name);
      // A few old durable records predate declared FK constraints.
      for (const [column, parent] of [["actor_node_id", "nodes"], ["node_id", "nodes"], ["session_id", "sessions"], ["target_node_id", "nodes"]]) {
        if (columns.includes(column) && !references.includes(lookup(parent, `NEW.${quote(column)}`))) references.push(lookup(parent, `NEW.${quote(column)}`));
      }
      if (table === "events") for (const [field, parent] of [["targetNodeId","nodes"],["nodeId","nodes"],["subjectNodeId","nodes"],["taskId","tasks"],["responsibilityId","responsibilities"],["messageId","messages"],["sessionId","sessions"],["result.nodeId","nodes"],["result.sessionId","sessions"],["targetSessionId","sessions"],["grantId","grants"]])
        references.push(lookup(parent, `json_extract(NEW.payload,'$.${field}')`));
      if (table === "organization_actions") {
        references.push(lookup("nodes", "CASE WHEN NEW.actor LIKE 'node:%' THEN substr(NEW.actor,6) END"));
        for (const field of ["ownerNodeId", "nextOwnerNodeId", "subjectNodeId"]) references.push(lookup("nodes", `json_extract(NEW.input_json,'$.${field}')`));
      }
      const own = `(SELECT world_id FROM world_records WHERE table_name=${literal(table)} AND record_key=${key})`;
      const derived = `coalesce(${[own, ...references, compatibility].join(",")})`;
      const conflicts = references.map(ref => `(${ref} IS NOT NULL AND ${ref} != ${derived})`).join(" OR ") || "0";
      const workerGuard = table === "tasks" ? `SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.worker_node_ids) j
        WHERE NOT EXISTS(SELECT 1 FROM world_records w WHERE w.table_name='nodes' AND w.record_key=json_array(j.value) AND w.world_id=${derived}))
        THEN RAISE(ABORT,'Cross-World worker reference') END;` : "";
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${quote(`m1_scope_insert_${table}`)} AFTER INSERT ON ${quote(table)} BEGIN
          SELECT CASE WHEN ${conflicts} THEN RAISE(ABORT,'Cross-World reference') END;
          ${workerGuard}
          INSERT OR IGNORE INTO world_records VALUES (${literal(table)},${key},${derived},
            CASE WHEN coalesce(${[...references, "NULL", "NULL"].join(",")}) IS NULL THEN 'compatibility_unscoped: original World UNKNOWN' ELSE 'derived_from_durable_reference' END);
        END;
        CREATE TRIGGER IF NOT EXISTS ${quote(`m1_scope_update_${table}`)} BEFORE UPDATE ON ${quote(table)} BEGIN
          SELECT CASE WHEN ${oldKey} != ${key} THEN RAISE(ABORT,'Durable identity cannot be replaced') END;
          SELECT CASE WHEN ${conflicts} THEN RAISE(ABORT,'Cross-World reference') END;
          ${workerGuard}
        END;
      `);
    }
    db.exec("RELEASE m1_worlds");
  } catch (error) { db.exec("ROLLBACK TO m1_worlds; RELEASE m1_worlds"); throw error; }
}

function catalog(db: DatabaseSync) {
  return db.prepare("SELECT table_name,key_columns FROM world_record_catalog").all() as { table_name: string; key_columns: string }[];
}
export function compatibilityWorld(db: DatabaseSync): string {
  return String(db.prepare("SELECT compatibility_world_id FROM semantic_migrations WHERE migration_id='M1'").get()!.compatibility_world_id);
}
export function createWorld(db: DatabaseSync, label: string, provenance: string): string {
  if (!label.trim() || !provenance.trim()) throw new SideraError("conflict", "World requires explicit provenance");
  const id = randomUUID();
  db.prepare("INSERT INTO sidera_worlds VALUES (?,?,?,?)").run(id, label, provenance, new Date().toISOString());
  return id;
}
export function recordWorld(db: DatabaseSync, table: string, ...key: string[]): string {
  const row = db.prepare("SELECT world_id FROM world_records WHERE table_name=? AND record_key=?").get(table, JSON.stringify(key));
  if (!row) throw new SideraError("not_found", "No applicable World for durable record");
  return String(row.world_id);
}
export function requireWorld(db: DatabaseSync, worldId: string, table: string, ...key: string[]): void {
  if (recordWorld(db, table, ...key) !== worldId) throw new SideraError("denied", "Cross-World access is not supported");
}
/** Trusted registration helper. Must be inside the same transaction as node insert. */
export function scopeNewNode(db: DatabaseSync, worldId: string, nodeId: string): void {
  if (db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(nodeId)) throw new SideraError("conflict", "Cannot reassign an existing Node");
  db.prepare("INSERT INTO world_records VALUES ('nodes',?,?,?)").run(JSON.stringify([nodeId]), worldId, "explicit_node_registration");
}
export function readWorldRecord(db: DatabaseSync, worldId: string, table: string, key: string[]) {
  requireWorld(db, worldId, table, ...key);
  const entry = catalog(db).find(c => c.table_name === table);
  if (!entry) throw new SideraError("not_found", "Unknown scoped table");
  const pk = JSON.parse(entry.key_columns) as string[];
  if (pk.length !== key.length) throw new SideraError("conflict", "Invalid durable key");
  return db.prepare(`SELECT * FROM ${quote(table)} WHERE ${pk.map(c => `${quote(c)}=?`).join(" AND ")}`).get(...key);
}

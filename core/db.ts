import { migrateSharedTransfer } from "./shared-transfer.ts";
import { migrateResources } from "./resources.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateFrontendPresence } from "./frontend-presence.ts";
import { migrateFrontendRoutes } from "./frontend-route.ts";
import { migrateSupervision } from "./supervision.ts";
import { migrateWorlds } from "./worlds.ts";
import { migrateSemanticSubstrate } from "./semantic-schema.ts";
import { migrateTrust } from "./trust-schema.ts";
import { migrateEffectGate } from "./effect-gate.ts";
import { migrateHistory, installHistoryAdapters } from "./history.ts";
import { migrateOntology } from "./ontology.ts";
import { migrateSovereignty } from "./sovereignty-store.ts";
import { migrateAuthority } from "./authority.ts";
import { migrateRules } from "./rules.ts";
import { migrateExecutors } from "./executors.ts";
import { migrateCapabilityTruth } from "./capability-truth.ts";

const eventListeners = new WeakMap<DatabaseSync, Set<(eventId: string) => void>>();
export function onCommittedEvent(db: DatabaseSync, listener: (eventId: string) => void): () => void {
  const listeners = eventListeners.get(db) ?? new Set(); eventListeners.set(db,listeners);
  listeners.add(listener); return () => { listeners.delete(listener); };
}

export function withTransaction<T>(db: DatabaseSync, name: string, work: () => T): T {
  if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid transaction name");
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw error;
  }
}

/** Keep historical reservations while replacing the former temporary output cap. */
export function migrateDeepSeekCallAccounting(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deepseek_api_calls'")
    .get() as { sql: string } | undefined;
  if (!row) return;
  if (row.sql.includes("max_tokens > 0") && row.sql.includes("prompt_tokens INTEGER")) return;
  if (!row.sql.includes("max_tokens BETWEEN 1 AND 1024") &&
      !row.sql.includes("max_tokens BETWEEN 1 AND 4096"))
    throw new Error("Unknown DeepSeek call schema; inspect before migration");
  withTransaction(db, "deepseek_call_accounting", () => {
    db.exec("ALTER TABLE deepseek_api_calls RENAME TO deepseek_api_calls_legacy");
    db.exec(`CREATE TABLE deepseek_api_calls (
      call_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
      model_id TEXT NOT NULL,
      max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
      state TEXT NOT NULL CHECK (state IN ('started','accepted','completed','rejected','uncertain')),
      host_ref TEXT,
      finish_reason TEXT,
      prompt_tokens INTEGER CHECK (prompt_tokens >= 0),
      cached_prompt_tokens INTEGER CHECK (cached_prompt_tokens >= 0),
      completion_tokens INTEGER CHECK (completion_tokens >= 0),
      total_tokens INTEGER CHECK (total_tokens >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO deepseek_api_calls
      (call_id, session_id, message_id, model_id, max_tokens, state, host_ref,
       created_at, updated_at)
      SELECT call_id, session_id, message_id, model_id, max_tokens, state,
      host_ref, created_at, updated_at FROM deepseek_api_calls_legacy`);
    db.exec("DROP TABLE deepseek_api_calls_legacy");
  });
}

/** Rename the former single-provider storage in place; historical rows stay authoritative. */
export function migrateCompatibleProviderStorage(db: DatabaseSync): void {
  const legacyCalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deepseek_api_calls'").get();
  const genericCalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_calls'").get();
  if (legacyCalls && genericCalls) throw new Error("Both legacy and generic API call tables exist");
  const legacyHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deepseek_session_history'").get();
  const genericHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_session_history'").get();
  if (legacyHistory && genericHistory) throw new Error("Both legacy and generic API history tables exist");
  withTransaction(db, "api_storage_migration", () => {
    if (legacyCalls) {
      db.exec("ALTER TABLE deepseek_api_calls RENAME TO api_calls");
      db.exec("ALTER TABLE api_calls ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'deepseek'");
    }
    if (legacyHistory)
      db.exec("ALTER TABLE deepseek_session_history RENAME TO api_session_history");
  });
}

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  migrateDeepSeekCallAccounting(db);
  migrateCompatibleProviderStorage(db);
  migrateFrontendPresence(db);
  migrateFrontendRoutes(db);
  migrateSupervision(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_lineage (
      lineage_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      kind TEXT NOT NULL CHECK (kind IN ('origin', 'model_bind', 'model_migration', 'fork')),
      parent_lineage_id TEXT REFERENCES identity_lineage(lineage_id),
      source_node_id TEXT REFERENCES nodes(node_id),
      source_self_head TEXT,
      from_binding_id TEXT,
      to_binding_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_identity (
      node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
      identity_metadata TEXT NOT NULL DEFAULT '{}',
      self_state TEXT NOT NULL DEFAULT '{}',
      active_self_head TEXT NOT NULL UNIQUE,
      lineage_ref TEXT NOT NULL REFERENCES identity_lineage(lineage_id)
    );
    CREATE TABLE IF NOT EXISTS node_subjectivity (
      node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
      description TEXT NOT NULL DEFAULT '',
      explanation TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS initialize_node_subjectivity AFTER INSERT ON nodes BEGIN
      INSERT INTO node_subjectivity (node_id, updated_at)
        VALUES (NEW.node_id, NEW.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS initialize_node_identity AFTER INSERT ON nodes BEGIN
      INSERT INTO identity_lineage
        (lineage_id, node_id, kind, created_at)
        VALUES ('origin:' || NEW.node_id, NEW.node_id, 'origin', NEW.created_at);
      INSERT INTO node_identity
        (node_id, active_self_head, lineage_ref)
        VALUES (NEW.node_id, lower(hex(randomblob(16))), 'origin:' || NEW.node_id);
    END;
    CREATE TABLE IF NOT EXISTS model_bindings (
      binding_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reasoning_config TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      migration_from TEXT REFERENCES model_bindings(binding_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_current_model_per_node
      ON model_bindings(node_id) WHERE valid_until IS NULL;
    CREATE TABLE IF NOT EXISTS sovereign_memory (
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      memory_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (node_id, memory_key)
    );
    CREATE TABLE IF NOT EXISTS identity_actions (
      actor_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (actor_node_id, request_id)
    );
    INSERT OR IGNORE INTO identity_lineage (lineage_id, node_id, kind, created_at)
      SELECT 'origin:' || node_id, node_id, 'origin', created_at FROM nodes;
    INSERT OR IGNORE INTO node_identity (node_id, active_self_head, lineage_ref)
      SELECT node_id, lower(hex(randomblob(16))), 'origin:' || node_id FROM nodes;
    INSERT OR IGNORE INTO node_subjectivity (node_id, updated_at)
      SELECT node_id, created_at FROM nodes;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      hythe_id TEXT NOT NULL,
      host_kind TEXT NOT NULL,
      locator_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'standby', 'retired')),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_node
      ON sessions(node_id) WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS api_session_history (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      messages_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY,
      subject_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      capability TEXT NOT NULL,
      resource_scope TEXT NOT NULL,
      issuer TEXT NOT NULL,
      expires_at TEXT,
      use_limit INTEGER,
      risk_ceiling INTEGER CHECK (risk_ceiling BETWEEN 0 AND 3),
      delegable INTEGER NOT NULL DEFAULT 0,
      parent_grant_id TEXT REFERENCES grants(grant_id),
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS grant_requests (
      issuer TEXT NOT NULL,
      request_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      grant_id TEXT NOT NULL REFERENCES grants(grant_id),
      PRIMARY KEY (issuer, request_id)
    );
    CREATE TABLE IF NOT EXISTS grant_revocations (
      actor TEXT NOT NULL,
      request_id TEXT NOT NULL,
      grant_id TEXT NOT NULL REFERENCES grants(grant_id),
      PRIMARY KEY (actor, request_id)
    );
    CREATE TABLE IF NOT EXISTS grant_uses (
      reservation_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES grants(grant_id),
      request_id TEXT NOT NULL,
      subject_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      capability TEXT NOT NULL,
      resource TEXT NOT NULL,
      risk_level INTEGER NOT NULL DEFAULT 3 CHECK (risk_level BETWEEN 0 AND 3),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
      UNIQUE(subject_node_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      origin_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      center_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      worker_node_ids TEXT NOT NULL,
      state TEXT NOT NULL,
      budget_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(origin_node_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(task_id),
      from_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      to_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      target_session_id TEXT NOT NULL REFERENCES sessions(session_id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      host_ref TEXT,
      reservation_id TEXT REFERENCES grant_uses(reservation_id),
      created_at TEXT NOT NULL,
      UNIQUE(from_node_id, request_id),
      UNIQUE(target_session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS api_calls (
      call_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
      state TEXT NOT NULL CHECK (state IN ('started','accepted','completed','rejected','uncertain')),
      host_ref TEXT,
      finish_reason TEXT,
      prompt_tokens INTEGER CHECK (prompt_tokens >= 0),
      cached_prompt_tokens INTEGER CHECK (cached_prompt_tokens >= 0),
      completion_tokens INTEGER CHECK (completion_tokens >= 0),
      total_tokens INTEGER CHECK (total_tokens >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      actor_node_id TEXT REFERENCES nodes(node_id),
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_appointments (
      appointment_id TEXT PRIMARY KEY,
      subject_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      role TEXT NOT NULL CHECK (role IN ('ChiefSupervisor','Supervisor','Worker','Reviewer')),
      scope TEXT NOT NULL,
      label TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS responsibilities (
      responsibility_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      scope TEXT NOT NULL,
      owner_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      parent_responsibility_id TEXT REFERENCES responsibilities(responsibility_id),
      state TEXT NOT NULL CHECK (state IN ('active','completed','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS responsibilities_by_owner
      ON responsibilities(owner_node_id, state);
    CREATE TABLE IF NOT EXISTS organization_actions (
      actor TEXT NOT NULL,
      request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (actor, request_id)
    );
    CREATE TABLE IF NOT EXISTS peregrines (
      peregrine_id TEXT PRIMARY KEY,
      owner_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      workspace_ref TEXT NOT NULL,
      home_ref TEXT NOT NULL,
      temp_ref TEXT NOT NULL,
      state TEXT NOT NULL,
      backend TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_origins (
      task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
      session_id TEXT NOT NULL REFERENCES sessions(session_id)
    );
    CREATE TABLE IF NOT EXISTS chief_conversations (
      binding_id TEXT PRIMARY KEY,
      project_space_id TEXT NOT NULL,
      project_ref TEXT NOT NULL,
      chief_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      frontend_kind TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active','retired')),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_chief_conversation_per_project
      ON chief_conversations(project_space_id) WHERE state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS one_project_per_chief_conversation
      ON chief_conversations(frontend_kind,conversation_ref) WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS chief_actions (
      chief_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      request_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (chief_node_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS chief_task_routes (
      task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
      binding_id TEXT NOT NULL REFERENCES chief_conversations(binding_id)
    );
    CREATE TABLE IF NOT EXISTS chief_presentations (
      message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
      binding_id TEXT NOT NULL REFERENCES chief_conversations(binding_id),
      state TEXT NOT NULL CHECK (state IN ('sending','delivered','blocked','uncertain')),
      host_ref TEXT,
      reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
      state TEXT NOT NULL CHECK (state IN ('running','waiting_dependency','completed','failed','uncertain')),
      turn_open INTEGER NOT NULL DEFAULT 0,
      checkpoint TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (
      parent_run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id),
      child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
      state TEXT NOT NULL CHECK (state IN ('waiting','satisfied','resumed','failed','uncertain')),
      result_message_id TEXT REFERENCES messages(message_id),
      continuation_run_id TEXT REFERENCES task_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS gpt_result_callbacks (
      run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id),
      message_id TEXT NOT NULL REFERENCES messages(message_id),
      request_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  const grantColumns = db.prepare("PRAGMA table_info(grants)").all() as { name: string }[];
  if (!grantColumns.some(column => column.name === "risk_ceiling"))
    db.exec("ALTER TABLE grants ADD COLUMN risk_ceiling INTEGER CHECK (risk_ceiling BETWEEN 0 AND 3)");
  if (!grantColumns.some(column => column.name === "revoked_at"))
    db.exec("ALTER TABLE grants ADD COLUMN revoked_at TEXT");
  const useColumns = db.prepare("PRAGMA table_info(grant_uses)").all() as { name: string }[];
  if (!useColumns.some(column => column.name === "risk_level"))
    db.exec("ALTER TABLE grant_uses ADD COLUMN risk_level INTEGER NOT NULL DEFAULT 3 CHECK (risk_level BETWEEN 0 AND 3)");
  withTransaction(db, "coherence_schema", () => {
  const responsibilityColumns = db.prepare("PRAGMA table_info(responsibilities)").all() as { name: string }[];
  if (!responsibilityColumns.some(column => column.name === "accepted_at")) {
    // Existing accepted assignments remain accepted; new cross-subject proposals require acceptance.
    db.exec("ALTER TABLE responsibilities ADD COLUMN accepted_at TEXT");
    db.exec("UPDATE responsibilities SET accepted_at = created_at");
  }
  if (!responsibilityColumns.some(column => column.name === "deferred_at")) {
    db.exec("ALTER TABLE responsibilities ADD COLUMN deferred_at TEXT");
    db.exec("ALTER TABLE responsibilities ADD COLUMN deferred_reason TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS tensions (
      tension_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      kind TEXT NOT NULL CHECK (kind IN ('commitment','subjective','evidence','coordination')),
      statement TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','waiting','resolved','relinquished','escalated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      responsibility_id TEXT REFERENCES responsibilities(responsibility_id),
      CHECK ((kind = 'commitment') = (responsibility_id IS NOT NULL)),
      UNIQUE (node_id, responsibility_id)
    );
    CREATE INDEX IF NOT EXISTS tensions_by_node ON tensions(node_id, status);
    DROP TRIGGER IF EXISTS protect_commitment_status;
    DROP TRIGGER IF EXISTS responsibility_tension_insert;
    DROP TRIGGER IF EXISTS responsibility_tension_update;
    CREATE TRIGGER protect_commitment_status BEFORE UPDATE OF status ON tensions
    WHEN NEW.kind = 'commitment' AND EXISTS (
      SELECT 1 FROM responsibilities r WHERE r.responsibility_id = NEW.responsibility_id
        AND r.owner_node_id = NEW.node_id AND r.state = 'active' AND r.accepted_at IS NOT NULL
        AND NEW.status != CASE WHEN r.deferred_at IS NULL THEN 'open' ELSE 'waiting' END
    ) BEGIN SELECT RAISE(ABORT, 'Unresolved accepted Responsibility cannot be erased'); END;
    CREATE TRIGGER IF NOT EXISTS responsibility_tension_insert AFTER INSERT ON responsibilities
    WHEN NEW.state = 'active' AND NEW.accepted_at IS NOT NULL BEGIN
      INSERT INTO tensions VALUES (lower(hex(randomblob(16))), NEW.owner_node_id, 'commitment',
        'Accepted responsibility remains unsatisfied: ' || NEW.title,
        json_array(json_object('kind','responsibility','id',NEW.responsibility_id)),
        CASE WHEN NEW.deferred_at IS NULL THEN 'open' ELSE 'waiting' END,
        NEW.created_at, NEW.updated_at, NEW.responsibility_id);
    END;
    CREATE TRIGGER IF NOT EXISTS responsibility_tension_update AFTER UPDATE ON responsibilities BEGIN
      UPDATE tensions SET status = CASE WHEN NEW.state = 'completed' THEN 'resolved' ELSE 'relinquished' END,
        updated_at = NEW.updated_at
        WHERE responsibility_id = NEW.responsibility_id AND kind = 'commitment'
          AND (node_id != NEW.owner_node_id OR NEW.state != 'active' OR NEW.accepted_at IS NULL);
      INSERT INTO tensions
        SELECT lower(hex(randomblob(16))), NEW.owner_node_id, 'commitment',
          'Accepted responsibility remains unsatisfied: ' || NEW.title,
          json_array(json_object('kind','responsibility','id',NEW.responsibility_id)),
          CASE WHEN NEW.deferred_at IS NULL THEN 'open' ELSE 'waiting' END,
          NEW.updated_at, NEW.updated_at, NEW.responsibility_id
        WHERE NEW.state = 'active' AND NEW.accepted_at IS NOT NULL
        ON CONFLICT(node_id, responsibility_id) DO UPDATE SET status = excluded.status, updated_at = NEW.updated_at;
    END;
    INSERT OR IGNORE INTO tensions
      SELECT lower(hex(randomblob(16))), owner_node_id, 'commitment',
        'Accepted responsibility remains unsatisfied: ' || title,
        json_array(json_object('kind','responsibility','id',responsibility_id)),
        CASE WHEN deferred_at IS NULL THEN 'open' ELSE 'waiting' END,
        created_at, updated_at, responsibility_id FROM responsibilities
        WHERE state = 'active' AND accepted_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS tension_actions (
      node_id TEXT NOT NULL REFERENCES nodes(node_id), request_id TEXT NOT NULL,
      input_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(node_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS run_checkpoints (
      run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id), request_id TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK(outcome IN ('CONTINUE','WAIT','IDLE')),
      tension_id TEXT REFERENCES tensions(tension_id), checkpoint TEXT NOT NULL,
      progress_refs TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_wakes (
      run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id), from_session_id TEXT NOT NULL,
      to_session_id TEXT, state TEXT NOT NULL CHECK(state IN ('intent','ready','uncertain')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_wakes (
      wake_id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(node_id),
      from_session_id TEXT NOT NULL REFERENCES sessions(session_id),
      to_session_id TEXT REFERENCES sessions(session_id),
      state TEXT NOT NULL CHECK(state IN ('intent','ready','uncertain')),
      created_at TEXT NOT NULL
    );
  `);
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_activations(from_session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),request_id TEXT NOT NULL,state TEXT NOT NULL,to_session_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_owners(owner_id TEXT PRIMARY KEY,pid INTEGER NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_execution_owners(run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id),owner_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS authority_constraints(constraint_id TEXT PRIMARY KEY,subject_node_id TEXT NOT NULL REFERENCES nodes(node_id),resource_scope TEXT NOT NULL,reason TEXT NOT NULL,issuer TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS capability_manifests(node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),manifest_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_reconciliations(event_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_health(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),state TEXT NOT NULL,event_id TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_observations(event_id TEXT NOT NULL REFERENCES events(event_id),target_node_id TEXT NOT NULL REFERENCES nodes(node_id),state TEXT NOT NULL,message_id TEXT,PRIMARY KEY(event_id,target_node_id));
    CREATE TABLE IF NOT EXISTS runtime_event_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),event_id TEXT NOT NULL,target_node_id TEXT NOT NULL);
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS freeze_sovereign_memory_insert BEFORE INSERT ON sovereign_memory BEGIN SELECT RAISE(ABORT,'Historical sovereign_memory is read-only'); END;
    CREATE TRIGGER IF NOT EXISTS freeze_sovereign_memory_update BEFORE UPDATE ON sovereign_memory BEGIN SELECT RAISE(ABORT,'Historical sovereign_memory is read-only'); END;
    CREATE TRIGGER IF NOT EXISTS freeze_sovereign_memory_delete BEFORE DELETE ON sovereign_memory BEGIN SELECT RAISE(ABORT,'Historical sovereign_memory is read-only'); END;
    CREATE TRIGGER IF NOT EXISTS freeze_self_state BEFORE UPDATE OF self_state ON node_identity WHEN NEW.self_state != OLD.self_state BEGIN SELECT RAISE(ABORT,'Historical self_state is read-only'); END;
  `);
  try { withTransaction(db, "semantic_substrate", () => {
    migrateWorlds(db);
    migrateSemanticSubstrate(db);
    migrateTrust(db);
    migrateEffectGate(db);
    migrateSharedTransfer(db);
    migrateResources(db);
    migrateHistory(db);
    migrateOntology(db);
    migrateAuthority(db);
    migrateRules(db);
    migrateExecutors(db);
    migrateCapabilityTruth(db);
    installHistoryAdapters(db);
  }); } catch (error) { db.close(); throw error; }
  // Local Sovereignty has its own crash-safe publication boundary. A failed
  // migration leaves legacy rows readable and never substitutes empty documents.
  try { migrateSovereignty(db, file); } catch(error) { db.close(); throw error; }
  db.function("sidera_publish_event", (id) => {
    const eventId = String(id);
    queueMicrotask(() => {
      try { if (db.prepare("SELECT 1 FROM events WHERE event_id=?").get(eventId))
        for (const listener of eventListeners.get(db) ?? []) listener(eventId); }
      catch { /* A closed connection or rolled-back transaction cannot publish. */ }
    }); return null;
  });
  db.exec(`CREATE TRIGGER IF NOT EXISTS publish_committed_event AFTER INSERT ON events
    BEGIN SELECT sidera_publish_event(NEW.event_id); END;`);
  return db;
}

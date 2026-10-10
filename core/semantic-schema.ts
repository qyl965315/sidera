import type { DatabaseSync } from "node:sqlite";

/** Additive M1 nouns. No Effect Permit, admission decision or send fence lives here. */
export function migrateSemanticSubstrate(db: DatabaseSync): void {
  db.exec("SAVEPOINT m1_semantics");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS human_principals (
        human_id TEXT PRIMARY KEY, label TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS world_humans (
        world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), human_id TEXT NOT NULL REFERENCES human_principals(human_id),
        provenance TEXT NOT NULL, PRIMARY KEY(world_id,human_id)
      );
      CREATE TABLE IF NOT EXISTS external_identities (
        identity_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, human_id TEXT NOT NULL,
        provider TEXT NOT NULL, external_subject_ref TEXT NOT NULL, provenance TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','suspended','unavailable','lost')),
        created_at TEXT NOT NULL, UNIQUE(world_id,identity_id),
        FOREIGN KEY(world_id,human_id) REFERENCES world_humans(world_id,human_id)
      );
      CREATE TABLE IF NOT EXISTS entitlements (
        entitlement_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, identity_id TEXT NOT NULL,
        rule_json TEXT NOT NULL CHECK(json_valid(rule_json)), source_ref TEXT NOT NULL,
        valid_from TEXT NOT NULL, valid_until TEXT, UNIQUE(world_id,entitlement_id),
        FOREIGN KEY(world_id,identity_id) REFERENCES external_identities(world_id,identity_id)
      );
      CREATE TABLE IF NOT EXISTS resource_observations (
        observation_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, entitlement_id TEXT NOT NULL,
        knowledge TEXT NOT NULL CHECK(knowledge IN ('KNOWN','UNKNOWN')),
        value_json TEXT CHECK(value_json IS NULL OR json_valid(value_json)), source_ref TEXT NOT NULL,
        observed_at TEXT NOT NULL, fresh_until TEXT,
        CHECK(knowledge!='UNKNOWN' OR value_json IS NULL),
        FOREIGN KEY(world_id,entitlement_id) REFERENCES entitlements(world_id,entitlement_id)
      );
      CREATE TABLE IF NOT EXISTS intents (
        intent_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, human_id TEXT NOT NULL, provenance TEXT NOT NULL,
        UNIQUE(world_id,intent_id), FOREIGN KEY(world_id,human_id) REFERENCES world_humans(world_id,human_id)
      );
      CREATE TABLE IF NOT EXISTS intent_revisions (
        revision_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, intent_id TEXT NOT NULL,
        parent_revision_id TEXT, content TEXT NOT NULL, source_ref TEXT NOT NULL, recorded_at TEXT NOT NULL,
        UNIQUE(world_id,revision_id), UNIQUE(world_id,intent_id,revision_id),
        FOREIGN KEY(world_id,intent_id) REFERENCES intents(world_id,intent_id),
        FOREIGN KEY(world_id,intent_id,parent_revision_id) REFERENCES intent_revisions(world_id,intent_id,revision_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_intent_root ON intent_revisions(intent_id) WHERE parent_revision_id IS NULL;
      CREATE TABLE IF NOT EXISTS responsibility_bases (
        responsibility_id TEXT PRIMARY KEY REFERENCES responsibilities(responsibility_id),
        world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), intent_revision_id TEXT,
        context_basis_json TEXT NOT NULL CHECK(json_valid(context_basis_json)), provenance TEXT NOT NULL,
        UNIQUE(world_id,responsibility_id),
        FOREIGN KEY(world_id,intent_revision_id) REFERENCES intent_revisions(world_id,revision_id)
      );
      CREATE TABLE IF NOT EXISTS task_bases (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
        responsibility_id TEXT, intent_revision_id TEXT, context_basis_json TEXT NOT NULL CHECK(json_valid(context_basis_json)),
        provenance TEXT NOT NULL, UNIQUE(world_id,task_id),
        FOREIGN KEY(world_id,responsibility_id) REFERENCES responsibility_bases(world_id,responsibility_id),
        FOREIGN KEY(world_id,intent_revision_id) REFERENCES intent_revisions(world_id,revision_id)
      );
      CREATE TABLE IF NOT EXISTS run_bases (
        run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id), world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
        responsibility_id TEXT, intent_revision_id TEXT, context_basis_json TEXT NOT NULL CHECK(json_valid(context_basis_json)),
        provenance TEXT NOT NULL, UNIQUE(world_id,run_id),
        FOREIGN KEY(world_id,responsibility_id) REFERENCES responsibility_bases(world_id,responsibility_id),
        FOREIGN KEY(world_id,intent_revision_id) REFERENCES intent_revisions(world_id,revision_id)
      );
      CREATE TABLE IF NOT EXISTS logical_actions (
        action_id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
        actor_node_id TEXT NOT NULL REFERENCES nodes(node_id), target_node_id TEXT NOT NULL REFERENCES nodes(node_id),
        operation TEXT NOT NULL, semantic_ref TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(world_id,action_id)
      );
      CREATE TABLE IF NOT EXISTS message_actions (
        message_id TEXT PRIMARY KEY REFERENCES messages(message_id), world_id TEXT NOT NULL,
        action_id TEXT NOT NULL, FOREIGN KEY(world_id,action_id) REFERENCES logical_actions(world_id,action_id)
      );
      CREATE TABLE IF NOT EXISTS action_runs (
        action_id TEXT NOT NULL, world_id TEXT NOT NULL, run_id TEXT NOT NULL,
        PRIMARY KEY(action_id,run_id), FOREIGN KEY(world_id,action_id) REFERENCES logical_actions(world_id,action_id),
        FOREIGN KEY(world_id,run_id) REFERENCES run_bases(world_id,run_id)
      );
      CREATE TABLE IF NOT EXISTS action_attempts (
        attempt_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, action_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>0), fence_token TEXT NOT NULL UNIQUE,
        target_session_id TEXT NOT NULL REFERENCES sessions(session_id), host_kind TEXT NOT NULL,
        locator_ref TEXT NOT NULL, source_message_id TEXT REFERENCES messages(message_id),
        provenance TEXT NOT NULL, recorded_at TEXT NOT NULL,
        UNIQUE(action_id,generation), UNIQUE(world_id,attempt_id),
        FOREIGN KEY(world_id,action_id) REFERENCES logical_actions(world_id,action_id)
      );
      CREATE TABLE IF NOT EXISTS attempt_observations (
        observation_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        state TEXT NOT NULL, source_ref TEXT NOT NULL, recorded_at TEXT NOT NULL,
        FOREIGN KEY(world_id,attempt_id) REFERENCES action_attempts(world_id,attempt_id)
      );
      CREATE TABLE IF NOT EXISTS feasibility_assessments (
        assessment_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, action_id TEXT NOT NULL,
        executable TEXT NOT NULL CHECK(executable IN ('true','false','unknown')), source_ref TEXT NOT NULL,
        assessed_at TEXT NOT NULL, fresh_until TEXT,
        FOREIGN KEY(world_id,action_id) REFERENCES logical_actions(world_id,action_id)
      );
    `);
    // Repeatable imports only fill absent records; missing historical truth remains NULL.
    for (const [table, id, target] of [["responsibilities","responsibility_id","responsibility_bases"], ["tasks","task_id","task_bases"], ["task_runs","run_id","run_bases"]]) {
      db.exec(`INSERT OR IGNORE INTO ${target} (${id},world_id,intent_revision_id,context_basis_json,provenance)
        SELECT s.${id},w.world_id,NULL,'[]','legacy_import: Intent and context UNKNOWN'
        FROM ${table} s JOIN world_records w ON w.table_name='${table}' AND w.record_key=json_array(s.${id});`);
    }
    db.exec(`
      INSERT OR IGNORE INTO logical_actions
        SELECT 'legacy-message:'||m.message_id,w.world_id,m.from_node_id,m.to_node_id,'message.receive',m.message_id,
          'legacy_import: historical logical identity UNKNOWN; transport record wrapper',m.created_at
        FROM messages m JOIN world_records w ON w.table_name='messages' AND w.record_key=json_array(m.message_id)
        WHERE NOT EXISTS(SELECT 1 FROM message_actions a WHERE a.message_id=m.message_id);
      INSERT OR IGNORE INTO message_actions
        SELECT m.message_id,a.world_id,a.action_id FROM messages m JOIN logical_actions a ON a.action_id='legacy-message:'||m.message_id;
      INSERT OR IGNORE INTO action_runs SELECT a.action_id,b.world_id,r.run_id
        FROM task_runs r JOIN message_actions a USING(message_id) JOIN run_bases b USING(run_id);
    `);
    // Exact immutable basis at insertion, including explicit UNKNOWN for old API callers.
    for (const [table, id, target] of [["responsibilities","responsibility_id","responsibility_bases"], ["tasks","task_id","task_bases"]]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS m1_basis_${table} AFTER INSERT ON ${table} BEGIN
        INSERT OR IGNORE INTO ${target} (${id},world_id,intent_revision_id,context_basis_json,provenance)
        SELECT NEW.${id},w.world_id,NULL,'[]','compatibility_call: basis UNKNOWN' FROM world_records w
          WHERE w.table_name='nodes' AND w.record_key=json_array(NEW.${table === "tasks" ? "origin_node_id" : "owner_node_id"}); END;`);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS m1_run_basis AFTER INSERT ON task_runs BEGIN
        INSERT INTO run_bases SELECT NEW.run_id,world_id,responsibility_id,intent_revision_id,context_basis_json,provenance
          FROM task_bases WHERE task_id=NEW.task_id;
        INSERT INTO action_runs SELECT a.action_id,a.world_id,NEW.run_id FROM message_actions a WHERE a.message_id=NEW.message_id;
      END;
      CREATE TRIGGER IF NOT EXISTS m1_action_scope BEFORE INSERT ON logical_actions BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM world_records WHERE table_name='nodes' AND record_key=json_array(NEW.actor_node_id) AND world_id=NEW.world_id)
          OR NOT EXISTS(SELECT 1 FROM world_records WHERE table_name='nodes' AND record_key=json_array(NEW.target_node_id) AND world_id=NEW.world_id)
          THEN RAISE(ABORT,'Cross-World logical action') END;
      END;
      CREATE TRIGGER IF NOT EXISTS m1_attempt_target BEFORE INSERT ON action_attempts BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM logical_actions a JOIN sessions s ON s.node_id=a.target_node_id
          WHERE a.action_id=NEW.action_id AND a.world_id=NEW.world_id AND s.session_id=NEW.target_session_id
          AND s.host_kind=NEW.host_kind AND s.locator_ref=NEW.locator_ref)
          THEN RAISE(ABORT,'Attempt Presence does not belong to durable target') END;
      END;
      CREATE TRIGGER IF NOT EXISTS m1_transport_observation AFTER UPDATE OF state ON messages
        WHEN NEW.state != OLD.state BEGIN
        INSERT INTO attempt_observations SELECT lower(hex(randomblob(16))),a.world_id,a.attempt_id,
          'transport:'||NEW.state,'message:'||NEW.message_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM action_attempts a WHERE a.source_message_id=NEW.message_id
          AND a.generation=(SELECT max(generation) FROM action_attempts WHERE action_id=a.action_id);
      END;
      CREATE TRIGGER IF NOT EXISTS m1_responsibility_basis_guard BEFORE UPDATE ON responsibility_bases
        WHEN OLD.provenance!='compatibility_call: basis UNKNOWN' OR NEW.responsibility_id!=OLD.responsibility_id
          OR NEW.world_id!=OLD.world_id OR EXISTS(SELECT 1 FROM task_bases WHERE responsibility_id=OLD.responsibility_id)
        BEGIN SELECT RAISE(ABORT,'Recorded Responsibility basis is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS m1_task_basis_guard BEFORE UPDATE ON task_bases
        WHEN OLD.provenance!='compatibility_call: basis UNKNOWN' OR NEW.task_id!=OLD.task_id OR NEW.world_id!=OLD.world_id
          OR EXISTS(SELECT 1 FROM task_runs WHERE task_id=OLD.task_id)
        BEGIN SELECT RAISE(ABORT,'Recorded Task basis is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS m1_external_identity_provenance BEFORE UPDATE ON external_identities
        WHEN NEW.identity_id!=OLD.identity_id OR NEW.world_id!=OLD.world_id OR NEW.human_id!=OLD.human_id
          OR NEW.provider!=OLD.provider OR NEW.external_subject_ref!=OLD.external_subject_ref OR NEW.provenance!=OLD.provenance
        BEGIN SELECT RAISE(ABORT,'ExternalIdentity rebind is not implemented'); END;
    `);
    for (const [table, id, source, root, rootId] of [
      ["responsibility_bases","responsibility_id","responsibilities","nodes","owner_node_id"],
      ["task_bases","task_id","tasks","nodes","origin_node_id"],
      ["run_bases","run_id","task_runs","tasks","task_id"],
      ["message_actions","message_id","messages","nodes","from_node_id"],
    ]) db.exec(`CREATE TRIGGER IF NOT EXISTS m1_validate_world_${table} BEFORE INSERT ON ${table} BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ${source} s JOIN world_records w ON w.table_name='${root}'
        AND w.record_key=json_array(s.${rootId}) WHERE s.${id}=NEW.${id} AND w.world_id=NEW.world_id)
        THEN RAISE(ABORT,'Semantic record must belong to source World') END; END;`);
    for(const table of ["external_identities","responsibility_bases","task_bases"])
      db.exec(`CREATE TRIGGER IF NOT EXISTS m1_retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Semantic history must be retained'); END;`);
    for (const table of ["human_principals","world_humans","entitlements","resource_observations","intents","intent_revisions","run_bases","logical_actions","message_actions","action_runs","action_attempts","attempt_observations","feasibility_assessments"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS m1_retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Semantic history is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS m1_immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Semantic history is immutable'); END;`);
    }
    db.exec("RELEASE m1_semantics");
  } catch (error) { db.exec("ROLLBACK TO m1_semantics; RELEASE m1_semantics"); throw error; }
}

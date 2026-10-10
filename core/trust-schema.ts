import type { DatabaseSync } from "node:sqlite";

export function migrateTrust(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_policy (
      world_id TEXT PRIMARY KEY REFERENCES sidera_worlds(world_id), epoch INTEGER NOT NULL,
      version TEXT NOT NULL, delegation_enabled INTEGER NOT NULL CHECK(delegation_enabled=0)
    );
    INSERT OR IGNORE INTO trust_policy SELECT world_id,1,'r1.1-explicit-human-v1',0 FROM sidera_worlds;
    CREATE TRIGGER IF NOT EXISTS initialize_trust_policy AFTER INSERT ON sidera_worlds BEGIN
      INSERT INTO trust_policy VALUES (NEW.world_id,1,'r1.1-explicit-human-v1',0); END;
    CREATE TABLE IF NOT EXISTS human_frontend_sources (
      source_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, human_id TEXT NOT NULL,
      presence_ref TEXT NOT NULL, source_ref TEXT NOT NULL, active INTEGER NOT NULL,
      UNIQUE(world_id,source_id), FOREIGN KEY(world_id,human_id) REFERENCES world_humans(world_id,human_id)
    );
    CREATE TABLE IF NOT EXISTS human_utterances (
      utterance_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, source_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL, body TEXT NOT NULL, explicit_act_json TEXT,
      clarification_of TEXT REFERENCES human_utterances(utterance_id), recorded_at TEXT NOT NULL,
      UNIQUE(source_id,external_message_id), UNIQUE(world_id,utterance_id),
      FOREIGN KEY(world_id,source_id) REFERENCES human_frontend_sources(world_id,source_id)
    );
    CREATE TABLE IF NOT EXISTS interpretation_claims (
      claim_id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      node_id TEXT NOT NULL REFERENCES nodes(node_id), utterance_id TEXT, proposal_json TEXT NOT NULL,
      confidence REAL, confirmed_claim INTEGER NOT NULL, recorded_at TEXT NOT NULL,
      FOREIGN KEY(world_id,utterance_id) REFERENCES human_utterances(world_id,utterance_id)
    );
    CREATE TABLE IF NOT EXISTS human_semantic_acts (
      act_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, human_id TEXT NOT NULL,
      source_id TEXT NOT NULL, utterance_id TEXT NOT NULL UNIQUE,
      act_type TEXT NOT NULL, object_ref TEXT NOT NULL, scope TEXT NOT NULL, target_revision TEXT,
      args_json TEXT NOT NULL, policy_version TEXT NOT NULL, policy_epoch INTEGER NOT NULL,
      causal_refs_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
      UNIQUE(world_id,act_id), FOREIGN KEY(world_id,human_id) REFERENCES world_humans(world_id,human_id),
      FOREIGN KEY(world_id,source_id) REFERENCES human_frontend_sources(world_id,source_id),
      FOREIGN KEY(world_id,utterance_id) REFERENCES human_utterances(world_id,utterance_id)
    );
    CREATE TABLE IF NOT EXISTS human_act_applications (
      act_id TEXT PRIMARY KEY REFERENCES human_semantic_acts(act_id), mutation_type TEXT NOT NULL,
      mutation_json TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grant_provenance (
      grant_id TEXT PRIMARY KEY REFERENCES grants(grant_id), world_id TEXT NOT NULL,
      human_act_id TEXT NOT NULL, product_scope TEXT NOT NULL, effect_scope TEXT NOT NULL,
      disclosure_scope TEXT NOT NULL, FOREIGN KEY(world_id,human_act_id) REFERENCES human_semantic_acts(world_id,act_id)
    );
    CREATE TABLE IF NOT EXISTS authority_epochs (
      world_id TEXT PRIMARY KEY REFERENCES sidera_worlds(world_id), epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS effect_policy (
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), product TEXT NOT NULL,
      capability TEXT NOT NULL, requires_human INTEGER NOT NULL CHECK(requires_human IN (0,1)),
      human_act_id TEXT NOT NULL REFERENCES human_semantic_acts(act_id), PRIMARY KEY(world_id,product,capability)
    );
    INSERT OR IGNORE INTO authority_epochs SELECT world_id,1 FROM sidera_worlds;
    CREATE TRIGGER IF NOT EXISTS initialize_authority_epoch AFTER INSERT ON sidera_worlds BEGIN
      INSERT INTO authority_epochs VALUES (NEW.world_id,1); END;
    CREATE TRIGGER IF NOT EXISTS authority_grant_epoch AFTER UPDATE ON grants BEGIN
      UPDATE authority_epochs SET epoch=epoch+1 WHERE world_id=(SELECT world_id FROM world_records
        WHERE table_name='nodes' AND record_key=json_array(NEW.subject_node_id)); END;
    CREATE TRIGGER IF NOT EXISTS authority_grant_epoch_insert AFTER INSERT ON grants BEGIN
      UPDATE authority_epochs SET epoch=epoch+1 WHERE world_id=(SELECT world_id FROM world_records
        WHERE table_name='nodes' AND record_key=json_array(NEW.subject_node_id)); END;
    CREATE TRIGGER IF NOT EXISTS authority_grant_epoch_delete AFTER DELETE ON grants BEGIN
      UPDATE authority_epochs SET epoch=epoch+1 WHERE world_id=(SELECT world_id FROM world_records
        WHERE table_name='nodes' AND record_key=json_array(OLD.subject_node_id)); END;
    CREATE TRIGGER IF NOT EXISTS authority_grant_scope_immutable BEFORE UPDATE ON grants
      WHEN NEW.grant_id IS NOT OLD.grant_id OR NEW.subject_node_id IS NOT OLD.subject_node_id
        OR NEW.capability IS NOT OLD.capability OR NEW.resource_scope IS NOT OLD.resource_scope
        OR NEW.issuer IS NOT OLD.issuer OR NEW.expires_at IS NOT OLD.expires_at
        OR NEW.use_limit IS NOT OLD.use_limit OR NEW.risk_ceiling IS NOT OLD.risk_ceiling
        OR NEW.delegable IS NOT OLD.delegable OR NEW.parent_grant_id IS NOT OLD.parent_grant_id
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
      BEGIN SELECT RAISE(ABORT,'Grant changes require a new admitted Human act and grant'); END;
    CREATE TRIGGER IF NOT EXISTS trust_policy_monotonic BEFORE UPDATE ON trust_policy
      WHEN NEW.epoch<=OLD.epoch BEGIN SELECT RAISE(ABORT,'Policy changes require a new epoch'); END;
    CREATE TRIGGER IF NOT EXISTS human_source_binding_immutable BEFORE UPDATE ON human_frontend_sources
      WHEN NEW.world_id!=OLD.world_id OR NEW.human_id!=OLD.human_id OR NEW.presence_ref!=OLD.presence_ref OR NEW.source_ref!=OLD.source_ref
      BEGIN SELECT RAISE(ABORT,'Human source binding is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS authority_constraint_epoch_insert AFTER INSERT ON authority_constraints BEGIN
      UPDATE authority_epochs SET epoch=epoch+1 WHERE world_id=(SELECT world_id FROM world_records
        WHERE table_name='nodes' AND record_key=json_array(NEW.subject_node_id)); END;
    CREATE TRIGGER IF NOT EXISTS authority_constraint_epoch_update AFTER UPDATE ON authority_constraints BEGIN
      UPDATE authority_epochs SET epoch=epoch+1 WHERE world_id=(SELECT world_id FROM world_records
        WHERE table_name='nodes' AND record_key=json_array(NEW.subject_node_id)); END;
    CREATE TRIGGER IF NOT EXISTS authority_constraint_epoch_delete AFTER DELETE ON authority_constraints BEGIN
      UPDATE authority_epochs SET epoch=epoch+1 WHERE world_id=(SELECT world_id FROM world_records
        WHERE table_name='nodes' AND record_key=json_array(OLD.subject_node_id)); END;
  `);
  for (const table of ["human_utterances","interpretation_claims","human_semantic_acts","human_act_applications","grant_provenance"])
    for (const op of ["UPDATE","DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS trust_immutable_${table}_${op} BEFORE ${op} ON ${table}
      BEGIN SELECT RAISE(ABORT,'Trust evidence is append-only'); END;`);
}

import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { IdentityStore, renameNode } from "../core/identity.ts";
import { getSubjectivity, reviseSubjectivity } from "../core/subjectivity.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { Registry } from "../core/registry.ts";
import { promoteSolToCodex } from "../core/sol-codex-migration.ts";

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO nodes VALUES ('sol', 'Sol', 'active', 'now')").run();
  db.prepare(`INSERT INTO sessions VALUES
    ('sol-session', 'sol', 'test', 'local', 'sol-locator', 'active', 'now')`).run();
  grantSelf(db,"sol");
  const identities = new IdentityStore(db);
  const registry = new Registry(db, { authorize: () => true, getHythe: () => undefined });
  const sol = { nodeId: "sol", sessionId: "sol-session" };
  return { db, identities, registry, sol };
}

// Seed a historical archive snapshot in this synthetic DB; production triggers stay closed.
function seedHistorical(f:ReturnType<typeof fixture>,key:string,value:unknown) {
 const trigger=f.db.prepare("SELECT sql FROM sqlite_master WHERE name='freeze_sovereign_memory_insert'").get() as {sql:string};
 f.db.exec("DROP TRIGGER freeze_sovereign_memory_insert");
 try{f.db.prepare("INSERT INTO sovereign_memory VALUES ('sol',?,?, 'historical')").run(key,JSON.stringify(value));}
 finally{f.db.exec(trigger.sql);}
}

test("display rename and legacy compatibility writes preserve canonical D/Exp identity", () => {
  const f = fixture();
  try {
    reviseSubjectivity(f.db, f.sol, { requestId: "author", expectedRevision: 0,
      description: "my impressions", explanation: "my causal model" });
    const subjectivity = getSubjectivity(f.db, "sol"), before = f.registry.getNode("sol");
    assert.throws(()=>f.identities.putMemory(f.sol, "legacy-data", "legacy", { note: "compatibility only" }),{code:"unavailable"});
    assert.throws(()=>f.identities.setSelfState(f.sol, "legacy-state", { note: "compatibility only" }),{code:"unavailable"});
    assert.equal(f.registry.getNode("sol").activeSelfHead, before.activeSelfHead);
    const input = { requestId: "rename", nodeId: "sol", expectedDisplayName: "Sol", displayName: "Codex" };
    assert.equal(renameNode(f.db, f.sol, input).displayName, "Codex");
    assert.deepEqual(renameNode(f.db, f.sol, input), { nodeId: "sol", displayName: "Codex" });
    assert.deepEqual(getSubjectivity(f.db, "sol"), subjectivity);
    assert.equal(f.registry.getNode("sol").lineageRef, before.lineageRef);
    assert.equal(f.registry.getNode("sol").activeSelfHead, before.activeSelfHead);
    assert.equal(f.db.prepare("SELECT count(*) n FROM nodes").get()?.n, 1);
    assert.equal(f.db.prepare("SELECT locator_ref FROM sessions").get()?.locator_ref, "sol-locator");
    assert.throws(() => renameNode(f.db, f.sol, { ...input, displayName: "Other" }), { code: "conflict" });
  } finally { f.db.close(); }
});

test("reasoning effort changes within one ModelBinding without changing Node, Memory or Authority", () => {
  const f = fixture();
  try {
    const grant = issueGrant(f.db, { kind: "human", id: "owner" }, {
      subjectNodeId: "sol", capability: "task.dispatch", resourceScope: "node/astra",
    });
    const before = f.identities.bindModel(f.sol, "bind-initial", {
      provider: "openai", modelId: "gpt-5.6-sol", reasoningConfig: { effort: "low" },
    });
    seedHistorical(f,"preference",{style:"concise"});
    const node = f.registry.getNode("sol");
    const after = f.identities.bindModel(f.sol, "configure-effort", {
      provider: "openai", modelId: "gpt-5.6-sol", reasoningConfig: { effort: "high" },
    });
    assert.equal(after.bindingId, before.bindingId);
    assert.equal(after.reasoningConfig.effort, "high");
    assert.equal(f.registry.getNode("sol").nodeId, node.nodeId);
    assert.equal(f.registry.getNode("sol").activeSelfHead, node.activeSelfHead);
    assert.equal(f.registry.getNode("sol").lineageRef, node.lineageRef);
    assert.deepEqual(f.identities.memory("sol", "preference"), { style: "concise" });
    assert.equal(f.db.prepare("SELECT grant_id FROM grants WHERE subject_node_id='sol' AND grant_id=?").get(grant.grantId)?.grant_id,
      grant.grantId);
    assert.equal(f.identities.lineage("sol").filter(row => row.kind === "model_migration").length, 0);
  } finally { f.db.close(); }
});

test("explicit model migration preserves Node, Memory, grants and Task continuity with lineage", () => {
  const f = fixture();
  try {
    reviseSubjectivity(f.db, f.sol, { requestId: "current-subjectivity", expectedRevision: 0,
      description: "past impression", explanation: "working world model" });
    const subjectivity = getSubjectivity(f.db, "sol");
    const old = f.identities.bindModel(f.sol, "bind-old", {
      provider: "openai", modelId: "gpt-5.6-sol", reasoningConfig: { effort: "medium" },
    });
    seedHistorical(f,"goal","continue Sidera");
    const grant = issueGrant(f.db, { kind: "human", id: "owner" }, {
      subjectNodeId: "sol", capability: "message.send", resourceScope: "node/astra",
    });
    f.db.prepare(`INSERT INTO tasks VALUES
      ('task-1', 'request-1', 'sol', 'sol', '[]', 'running', NULL, 'now')`).run();
    const before = f.registry.getNode("sol");
    const next = f.identities.migrateModel(f.sol, "migrate-sol", old.bindingId, {
      provider: "openai", modelId: "gpt-6-sol", reasoningConfig: { effort: "high" },
    });
    assert.notEqual(next.bindingId, old.bindingId);
    assert.equal(next.nodeId, "sol");
    assert.deepEqual(getSubjectivity(f.db, "sol"), subjectivity);
    assert.equal(next.migrationFrom, old.bindingId);
    assert.equal(f.registry.getNode("sol").activeSelfHead, before.activeSelfHead);
    assert.deepEqual(f.identities.memory("sol", "goal"), "continue Sidera");
    assert.equal(f.db.prepare("SELECT grant_id FROM grants WHERE subject_node_id='sol' AND grant_id=?").get(grant.grantId)?.grant_id,
      grant.grantId);
    assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id='task-1'").get()?.state, "running");
    const lineage = f.identities.lineage("sol").at(-1)!;
    assert.equal(lineage.kind, "model_migration");
    assert.equal(lineage.fromBindingId, old.bindingId);
    assert.equal(lineage.toBindingId, next.bindingId);
    assert.equal(f.registry.getNode("sol").lineageRef, lineage.lineageId);
    assert.equal(f.identities.migrateModel(f.sol, "migrate-sol", old.bindingId, {
      provider: "openai", modelId: "gpt-6-sol", reasoningConfig: { effort: "high" },
    }).bindingId, next.bindingId);
  } finally { f.db.close(); }
});

test("Sol Host handoff retains Node authority and pins uncertain history to the old Session", () => {
  const f = fixture();
  try {
    seedHistorical(f,"goal","continue");
    const grant = issueGrant(f.db, { kind: "human", id: "owner" }, {
      subjectNodeId: "sol", capability: "task.dispatch", resourceScope: "node/astra",
    });
    f.db.prepare(`INSERT INTO tasks VALUES
      ('old-task', 'old-request', 'sol', 'sol', '[]', 'completed', NULL, 'now')`).run();
    f.db.prepare(`INSERT INTO messages VALUES
      ('old-message', 'old-message-request', 'old-task', 'sol', 'sol',
       'sol-session', 1, 'result', 'old result', 'delivered', NULL, NULL, 'now')`).run();
    const choice = { nodeId: "sol", fromSessionId: "sol-session",
      toSessionId: "codex-sol-session", locatorRef: "exact-codex-thread",
      hytheId: "codex-sol", modelId: "gpt-6-sol" };
    assert.throws(() => promoteSolToCodex(f.db, choice), { code: "conflict" });
    f.db.prepare("UPDATE messages SET state = 'uncertain' WHERE message_id = 'old-message'").run();
    const before = f.registry.getNode("sol");
    promoteSolToCodex(f.db, choice);
    promoteSolToCodex(f.db, choice); // persisted handoff is idempotent on restart
    assert.equal(f.registry.getNode("sol").activeSelfHead, before.activeSelfHead);
    assert.deepEqual(f.identities.memory("sol", "goal"), "continue");
    assert.equal(f.db.prepare("SELECT grant_id FROM grants WHERE subject_node_id='sol' AND grant_id=?")
      .get(grant.grantId)?.grant_id, grant.grantId);
    assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id='old-task'")
      .get()?.state, "completed");
    const historical = f.db.prepare(`SELECT target_session_id, state FROM messages
      WHERE message_id='old-message'`).get();
    assert.equal(historical?.target_session_id, "sol-session");
    assert.equal(historical?.state, "uncertain");
    assert.equal(f.db.prepare("SELECT state FROM sessions WHERE session_id='sol-session'")
      .get()?.state, "retired");
    assert.equal(f.db.prepare("SELECT state FROM sessions WHERE session_id='codex-sol-session'")
      .get()?.state, "active");
    assert.equal(f.identities.currentModel("sol")?.modelId, "gpt-6-sol");
    assert.equal(f.identities.lineage("sol").filter(row => row.kind === "model_bind").length, 1);
  } finally { f.db.close(); }
});

test("fork creates another active self with a new Node ID and independent Sovereign Memory", () => {
  const f = fixture();
  try {
    f.identities.bindModel(f.sol, "bind-source", {
      provider: "openai", modelId: "gpt-6-sol", reasoningConfig: { effort: "medium" },
    });
    seedHistorical(f,"position","historical archive");
    reviseSubjectivity(f.db,f.sol,{requestId:"source-subjectivity",expectedRevision:0,description:"source D",explanation:"source Exp"});
    assert.throws(()=>f.identities.setSelfState(f.sol,"state-source",{phase:"before fork"}),{code:"unavailable"});
    const source = f.registry.getNode("sol");
    assert.throws(() => f.identities.forkNode(f.sol, "fork-denied", "Reviewer-A",
      source.activeSelfHead), { code: "denied" });
    issueGrant(f.db, { kind: "human", id: "owner" }, {
      subjectNodeId: "sol", capability: "node.fork", resourceScope: "node/sol/fork",
    });
    const fork = f.identities.forkNode(f.sol, "fork-approved", "Reviewer-A",
      source.activeSelfHead);
    assert.notEqual(fork.nodeId, source.nodeId);
    assert.notEqual(fork.activeSelfHead, source.activeSelfHead);
    assert.deepEqual(fork.selfState, source.selfState);
    assert.equal(f.identities.memory(fork.nodeId,"position"),null);
    assert.equal(getSubjectivity(f.db,fork.nodeId).description,"source D");
    assert.equal(f.identities.currentModel(fork.nodeId)?.modelId, "gpt-6-sol");
    assert.notEqual(f.identities.currentModel(fork.nodeId)?.bindingId,
      f.identities.currentModel("sol")?.bindingId);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE subject_node_id=?")
      .get(fork.nodeId)?.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id=?")
      .get(fork.nodeId)?.n, 0);
    const lineage = f.identities.lineage(fork.nodeId).at(-1)!;
    assert.equal(lineage.kind, "fork");
    assert.equal(lineage.sourceNodeId, "sol");
    assert.equal(lineage.sourceSelfHead, source.activeSelfHead);
    f.db.prepare(`INSERT INTO sessions VALUES (?, ?, 'test', 'local',
      'fork-locator', 'active', 'now')`).run("fork-session", fork.nodeId);
    grantSelf(f.db,fork.nodeId);
    reviseSubjectivity(f.db,{nodeId:fork.nodeId,sessionId:"fork-session"},{requestId:"fork-subjectivity",expectedRevision:0,description:"fork D",explanation:"fork Exp"});
    assert.equal(getSubjectivity(f.db,"sol").description,"source D");
    assert.equal(f.identities.memory("sol","position"),"historical archive");
    assert.equal(f.registry.getNode("sol").activeSelfHead, source.activeSelfHead);
  } finally { f.db.close(); }
});

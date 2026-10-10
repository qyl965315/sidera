import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, withTransaction } from "../core/db.ts";
import { getSubjectivity, reviseSubjectivity } from "../core/subjectivity.ts";
import { commitLocalSovereignty, sovereigntyRoot } from "../core/sovereignty-store.ts";
import { readHistory } from "../core/history.ts";
import { syncExecutorPool } from "../core/executors.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { CoreRuntime } from "../core/runtime.ts";
import { callCore } from "../hythes/core-client.ts";
import { grantSelf, issueGrant } from "./fixtures/authority.ts";
import { readProjectSource } from "../core/source.ts";
import { LocalPeregrineManager } from "../peregrine/local.ts";
import { readOwnedText, writeOwnedText } from "../peregrine/text.ts";

function seed(db: ReturnType<typeof openDatabase>) {
  for (const n of ["owner", "other"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active','2026-10-07T00:00:00Z')").run(n, n);
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active','2026-10-07T00:00:00Z')")
      .run(`${n}-session`, n, `${n}-exact`);
    grantSelf(db, n);
  }
  return { nodeId: "owner", sessionId: "owner-session" };
}

test("Constitutional Sovereignty migrates legacy content to private local truth; SQL becomes metadata only", () => {
  const folder = mkdtempSync(join(tmpdir(), "sidera-constitutional-sovereignty-"));
  const path = join(folder, "world.sqlite");
  let db = openDatabase(path);
  try {
    seed(db);
    db.prepare("UPDATE node_subjectivity SET description='PRIVATE_LEGACY_D',explanation='PRIVATE_LEGACY_E',revision=7 WHERE node_id='owner'").run();
    db.close(); db = openDatabase(path);
    const value = getSubjectivity(db, "owner");
    assert.equal(value.description, "PRIVATE_LEGACY_D");
    assert.equal(value.explanation, "PRIVATE_LEGACY_E");
    assert.equal(value.revision, 7);
    const physical = join(sovereigntyRoot(db), "owner", "current.json");
    assert.equal(JSON.parse(readFileSync(physical, "utf8")).description, value.description);
    const indexed = db.prepare("SELECT description,explanation,revision FROM node_subjectivity WHERE node_id='owner'").get()!;
    assert.equal(indexed.description, ""); assert.equal(indexed.explanation, ""); assert.equal(indexed.revision, 7);
    db.prepare("UPDATE node_subjectivity SET description='SQL_IS_NOT_TRUTH',revision=900 WHERE node_id='owner'").run();
    assert.deepEqual(getSubjectivity(db, "owner"), value);
    assert.doesNotMatch(JSON.stringify(readHistory(db)), /PRIVATE_LEGACY/);
    const held = `${physical}.held`;
    renameSync(physical, held);
    try { assert.throws(() => getSubjectivity(db, "owner"), /Canonical local Sovereignty is missing/); }
    finally { renameSync(held, physical); }
    db.close(); db = openDatabase(path);
    assert.equal(getSubjectivity(db, "owner").revision, 7);
    assert.equal(db.prepare("SELECT revision FROM node_subjectivity WHERE node_id='owner'").get()!.revision, 7);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("Constitutional self writes replace D/E atomically and private past content never enters Shared History", () => {
  const db = openDatabase(":memory:");
  try {
    const caller = seed(db);
    reviseSubjectivity(db, caller, { requestId: "one", expectedRevision: 0,
      description: "PRIVATE_REMEMBERED_WRONG_D", explanation: "PRIVATE_EVALUATION_E" });
    reviseSubjectivity(db, caller, { requestId: "forget", expectedRevision: 1,
      description: "I choose to forget that detail.", explanation: "I changed my classification." });
    assert.equal(getSubjectivity(db, "owner").revision, 2);
    const folder = join(sovereigntyRoot(db), "owner");
    assert.deepEqual(readdirSync(folder), ["current.json"]);
    assert.doesNotMatch(readFileSync(join(folder, "current.json"), "utf8"), /PRIVATE_REMEMBERED_WRONG_D|PRIVATE_EVALUATION_E/);
    const history = readHistory(db);
    assert.equal(history.filter(h => h.source === "node.self.sovereignty").length, 2);
    assert.doesNotMatch(JSON.stringify(history), /PRIVATE_REMEMBERED_WRONG_D|PRIVATE_EVALUATION_E|changed my classification/);
    assert.equal(db.prepare("SELECT description FROM node_subjectivity WHERE node_id='owner'").get()!.description, "");
    assert.equal(getSubjectivity(db, "other").revision, 0);
    assert.throws(() => reviseSubjectivity(db, { nodeId: "other", sessionId: caller.sessionId }, {
      requestId: "cross", expectedRevision: 0, description: "no", explanation: "no" }), { code: "denied" });
  } finally { db.close(); }
});

test("Two runtime connections share one Node revision and stale writers detect CAS conflict", () => {
  const folder = mkdtempSync(join(tmpdir(), "sidera-sovereignty-cas-"));
  const path = join(folder, "world.sqlite");
  const first = openDatabase(path); const caller = seed(first);
  first.prepare("INSERT INTO sessions VALUES ('parallel-executor','owner','fixture','fixture','second-exact','standby','now')").run();
  syncExecutorPool(first);
  // Fixture represents a second exact context already admitted after Host/review checks.
  first.prepare("UPDATE operator_executors SET routing_admitted=1 WHERE session_id='parallel-executor'").run();
  const parallel = { nodeId: "owner", sessionId: "parallel-executor" };
  const second = openDatabase(path);
  try {
    const a = getSubjectivity(first, "owner"), b = getSubjectivity(second, "owner");
    assert.equal(a.revision, b.revision);
    reviseSubjectivity(first, caller, { requestId: "executor-a", expectedRevision: a.revision, description: "A", explanation: "A-explanation" });
    assert.throws(() => reviseSubjectivity(second, parallel, { requestId: "executor-b", expectedRevision: b.revision,
      description: "B", explanation: "B-explanation" }), /revision changed/);
    assert.deepEqual(getSubjectivity(second, "owner"), getSubjectivity(first, "owner"));
    assert.equal(getSubjectivity(second, "owner").description, "A");
    assert.equal(getSubjectivity(second, "owner").explanation, "A-explanation");
    reviseSubjectivity(second, parallel, { requestId: "executor-b-reconsidered", expectedRevision: 1,
      description: "B after rereading", explanation: "No universal merge was imposed" });
    assert.equal(getSubjectivity(first, "owner").revision, 2);
    assert.equal(getSubjectivity(first, "owner").description, "B after rereading");
  } finally { second.close(); first.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("Local receipt reconciles metadata after SQL rollback without replaying a committed D/E write", () => {
  const db = openDatabase(":memory:");
  try {
    seed(db); getSubjectivity(db, "owner");
    const input = { requestId: "publication-interruption", fingerprint: "same-input", expectedRevision: 0,
      description: "PRIVATE_COMMITTED_D", explanation: "PRIVATE_COMMITTED_E" };
    assert.throws(() => withTransaction(db, "simulate_sql_failure", () => {
      commitLocalSovereignty(db, "owner", input, () => {});
      throw new Error("simulated interruption after publication");
    }), /simulated interruption/);
    assert.equal(getSubjectivity(db, "owner").revision, 1);
    assert.equal(db.prepare("SELECT revision FROM node_subjectivity WHERE node_id='owner'").get()!.revision, 0);
    let restored = 0;
    const receipt = withTransaction(db, "reconcile_metadata", () => commitLocalSovereignty(db, "owner", input, () => { restored++; }));
    assert.equal(receipt.revision, 1); assert.equal(restored, 1);
    assert.equal(getSubjectivity(db, "owner").revision, 1);
    assert.equal(db.prepare("SELECT revision FROM node_subjectivity WHERE node_id='owner'").get()!.revision, 1);
    assert.throws(() => commitLocalSovereignty(db, "owner", { ...input, fingerprint: "different" }, () => {}), /request ID was reused/);
  } finally { db.close(); }
});

test("Local Sovereignty refuses path traversal and symlink redirection across Node regions", () => {
  const db = openDatabase(":memory:");
  try {
    seed(db); getSubjectivity(db, "owner"); getSubjectivity(db, "other");
    db.prepare("INSERT INTO nodes VALUES ('../../other','Historical odd NodeRef','active','now')").run();
    assert.equal(getSubjectivity(db, "../../other").nodeId, "../../other");
    const root = sovereigntyRoot(db);
    assert.equal(readdirSync(root).filter(name => name.startsWith("ref-")).length, 1);
    const owner = join(root, "owner"), held = join(root, "owner-held");
    renameSync(owner, held);
    try {
      symlinkSync(join(root, "other"), owner, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => getSubjectivity(db, "owner"), /cannot redirect/);
    } finally {
      rmSync(owner, { force: true }); renameSync(held, owner);
    }
    assert.equal(getSubjectivity(db, "owner").nodeId, "owner");
  } finally { db.close(); }
});

test("Real RPC has self-only Sovereignty; a different Node selector cannot read or overwrite another subject", async () => {
  const db = openDatabase(":memory:"); const caller = seed(db);
  const runtime = new CoreRuntime(db, new Map(), undefined, { observationOnly: true });
  const rpc = new CoreRpcServer(db, runtime, new Map(), { authenticate: token => token === "fixture-owner" ? { kind: "node", ...caller } : null });
  try {
    const core = { port: await rpc.listen(), token: "fixture-owner" };
    const own = await callCore(core, "subjectivity.get", {});
    assert.equal((own as { nodeId: string }).nodeId, "owner");
    await assert.rejects(callCore(core, "subjectivity.get", { nodeId: "other" }));
    await assert.rejects(callCore(core, "subjectivity.get", { nodeId: null }));
    await assert.rejects(callCore(core, "subjectivity.revise", { targetNodeId: "other", requestId: "cross-rpc",
      expectedRevision: 0, description: "malicious", explanation: "malicious" }));
    assert.equal(getSubjectivity(db, "other").revision, 0);
  } finally { await rpc.close(); runtime.close(); db.close(); }
});

test("An authorized source/owned-workspace broker cannot turn a private-region alias into D/E access", () => {
  const project = mkdtempSync(join(tmpdir(), "sidera-sovereignty-broker-"));
  const db = openDatabase(join(project, "state.sqlite"));
  try {
    const caller = seed(db); getSubjectivity(db, "other");
    const other = join(sovereigntyRoot(db), "other");
    // A directory junction supplies an allowed source filename inside the private region.
    writeFileSync(join(other, "fixture.ts"), "PRIVATE_NODE_REGION_CONTENT");
    symlinkSync(other, join(project, "core"), process.platform === "win32" ? "junction" : "dir");
    issueGrant(db, { kind: "human", id: "fixture-owner" }, { subjectNodeId: caller.nodeId,
      capability: "project.source.read", resourceScope: "project/sidera/source/**" });
    assert.throws(() => readProjectSource(db, project, caller, { requestId: "read-alias", path: "core/fixture.ts" }),
      /Sovereignty is not a semantic filesystem surface/);
    const manager = new LocalPeregrineManager(db, join(project, "peregrines"));
    // Misconfigured fixture workspace must also be rejected even when its nominal owner is caller.
    db.prepare("INSERT INTO peregrines VALUES ('private-alias','owner',?,?,?,'ready','local')").run(other, other, other);
    assert.throws(() => readOwnedText(db, manager, caller, "current.json"), /Sovereignty is not a semantic filesystem surface/);
    assert.throws(() => writeOwnedText(db, manager, caller, { requestId: "write-alias", fileName: "replacement.json", content: "no" }),
      /Sovereignty is not a semantic filesystem surface/);
    assert.equal(getSubjectivity(db, "other").revision, 0);
  } finally { db.close(); rmSync(project, { recursive: true, force: true }); }
});

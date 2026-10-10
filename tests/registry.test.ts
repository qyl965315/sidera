import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { Registry, registryAuthority, type RegistryWriteContext,
  type RegistryDependencies } from "../core/registry.ts";
import { SideraError } from "../core/types.ts";

const context = (nodeId?: string): RegistryWriteContext => ({
  actorNodeId: "human-bootstrap-adapter", requestId: randomUUID(),
  resourceScope: nodeId ? `node/${nodeId}` : "nodes",
});
const code = (expected: string) => (error: unknown) =>
  error instanceof SideraError && error.code === expected;

test("Registry uses baseline self sovereignty while rejecting cross-node writes", async () => {
  const db = openDatabase(":memory:");
  try {
    for (const id of ["owner", "other"]) {
      db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)")
        .run(id, id, new Date().toISOString());
      db.prepare(`INSERT INTO sessions VALUES (?, ?, 'test', 'local', ?, 'active', ?)`)
        .run(`${id}-session`, id, `${id}-locator`, new Date().toISOString());
    }
    grantSelf(db,"owner");
    const registry = new Registry(db, {
      authorize: registryAuthority(db),
      getHythe: () => ({ hytheId: "test", hostKind: "local",
        locate: async () => true }),
    });
    const own = (requestId: string): RegistryWriteContext => ({
      actorNodeId: "owner", actorSessionId: "owner-session", requestId,
      resourceScope: "node/owner",
    });
    const standby = await registry.bindSession(own("own-bind"), {
      nodeId: "owner", hytheId: "test", hostKind: "local",
      locatorRef: "standby", state: "standby",
    });
    assert.equal(standby.nodeId, "owner");
    await assert.rejects(registry.bindSession({ ...own("cross-bind"),
      resourceScope: "node/other" }, {
      nodeId: "other", hytheId: "test", hostKind: "local",
      locatorRef: "intrusion", state: "standby",
    }), code("denied"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM grant_uses").get()?.n, 1);
  } finally {
    db.close();
  }
});

function setup(file = ":memory:") {
  const db = openDatabase(file);
  let allowed = true;
  let locator: (ref: string) => Promise<boolean> = async ref => ref !== "missing";
  const decisions: Parameters<RegistryDependencies["authorize"]>[0][] = [];
  const dependencies: RegistryDependencies = {
    authorize(input) {
      decisions.push(input);
      return allowed && input.resourceScope === input.resource;
    },
    getHythe: id => id === "codex" ? {
      hytheId: "codex", hostKind: "desktop", locate: ref => locator(ref),
    } : undefined,
  };
  const registry = new Registry(db, dependencies);
  const bind = (nodeId: string, locatorRef: string, state: "active" | "standby" = "standby") =>
    registry.bindSession(context(nodeId), { nodeId, locatorRef, state, hytheId: "codex", hostKind: "desktop" });
  return { db, registry, dependencies, bind, decisions,
    deny() { allowed = false; }, locate(fn: typeof locator) { locator = fn; } };
}

test("opaque identities, persistent records and independent session bindings", async t => {
  const testRoot = join(process.cwd(), ".sidera-dev", "sol", "temp");
  mkdirSync(testRoot, { recursive: true });
  const dir = mkdtempSync(join(testRoot, "sidera-registry-"));
  const file = join(dir, "registry.sqlite");
  const f = setup(file);
  let currentDb = f.db;
  t.after(() => {
    currentDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const node = f.registry.createNode(context(), "Astra");
  const other = f.registry.createNode(context(), "Astra");
  assert.notEqual(node.nodeId, other.nodeId);
  const session = await f.bind(node.nodeId, "opaque-host-session", "active");
  assert.notEqual(session.sessionId, node.nodeId);
  assert.equal(session.nodeId, node.nodeId);
  assert.equal(f.registry.getActiveSession(other.nodeId), null);
  // A returned record is a snapshot, not mutable canonical state.
  node.displayName = "mutated";
  assert.equal(f.registry.getNode(node.nodeId).displayName, "Astra");
  f.db.close();
  const reopened = openDatabase(file);
  currentDb = reopened;
  const registry = new Registry(reopened, f.dependencies);
  assert.deepEqual(registry.getSession(session.sessionId), session);
  assert.equal(registry.getActiveSession(node.nodeId)?.sessionId, session.sessionId);
});

test("handoff preserves queued message targets and retirement preserves history", async t => {
  const f = setup(); t.after(() => f.db.close());
  const node = f.registry.createNode(context(), "Astra");
  const old = await f.bind(node.nodeId, "old", "active");
  const next = await f.bind(node.nodeId, "next");
  f.db.prepare(`INSERT INTO messages
    (message_id, request_id, from_node_id, to_node_id, target_session_id,
     sequence, kind, body, state, created_at) VALUES ('m', 'r', ?, ?, ?, 1, 'task', 'body', 'queued', 'now')`)
    .run(node.nodeId, node.nodeId, old.sessionId);
  f.db.prepare("INSERT INTO events VALUES ('e', ?, 'test', '{}', 'now')").run(node.nodeId);
  await f.registry.handoffSession(context(node.nodeId), node.nodeId, next.sessionId, old.sessionId);
  assert.equal(f.registry.getSession(old.sessionId).state, "retired");
  assert.equal(f.registry.getActiveSession(node.nodeId)?.sessionId, next.sessionId);
  assert.equal(f.db.prepare("SELECT target_session_id FROM messages").get()?.target_session_id, old.sessionId);
  f.registry.retireNode(context(node.nodeId), node.nodeId);
  assert.equal(f.registry.getNode(node.nodeId).lifecycle, "retired");
  assert.equal(f.registry.getActiveSession(node.nodeId), null);
  assert.equal(f.registry.getSession(next.sessionId).state, "retired");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE event_id='e'").get()?.n, 1);
  assert.equal(f.db.prepare("SELECT state FROM messages").get()?.state, "queued");
  await assert.rejects(f.bind(node.nodeId, "third"), code("conflict"));
});

test("rejects duplicate active, duplicate locator, cross-node handoff/close and retired reactivation", async t => {
  const f = setup(); t.after(() => f.db.close());
  const a = f.registry.createNode(context(), "A");
  const b = f.registry.createNode(context(), "B");
  const active = await f.bind(a.nodeId, "a", "active");
  const other = await f.bind(b.nodeId, "b");
  await assert.rejects(f.bind(a.nodeId, "duplicate-active", "active"), code("conflict"));
  await assert.rejects(f.bind(b.nodeId, "a"), code("conflict"));
  await assert.rejects(f.registry.handoffSession(context(a.nodeId), a.nodeId, other.sessionId, active.sessionId), code("conflict"));
  assert.throws(() => f.registry.closeSession(context(a.nodeId), a.nodeId, other.sessionId), code("conflict"));
  f.registry.closeSession(context(a.nodeId), a.nodeId, active.sessionId);
  await assert.rejects(f.registry.handoffSession(context(a.nodeId), a.nodeId, active.sessionId, null), code("conflict"));
  await assert.rejects(f.bind(b.nodeId, "a"), code("conflict"));
  assert.equal(f.registry.getActiveSession(a.nodeId), null);
  assert.equal(f.registry.getSession(other.sessionId).state, "standby");
});

test("locator and Hythe validation return structured errors without inserting sessions", async t => {
  const f = setup(); t.after(() => f.db.close());
  const { nodeId } = f.registry.createNode(context(), "A");
  await assert.rejects(f.bind(nodeId, "missing"), code("not_found"));
  await assert.rejects(f.registry.bindSession(context(nodeId), {
    nodeId, hytheId: "unknown", hostKind: "desktop", locatorRef: "x",
  }), code("unavailable"));
  await assert.rejects(f.registry.bindSession(context(nodeId), {
    nodeId, hytheId: "codex", hostKind: "different-host", locatorRef: "x",
  }), code("conflict"));
  f.locate(async () => { throw new Error("host secret must not escape"); });
  await assert.rejects(f.bind(nodeId, "x"), error => code("unavailable")(error) &&
    !(error as Error).message.includes("secret"));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
  assert.throws(() => f.registry.getNode("unknown"), code("not_found"));
  assert.throws(() => f.registry.getSession("unknown"), code("not_found"));
});

test("authorization is required for every write and carries caller, request, capability and resource", async t => {
  const f = setup(); t.after(() => f.db.close());
  const { nodeId } = f.registry.createNode(context(), "A");
  const old = await f.bind(nodeId, "old", "active");
  const next = await f.bind(nodeId, "next");
  f.deny();
  const ctx = context(nodeId);
  assert.throws(() => f.registry.createNode(context(), "denied"), code("denied"));
  assert.throws(() => f.registry.retireNode(ctx, nodeId), code("denied"));
  await assert.rejects(f.bind(nodeId, "denied"), code("denied"));
  await assert.rejects(f.registry.handoffSession(ctx, nodeId, next.sessionId, old.sessionId), code("denied"));
  assert.throws(() => f.registry.closeSession(ctx, nodeId, old.sessionId), code("denied"));
  assert.deepEqual(f.decisions.at(-1), { ...ctx, capability: "session.close", resource: `node/${nodeId}` });
  assert.equal(f.registry.getNode(nodeId).lifecycle, "active");
  assert.equal(f.registry.getActiveSession(nodeId)?.sessionId, old.sessionId);
  assert.throws(() => f.registry.retireNode({ ...ctx, requestId: "" }, nodeId), code("conflict"));
});

test("handoff rolls back old retirement if activation fails; composes with outer transaction", async t => {
  const f = setup(); t.after(() => f.db.close());
  const { nodeId } = f.registry.createNode(context(), "A");
  const old = await f.bind(nodeId, "old", "active");
  const next = await f.bind(nodeId, "next");
  f.db.exec(`CREATE TRIGGER reject_activation BEFORE UPDATE OF state ON sessions
    WHEN NEW.state = 'active' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  await assert.rejects(f.registry.handoffSession(context(nodeId), nodeId, next.sessionId, old.sessionId), code("conflict"));
  assert.equal(f.registry.getActiveSession(nodeId)?.sessionId, old.sessionId);
  assert.equal(f.registry.getSession(next.sessionId).state, "standby");
  f.db.exec("DROP TRIGGER reject_activation");
  f.db.exec("BEGIN");
  await f.registry.handoffSession(context(nodeId), nodeId, next.sessionId, old.sessionId);
  f.db.exec("ROLLBACK");
  assert.equal(f.registry.getActiveSession(nodeId)?.sessionId, old.sessionId);
  assert.equal(f.registry.getSession(next.sessionId).state, "standby");
});

test("concurrent handoffs use compare-and-swap; recheck retirement after locator await", async t => {
  const f = setup(); t.after(() => f.db.close());
  const { nodeId } = f.registry.createNode(context(), "A");
  const old = await f.bind(nodeId, "old", "active");
  const next = await f.bind(nodeId, "next");
  const third = await f.bind(nodeId, "third");
  const results = await Promise.allSettled([
    f.registry.handoffSession(context(nodeId), nodeId, next.sessionId, old.sessionId),
    f.registry.handoffSession(context(nodeId), nodeId, third.sessionId, old.sessionId),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected");
  assert.ok(rejected?.status === "rejected" && code("conflict")(rejected.reason));
  let resolve!: (value: boolean) => void;
  f.locate(() => new Promise<boolean>(r => { resolve = r; }));
  const pending = f.bind(nodeId, "late");
  f.registry.retireNode(context(nodeId), nodeId);
  resolve(true);
  await assert.rejects(pending, code("conflict"));
  assert.equal(f.registry.getActiveSession(nodeId), null);
});

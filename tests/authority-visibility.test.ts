import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { canUseCapability } from "../core/authority.ts";
import { issueGrant } from "./fixtures/authority.ts";

/**
 * A3 isolation: can a LONG-RUNNING reader see Authority committed by another
 * connection without being restarted?
 *
 * The earlier observation was only "old process and new process disagree; a
 * restart changes the answer". That is not a root cause. This test separates the
 * two candidate explanations:
 *   (a) a long-lived SQLite connection cannot see a later commit  -> must fail
 *   (b) the running process was executing OLDER CODE than disk     -> not testable
 *                                                                     here, and NOT
 *                                                                     claimed
 */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sidera-authority-visibility-"));
  const file = join(dir, "state.sqlite");
  const writer = openDatabase(file);
  t.after(() => { if (writer.isOpen) writer.close(); });
  const world = createWorld(writer, "Visibility World", "A3 isolation fixture");
  const store = new SemanticStore(writer, world);
  const human = store.createHuman("Fixture Human", "A3 isolation");
  const chief = store.registerNode("Chief"), agent = store.registerNode("Agent");
  writer.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run("chief-session", chief, "mock://chief");
  writer.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run("agent-session", agent, "mock://agent");
  return { dir, file, writer, world, human, chief, agent };
}
const action = (chief: string, agent: string) => ({ subjectNodeId: chief, sessionId: "chief-session",
  capability: "task.dispatch", resource: `node/${agent}`, requestId: "visibility" });

test("A3: a long-running reader sees Authority committed later by another connection", t => {
  const f = fixture(t);
  // A SEPARATE long-lived connection, opened BEFORE the grant exists, standing in
  // for a running Core process.
  const reader = openDatabase(f.file);
  t.after(() => { if (reader.isOpen) reader.close(); });
  assert.equal(canUseCapability(reader, action(f.chief, f.agent)), false,
    "no grant exists yet");
  // Another connection commits a grant while the reader stays open.
  const grant = issueGrant(f.writer, { kind: "human", id: f.human },
    { subjectNodeId: f.chief, capability: "task.dispatch", resourceScope: `node/${f.agent}` });
  assert.equal(canUseCapability(reader, action(f.chief, f.agent)), true,
    "a committed grant must be visible to an already-open reader without restart");
  // Revocation must be equally visible, and must win at the decision point.
  f.writer.prepare("UPDATE grants SET revoked_at=? WHERE grant_id=?").run(new Date().toISOString(), grant.grantId);
  assert.equal(canUseCapability(reader, action(f.chief, f.agent)), false,
    "a committed revocation must be visible without restart");
});

test("A3: the isolation result is not an artefact of an unflushed writer", t => {
  const f = fixture(t);
  const reader = openDatabase(f.file);
  t.after(() => { if (reader.isOpen) reader.close(); });
  const before = (reader.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
  for (let i = 0; i < 5; i++) issueGrant(f.writer, { kind: "human", id: f.human },
    { requestId: `bulk-${i}`, subjectNodeId: f.chief, capability: "task.dispatch", resourceScope: `node/${f.agent}` });
  const after = (reader.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
  assert.equal(after - before, 5, "each commit is immediately observable to the open reader");
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../core/db.ts";
import { createWorld, recordWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { openSupervision, recordRound, decideSupervision, supervisionView, linkTaskToSupervision, supervisionForTask } from "../core/supervision.ts";

/**
 * Multi-round supervision. The defect this replaces: every Agent completion was
 * forwarded straight to the Human, so the Human was the reviewer and the loop
 * driver. Here the supervising Node owns a real, recorded, per-round decision and
 * only ACCEPT/ESCALATE may reach the Human.
 */
function fixture(t: TestContext) {
  const file = join(mkdtempSync(join(tmpdir(), "sidera-supervision-")), "state.sqlite");
  const db = openDatabase(file);
  t.after(() => { if (db.isOpen) db.close(); });
  const world = createWorld(db, "Supervision World", "supervision fixture");
  const store = new SemanticStore(db, world);
  const human = store.createHuman("Fixture Human", "supervision fixture");
  const chief = store.registerNode("Chief Supervisory Chat");
  const agent = store.registerNode("Agent");
  const other = store.registerNode("Other Node");
  for (const [id, node] of [["chief", chief], ["agent", agent]] as const)
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(`${id}-session`, node, `mock://${node}`);
  const supervision = (over: Record<string, unknown> = {}) => openSupervision(db, {
    worldId: world, chiefNodeId: chief, goal: "Produce a verified artifact",
    acceptanceCriteria: "Artifact exists and its hash matches the stated revision", maxRounds: 3, ...over });
  const round = (supervisionId: string, index: number, resultMessageId = `result-${index}`) =>
    recordRound(db, { supervisionId, roundIndex: index, agentNodeId: agent, resultMessageId });
  const node = { kind: "node" as const, nodeId: chief };
  return { db, world, store, human, chief, agent, other, supervision, round, node };
}

test("B-T01 a supervising decision is required before a round counts as complete", t => {
  const f = fixture(t);
  const id = f.supervision();
  f.round(id, 1);
  const view = supervisionView(f.db, id);
  assert.equal(view.state, "awaiting_decision");
  assert.equal(view.awaitingDecisionRound, 1);
  assert.equal(view.lastDecision, null, "no decision has been taken yet");
  assert.equal(view.roundsCompleted, 0);
});

test("B-T02 REWORK advances to another round and never reaches the Human", t => {
  const f = fixture(t);
  const id = f.supervision();
  f.round(id, 1);
  const r = decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision: "REWORK",
    reason: "Artifact hash did not match the stated revision",
    instruction: "Rebuild from revision r2 and report the new hash", actor: f.node });
  assert.equal(r.mustPresentToHuman, false, "a failed acceptance must go back to the Agent, not to the Human");
  const view = supervisionView(f.db, id);
  assert.equal(view.state, "running");
  assert.equal(view.roundsCompleted, 1);
  assert.match(view.nextInstruction ?? "", /r2/);
  assert.equal(view.lastDecision?.decision, "REWORK");
  assert.match(String(view.lastDecision?.reason), /hash/);
});

test("B-T03 only ACCEPT or ESCALATE may reach the Human", t => {
  const f = fixture(t);
  for (const [decision, expectedState] of [["ACCEPT", "completed"], ["ESCALATE", "escalated"]] as const) {
    const id = f.supervision();
    f.round(id, 1);
    const r = decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision,
      reason: decision === "ACCEPT" ? "Acceptance criteria met" : "Needs a Human value judgment", actor: f.node });
    assert.equal(r.mustPresentToHuman, true);
    assert.equal(r.state, expectedState);
  }
  // Everything else stays with the Agents.
  for (const decision of ["CONTINUE", "WAIT", "RECONCILE", "STOP"] as const) {
    const id = f.supervision();
    f.round(id, 1);
    const r = decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision,
      reason: `fixture ${decision}`, instruction: "fixture", actor: f.node });
    assert.equal(r.mustPresentToHuman, false, `${decision} must not be forwarded to the Human`);
  }
});

test("B-T04 one decision per round; identical replay is idempotent, a different one conflicts", t => {
  const f = fixture(t);
  const id = f.supervision();
  f.round(id, 1);
  const input = { supervisionId: id, roundIndex: 1, decision: "REWORK", reason: "same reason", actor: f.node };
  decideSupervision(f.db, input);
  assert.equal(decideSupervision(f.db, input).replay, true, "a duplicate callback must not double-dispatch");
  assert.throws(() => decideSupervision(f.db, { ...input, decision: "ACCEPT", reason: "changed my mind" }),
    { code: "conflict" }, "a round's decision is recorded once and not rewritten");
  assert.equal(supervisionView(f.db, id).lastDecision?.decision, "REWORK");
});

test("B-T05 the decision belongs to an accountable subject", t => {
  const f = fixture(t);
  const id = f.supervision();
  f.round(id, 1);
  assert.throws(() => decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision: "ACCEPT",
    reason: "not my responsibility", actor: { kind: "node", nodeId: f.other } }), { code: "denied" });
  assert.throws(() => decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision: "ACCEPT",
    reason: "not a member", actor: { kind: "human", id: "outsider" } }), { code: "denied" });
  const r = decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision: "ACCEPT",
    reason: "Human judgement", actor: { kind: "human", id: f.human } });
  assert.equal(r.mustPresentToHuman, true);
});

test("B-T06 a duplicate completion callback cannot create a second round", t => {
  const f = fixture(t);
  const id = f.supervision();
  f.round(id, 1);
  f.round(id, 1);
  f.round(id, 1, "result-1-again");
  const n = (f.db.prepare("SELECT COUNT(*) AS n FROM supervision_rounds WHERE supervision_id=?").get(id) as { n: number }).n;
  assert.equal(n, 1, "repeat callbacks are idempotent, not extra rounds");
});

test("B-T07 exhausting the round budget is a recoverable pause, not a Human-authority block", t => {
  const f = fixture(t);
  const id = f.supervision({ maxRounds: 1 });
  f.round(id, 1);
  decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision: "CONTINUE", reason: "more work", actor: f.node });
  f.round(id, 2);
  assert.throws(() => decideSupervision(f.db, { supervisionId: id, roundIndex: 2, decision: "REWORK",
    reason: "again", actor: f.node }), { code: "conflict" }, "budget exhaustion is reported as a checkpoint, not silently continued");
  const view = supervisionView(f.db, id);
  assert.equal(view.state, "budget_exhausted");
  assert.equal(view.roundsCompleted, 1, "the completed rounds are preserved for resume");
  assert.notEqual(view.chiefNodeId, null);
});

test("B-T08 a supervision cannot be opened without falsifiable acceptance criteria", t => {
  const f = fixture(t);
  assert.throws(() => openSupervision(f.db, { worldId: f.world, chiefNodeId: f.chief,
    goal: "Do something", acceptanceCriteria: "   " }), { code: "conflict" });
  assert.throws(() => openSupervision(f.db, { worldId: f.world, chiefNodeId: f.chief,
    goal: "   ", acceptanceCriteria: "Artifact exists" }), { code: "conflict" });
  const id = openSupervision(f.db, { worldId: f.world, chiefNodeId: f.chief,
    goal: "Produce artifact", acceptanceCriteria: "Artifact exists and hash matches" });
  assert.ok(recordWorld(f.db, "nodes", f.chief));
  assert.equal(supervisionView(f.db, id).state, "running");
});

test("B-T09 a dispatched Task is bound to its supervision at dispatch time", t => {
  const f = fixture(t);
  const id = f.supervision();
  const at = new Date().toISOString();
  f.db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,'queued',NULL,?)")
    .run("task-linked", "req-linked", f.chief, f.agent, "[]", at);
  f.db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,'queued',NULL,?)")
    .run("task-orphan", "req-orphan", f.chief, f.agent, "[]", at);
  assert.equal(supervisionForTask(f.db, "task-linked"), null, "nothing is linked before dispatch");
  linkTaskToSupervision(f.db, { supervisionId: id, taskId: "task-linked", agentNodeId: f.agent });
  const linked = supervisionForTask(f.db, "task-linked");
  assert.equal(linked?.supervisionId, id, "review() must be able to resolve this Task to its supervision");
  assert.equal(linked?.roundsCompleted, 0);
  // A Task with no supervision keeps the unsupervised single-round behaviour.
  assert.equal(supervisionForTask(f.db, "task-orphan"), null);
  // A closed supervision accepts no further rounds.
  f.round(id, 1);
  decideSupervision(f.db, { supervisionId: id, roundIndex: 1, decision: "STOP", reason: "cancelled", actor: f.node });
  assert.throws(() => linkTaskToSupervision(f.db, { supervisionId: id, taskId: "task-orphan", agentNodeId: f.agent }),
    { code: "conflict" }, "a stopped supervision must not accept new rounds");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { completeResponsibility, getResponsibility } from "../core/organization.ts";
import { createResponsibility } from "./fixtures/organization.ts";
import { CoreRuntime, fixtureBasis } from "./fixtures/execution.ts";
import { grantSelf, issueGrant } from "./fixtures/authority.ts";
import { humanProof } from "./fixtures/human.ts";
import { recordWorld } from "../core/worlds.ts";
import { decideSupervision, linkTaskToSupervision, openSupervision, recordRound } from "../core/supervision.ts";
import { getTask } from "../core/scheduler.ts";
import type { Hythe } from "../hythes/types.ts";

function fixture() {
  const db = openDatabase(":memory:"), at = new Date().toISOString();
  for (const id of ["owner", "worker"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id, id, at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)").run(`${id}-session`, id, `${id}-locator`, at);
    grantSelf(db, id);
  }
  const actor = { kind: "node", nodeId: "owner", sessionId: "owner-session" } as const;
  const worldId = recordWorld(db, "nodes", "owner"), basis = fixtureBasis(db, "owner");
  db.prepare("UPDATE responsibilities SET accepted_at=? WHERE responsibility_id=?").run(at, basis.responsibilityId);
  const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"],
    locate: async () => true, async *receive() {}, invoke: async (_locator, _capability, _body, id) => ({ status: "accepted", hostRef: `turn:${id}` }) };
  const runtime = new CoreRuntime(db, new Map([["fixture", hythe]]));
  issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: "owner", capability: "task.dispatch", resourceScope: "node/worker" });
  issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: "worker", capability: "message.send", resourceScope: "node/owner" });
  const supervisionId = openSupervision(db, { worldId, chiefNodeId: "owner", responsibilityId: basis.responsibilityId,
    goal: "Produce the fixture evidence", acceptanceCriteria: "Verified worker result satisfies the fixture goal", maxRounds: 1 });
  const closeInput = { requestId: "close", responsibilityId: basis.responsibilityId, expectedOwnerNodeId: "owner",
    closureBasis: { kind: "supervision-accept" as const, supervisionId, roundIndex: 1 } };
  const dispatch = async () => {
    const result = await runtime.dispatch({ requestId: "work", originNodeId: "owner", originSessionId: "owner-session",
      centerNodeId: "worker", workerNodeIds: [], body: "Produce fixture artifact evidence", basis });
    linkTaskToSupervision(db, { supervisionId, taskId: result.task.taskId, agentNodeId: "worker" });
    return result;
  };
  return { db, actor, worldId, basis, runtime, supervisionId, closeInput, dispatch,
    close: () => { runtime.close(); db.close(); } };
}

test("C14 worker done and Host acceptance cannot close a Responsibility; accepted completed result can", async () => {
  const f = fixture(); try {
    assert.throws(() => completeResponsibility(f.db, f.actor, { ...f.closeInput, closureBasis: undefined }), { code: "denied" });
    const task = await f.dispatch();
    assert.throws(() => completeResponsibility(f.db, f.actor, f.closeInput), { code: "denied" });
    await f.runtime.ingest("worker-session", { hostRef: task.firstMessage.hostRef!, observedMessageId: task.firstMessage.messageId,
      body: "Artifact fixture://work/output verified", outcome: "completed" });
    assert.equal(getTask(f.db, task.task.taskId).task.state, "completed");
    assert.throws(() => completeResponsibility(f.db, f.actor, f.closeInput), { code: "denied" }, "Executor completion still needs review");
    decideSupervision(f.db, { supervisionId: f.supervisionId, roundIndex: 1, decision: "ACCEPT", reason: "Reviewed canonical result against criteria", actor: f.actor });
    assert.equal(completeResponsibility(f.db, f.actor, f.closeInput).state, "completed");
    assert.equal(completeResponsibility(f.db, f.actor, f.closeInput).state, "completed", "Same closure remains idempotent");
    const rows = f.db.prepare("SELECT payload FROM events WHERE kind='responsibility.completed'").all();
    assert.equal(rows.length, 1);
    const closure = JSON.parse(String(rows[0].payload)).closureBasis;
    assert.equal(closure.supervisionId, f.supervisionId);
    assert.equal(closure.taskId, task.task.taskId);
    assert.ok(closure.evidenceRefs.includes(`message:${closure.resultMessageId}`));
  } finally { f.close(); }
});

test("C14 fabricated ACCEPT with only an accepted Host or a different Responsibility is refused", async () => {
  const f = fixture(); try {
    const task = await f.dispatch();
    recordRound(f.db, { supervisionId: f.supervisionId, roundIndex: 1, agentNodeId: "worker", taskId: task.task.taskId,
      resultMessageId: task.firstMessage.messageId });
    decideSupervision(f.db, { supervisionId: f.supervisionId, roundIndex: 1, decision: "ACCEPT", reason: "Premature claim", actor: f.actor });
    assert.throws(() => completeResponsibility(f.db, f.actor, f.closeInput), { code: "denied" });
    const other = createResponsibility(f.db, f.actor, { requestId: "other", title: "Another obligation", scope: "fixture/other", ownerNodeId: "owner" });
    assert.throws(() => completeResponsibility(f.db, f.actor, { ...f.closeInput, responsibilityId: other.responsibilityId }), { code: "denied" });
    assert.equal(getResponsibility(f.db, other.responsibilityId).state, "active");
  } finally { f.close(); }
});

test("C14 Human judgment must be admitted for exact closure arguments and remains attributable", () => {
  const f = fixture(); try {
    const input = { requestId: "human-close", responsibilityId: f.basis.responsibilityId, expectedOwnerNodeId: "owner",
      closureBasis: { kind: "human-judgment" as const, reason: "Human inspected the outcome and considers the obligation fulfilled" } };
    const duty = getResponsibility(f.db, input.responsibilityId);
    assert.throws(() => completeResponsibility(f.db, { kind: "human", id: "human" }, input), { code: "denied" });
    const proof = humanProof(f.db, f.worldId, "human", { type: "responsibility.complete", objectRef: input.responsibilityId,
      scope: duty.scope, targetRevision: null, args: input, causalRefs: ["fixture:explicit Human closure judgment"] });
    assert.throws(() => completeResponsibility(f.db, { kind: "human", ...proof }, { ...input,
      closureBasis: { ...input.closureBasis, reason: "Altered judgment" } }), { code: "denied" });
    assert.equal(completeResponsibility(f.db, { kind: "human", ...proof }, input).state, "completed");
    const event = f.db.prepare("SELECT payload FROM events WHERE kind='responsibility.completed'").get()!;
    assert.deepEqual(JSON.parse(String(event.payload)).closureBasis.evidenceRefs, [`human-act:${proof.actId}`]);
  } finally { f.close(); }
});

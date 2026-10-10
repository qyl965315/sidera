import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore, ensureMessageAction } from "../core/semantics.ts";
import { createTask } from "../core/scheduler.ts";
import { enqueueMessage } from "../core/bus.ts";
import { openSupervision, linkTaskToSupervision, recordRound, decideSupervision } from "../core/supervision.ts";
import { inspectWork, inspectWorld, type InspectionCaller } from "../core/inspection.ts";
import { issueGrant, grantSelf } from "./fixtures/authority.ts";
import { createResponsibility } from "./fixtures/organization.ts";
import { reviseSubjectivity } from "../core/subjectivity.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";

function fixture() {
  const db = openDatabase(":memory:"), worldId = createWorld(db, "Inspection", "test fixture");
  const store = new SemanticStore(db, worldId), humanId = store.createHuman("Owner", "test fixture");
  const chief = store.registerNode("Chat"), worker = store.registerNode("Worker"), outsider = store.registerNode("Other worker");
  for (const node of [chief, worker, outsider]) {
    db.prepare("INSERT INTO sessions VALUES (?,?,'test-adapter','test-host',?,'active','now')")
      .run(`${node}-session`, node, `test://exact?credential=PRIVATE_LOCATOR_${node}`);
    recordFixtureHostAvailable(db, `${node}-session`);
    grantSelf(db, node);
    reviseSubjectivity(db, { nodeId: node, sessionId: `${node}-session` }, { requestId: `private:${node}`,
      expectedRevision: 0, description: "PRIVATE_DESCRIPTION", explanation: "PRIVATE_EXPLANATION" });
  }
  const caller: InspectionCaller = { kind: "node", nodeId: chief, sessionId: `${chief}-session` };
  issueGrant(db, { kind: "human", id: humanId }, { subjectNodeId: chief, capability: "task.dispatch", resourceScope: `node/${worker}` });
  const responsibility = createResponsibility(db, { kind: "human", id: humanId }, {
    requestId: "responsibility", title: "Review the workspace", scope: "workspace", ownerNodeId: chief,
  });
  const submitted = createTask(db, { requestId: "task", originNodeId: chief, originSessionId: caller.sessionId,
    centerNodeId: worker, workerNodeIds: [], body: "A scoped inspection task" });
  db.prepare("UPDATE task_bases SET responsibility_id=? WHERE task_id=?")
    .run(responsibility.responsibilityId, submitted.task.taskId);
  const supervisionId = openSupervision(db, { worldId, chiefNodeId: chief, responsibilityId: responsibility.responsibilityId,
    goal: "Workspace review", acceptanceCriteria: "Exact inspection result", maxRounds: 2 });
  linkTaskToSupervision(db, { supervisionId, taskId: submitted.task.taskId, agentNodeId: worker });
  const actionId = ensureMessageAction(db, submitted.firstMessage.messageId);
  db.prepare("INSERT INTO task_runs VALUES ('run',?,?,?,'completed',0,'Public checkpoint','now')")
    .run(submitted.task.taskId, `${worker}-session`, submitted.firstMessage.messageId);
  const attemptId = store.attempt(actionId, `${worker}-session`, submitted.firstMessage.messageId);
  db.prepare("UPDATE effect_attempt_state SET state='completed' WHERE attempt_id=?").run(attemptId);
  db.prepare("INSERT INTO effect_audit VALUES ('proof',?,?, 'observation.completed',?, 'now')")
    .run(worldId, attemptId, JSON.stringify({ stdout: "PRIVATE_HOST_STDOUT", ownerToken: "PRIVATE_TOKEN" }));
  const result = enqueueMessage(db, { requestId: "result", taskId: submitted.task.taskId, fromNodeId: worker,
    toNodeId: chief, kind: "result", body: "INSPECTION_ACK", targetSessionId: caller.sessionId });
  db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(submitted.task.taskId);
  recordRound(db, { supervisionId, roundIndex: 1, agentNodeId: worker, taskId: submitted.task.taskId, resultMessageId: result.messageId });
  decideSupervision(db, { supervisionId, roundIndex: 1, decision: "ACCEPT", reason: "Exact result checked", actor: { kind: "node", nodeId: chief } });
  db.prepare("INSERT INTO events VALUES ('inspection-event',?,'runtime.result_reconciled',?,'now')")
    .run(worker, JSON.stringify({ taskId: submitted.task.taskId, runId: "run", stdout: "PRIVATE_EVENT_STDOUT", token: "PRIVATE_EVENT_TOKEN" }));
  return { db, worldId, store, humanId, chief, worker, outsider, caller, taskId: submitted.task.taskId,
    responsibilityId: responsibility.responsibilityId, supervisionId, result };
}

test("Inspection shows canonical Responsibility/Task/Run/round/result/Effect evidence without mutating or exposing private state", () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT total_changes() n").get()!.n;
    const work = inspectWork(f.db, f.caller, { supervisionId: f.supervisionId });
    assert.equal(work.responsibilities[0].responsibilityId, f.responsibilityId);
    assert.equal(work.tasks[0].taskId, f.taskId);
    assert.equal(work.tasks[0].state, "completed");
    assert.equal(work.tasks[0].executingNodeId, f.worker);
    assert.equal(work.tasks[0].supervisorNodeId, f.chief);
    assert.equal(work.tasks[0].runs[0].runId, "run");
    assert.equal(work.tasks[0].runs[0].checkpoint, "Public checkpoint");
    assert.equal(work.tasks[0].effects[0].knowledge, "completed");
    assert.equal(work.tasks[0].effects[0].evidence[0].eventId, "proof");
    assert.equal(work.tasks[0].finalResult?.body, "INSPECTION_ACK");
    assert.equal(work.tasks[0].finalResult?.deliveryState, "queued", "Agent completion does not prove return delivery");
    assert.equal(work.tasks[0].provenance.responsibilityId, f.responsibilityId);
    assert.equal(work.supervisions[0].rounds[0].decision?.decision, "ACCEPT");
    assert.equal(work.recentProgress[0].eventId, "inspection-event");
    const world = inspectWorld(f.db, f.caller);
    assert.equal(world.nodes.length, 3);
    assert.equal(world.tasks.length, 1);
    assert.equal(inspectWork(f.db, f.caller, { responsibilityId: f.responsibilityId }).tasks.length, 1);
    assert.equal(inspectWork(f.db, { kind: "human", id: f.humanId }, { taskId: f.taskId }).tasks.length, 1);
    assert.equal(f.db.prepare("SELECT total_changes() n").get()!.n, before, "All inspection paths are pure reads");
    assert.doesNotMatch(JSON.stringify({ world, work }), /PRIVATE_|owner_token|fence_token|locator_ref|detail_json|reasoning_config/);
  } finally { f.db.close(); }
});

test("Inspection respects exact Session, World, Task participation and Supervisor visibility", () => {
  const f = fixture();
  try {
    const outsider: InspectionCaller = { kind: "node", nodeId: f.outsider, sessionId: `${f.outsider}-session` };
    assert.equal(inspectWorld(f.db, outsider).tasks.length, 0);
    assert.equal(inspectWorld(f.db, outsider).supervisions.length, 0);
    assert.throws(() => inspectWork(f.db, outsider, { taskId: f.taskId }), { code: "denied" });
    assert.throws(() => inspectWork(f.db, outsider, { responsibilityId: f.responsibilityId }), { code: "denied" });
    assert.throws(() => inspectWork(f.db, outsider, { supervisionId: f.supervisionId }), { code: "denied" });
    const worker: InspectionCaller = { kind: "node", nodeId: f.worker, sessionId: `${f.worker}-session` };
    assert.equal(inspectWork(f.db, worker, { taskId: f.taskId }).tasks.length, 1);
    assert.equal(inspectWork(f.db, worker, { taskId: f.taskId }).supervisions.length, 0, "Participation does not expose Supervisor's decision surface");
    const otherWorld = createWorld(f.db, "Another World", "test fixture"), other = new SemanticStore(f.db, otherWorld);
    const otherHuman = other.createHuman("Foreign Human", "test fixture");
    assert.throws(() => inspectWorld(f.db, f.caller, { worldId: otherWorld }), { code: "denied" });
    assert.throws(() => inspectWork(f.db, { kind: "human", id: otherHuman }, { taskId: f.taskId }), { code: "denied" });
    assert.throws(() => inspectWorld(f.db, { kind: "human", id: otherHuman }, { worldId: f.worldId }), { code: "denied" });
    assert.throws(() => inspectWorld(f.db, { kind: "node", nodeId: f.chief, sessionId: `${f.worker}-session` }), { code: "denied" });
  } finally { f.db.close(); }
});

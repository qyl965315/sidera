import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { ackMessage, deliverMessage, getMessage } from "../core/bus.ts";
import { startCooperation } from "../core/cooperation.ts";
import { getTask } from "../core/scheduler.ts";
import { hasPendingStandaloneTurn } from "../core/continuations.ts";
import { CoreRuntime, fixtureBasis, mockProfile } from "./fixtures/execution.ts";
import { issueGrant } from "./fixtures/authority.ts";
import type { Hythe } from "../hythes/types.ts";

function fixture() {
  const db = openDatabase(":memory:"), at = new Date().toISOString();
  for (const nodeId of ["supervisor", "worker"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(nodeId, nodeId, at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)")
      .run(`${nodeId}-session`, nodeId, `${nodeId}-locator`, at);
  }
  for (const [from, to] of [["supervisor", "worker"], ["worker", "supervisor"]]) {
    issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: from, capability: "task.dispatch", resourceScope: `node/${to}` });
    issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: from, capability: "message.send", resourceScope: `node/${to}` });
  }
  const basis = fixtureBasis(db, "supervisor");
  const busy = new Set<string>(), sends: { locator: string; messageId: string; kind: string }[] = [];
  const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"],
    locate: async () => true, effectProfile: () => mockProfile, async *receive() {},
    invoke: async (locator, operation, input, _requestId, boundary) => {
      if (busy.has(locator)) return { status: "rejected", reason: "Host already has an open turn" };
      return boundary!.cross({ product: "fixture", locator, operation }, () => {
        const message = input as { messageId: string; kind: string };
        busy.add(locator); sends.push({ locator, messageId: message.messageId, kind: message.kind });
        return { status: "accepted" as const, hostRef: `turn:${message.messageId}` };
      });
    } };
  const hythes = new Map([["fixture", hythe]]), runtime = new CoreRuntime(db, hythes);
  db.prepare("UPDATE responsibilities SET accepted_at=? WHERE responsibility_id=?").run(at, basis.responsibilityId);
  const start = async () => {
    const kickoff = startCooperation(db, { nodeId: "supervisor", sessionId: "supervisor-session" }, {
      requestId: "kickoff", goal: "Delegate and review the worker result", basis });
    await deliverMessage(db, kickoff.messageId, hythes);
    return kickoff;
  };
  const finish = async (messageId: string, outcome: "completed" | "failed", body = "ACK") => {
    const message = getMessage(db, messageId);
    if (outcome === "completed") busy.delete(`${message.toNodeId}-locator`);
    return runtime.ingest(message.targetSessionId, { observedMessageId: messageId, hostRef: message.hostRef!, outcome, body });
  };
  return { db, runtime, hythes, basis, sends, start, finish, close: () => { runtime.close(); db.close(); } };
}

test("A fast Worker result waits for the exact Supervisor kickoff completion and is released by that event", async () => {
  const f = fixture(); try {
    const kickoff = await f.start();
    assert.equal(hasPendingStandaloneTurn(f.db, "supervisor-session"), true);
    assert.equal(hasPendingStandaloneTurn(f.db, undefined, { currentExecutorOnly: true }), true);
    const work = await f.runtime.dispatch({ requestId: "worker-task", originNodeId: "supervisor", originSessionId: "supervisor-session",
      centerNodeId: "worker", workerNodeIds: [], body: "Return an exact ACK", basis: f.basis });
    await f.finish(work.firstMessage.messageId, "completed", "ACK fast-worker");
    const result = getTask(f.db, work.task.taskId).messages.find(message => message.kind === "result")!;
    assert.equal(result.state, "queued");
    assert.equal(f.sends.filter(send => send.locator === "supervisor-locator").length, 1);
    ackMessage(f.db, kickoff.messageId, "supervisor-session");
    await f.runtime.continuations.pump();
    assert.equal(getMessage(f.db, result.messageId).state, "queued", "Observation ACK does not release a still-open Host turn");
    await assert.rejects(f.runtime.ingest("supervisor-session", { hostRef: "wrong-turn", observedMessageId: kickoff.messageId,
      outcome: "completed", body: "unrelated completion" }), { code: "conflict" });
    assert.equal(getMessage(f.db, result.messageId).state, "queued");
    await f.finish(kickoff.messageId, "completed", "Delegation submitted; waiting for its result");
    assert.equal(getMessage(f.db, kickoff.messageId).state, "observed");
    assert.equal(getMessage(f.db, result.messageId).state, "delivered", "No manual pump or polling after the completion event");
    assert.equal(f.sends.filter(send => send.locator === "supervisor-locator").length, 2);
    await f.finish(kickoff.messageId, "completed");
    assert.equal(f.sends.filter(send => send.messageId === result.messageId).length, 1, "Duplicate completion never resends the result");
    await f.finish(result.messageId, "completed", "Review finished");
    assert.equal(hasPendingStandaloneTurn(f.db), false, "Correlated terminal events make standalone shutdown safe");
  } finally { f.close(); }
});

test("Queued Task cannot collide with a standalone turn; an uncertain kickoff never releases it", async () => {
  const f = fixture(); try {
    // Persisted unsent work may predate a standalone turn. Fresh dispatch into
    // that occupied Executor requires review, while this queue waits safely.
    const pending = f.runtime.continuations.submit({ requestId: "task-to-busy-supervisor", originNodeId: "worker", originSessionId: "worker-session",
      centerNodeId: "supervisor", workerNodeIds: [], body: "Read the independent bounded request" });
    const kickoff = await f.start();
    await assert.rejects(f.runtime.dispatch({requestId:"fresh-to-busy",originNodeId:"worker",originSessionId:"worker-session",centerNodeId:"supervisor",workerNodeIds:[],body:"Cannot queue a new Task into busy context"}),/EXECUTOR_MACHINE_REVIEW_REQUIRED/);
    assert.equal(getMessage(f.db,pending.run.message_id).state, "queued");
    assert.equal(f.sends.length, 1);
    await f.finish(kickoff.messageId, "failed", "Host terminal state could not be confirmed");
    assert.equal(getMessage(f.db, kickoff.messageId).state, "uncertain");
    await f.runtime.continuations.pump();
    assert.equal(getMessage(f.db, pending.run.message_id).state, "queued");
    assert.equal(f.sends.length, 1);
    await assert.rejects(f.finish(kickoff.messageId, "completed", "late completion needs reconciliation"), { code: "conflict" });
    assert.equal(getMessage(f.db, pending.run.message_id).state, "queued");
    f.runtime.close();
    const recovered = new CoreRuntime(f.db, f.hythes);
    try {
      assert.equal(hasPendingStandaloneTurn(f.db), true, "Recovery retains uncertain standalone occupancy for scheduling");
      assert.equal(hasPendingStandaloneTurn(f.db, undefined, { currentExecutorOnly: true }), false,
        "A fenced historical unknown is not an open effect owned by the current executor and cannot prohibit its shutdown");
      await recovered.continuations.pump();
      assert.equal(f.sends.length, 1, "Restart never duplicates the original Host effect or dispatches into its uncertainty");
      assert.equal(getMessage(f.db, pending.run.message_id).state, "queued");
    } finally { recovered.close(); }
  } finally { f.close(); }
});

test("Startup pump preserves queued historical work pinned to an inactive Session without invoking handoff", async () => {
  const f = fixture(); try {
    const pending = f.runtime.continuations.submit({ requestId: "historical-task", originNodeId: "supervisor", originSessionId: "supervisor-session",
      centerNodeId: "worker", workerNodeIds: [], body: "Historical unsent work", basis: f.basis });
    const originalRun = f.runtime.continuations.run(pending.run.run_id);
    f.db.prepare("UPDATE sessions SET state='standby' WHERE session_id='worker-session'").run();
    let wakeStrategies = 0;
    f.runtime.continuations.prepareWake = async () => { wakeStrategies++; throw new Error("Must not attempt historical handoff"); };
    await f.runtime.continuations.pump();
    assert.equal(wakeStrategies, 0); assert.equal(f.sends.length, 0);
    assert.equal(getMessage(f.db, pending.run.message_id).state, "queued");
    assert.deepEqual(f.runtime.continuations.run(pending.run.run_id), originalRun, "Original Run remains unchanged for explicit reconciliation");
  } finally { f.close(); }
});

test("Exact terminal reconciliation releases a failed standalone turn without completing work or rerunning inference",async()=>{
  const f=fixture();try{
    const kickoff=await f.start();await f.finish(kickoff.messageId,"failed","Transport outcome unknown");
    const original=getMessage(f.db,kickoff.messageId),hythe=f.hythes.get("fixture")!;let reads=0;
    hythe.completedTurn=async(locator,hostRef,messageId)=>{
      reads++;assert.equal(locator,"supervisor-locator");assert.equal(hostRef,original.hostRef);
      return {hostRef,observedMessageId:messageId,outcome:"failed",body:"Provider proves original turn interrupted"};
    };
    await assert.rejects(f.runtime.reconcileStandaloneResult("worker-session",kickoff.messageId),{code:"denied"});
    assert.equal(reads,0);
    const result=await f.runtime.reconcileStandaloneResult("supervisor-session",kickoff.messageId);
    assert.equal(result.turnClosed,true);assert.equal(result.resultCompleted,false);
    assert.equal(getMessage(f.db,kickoff.messageId).state,"uncertain");
    assert.equal(hasPendingStandaloneTurn(f.db,"supervisor-session"),false);
    assert.equal(f.sends.length,1);assert.equal(f.db.prepare("SELECT count(*) n FROM task_runs").get()!.n,0);
    assert.equal((await f.runtime.reconcileStandaloneResult("supervisor-session",kickoff.messageId)).replay,true);
    assert.equal(reads,1);
    const effect=f.db.prepare("SELECT state FROM effect_attempt_state").get();assert.equal(effect?.state,"uncertain");
  }finally{f.close();}
});

test("A result owned by a closed continuation Run is not a separate standalone occupancy lease",()=>{
  const f=fixture();try{
    const pending=f.runtime.continuations.submit({requestId:"legacy-continuation",originNodeId:"supervisor",originSessionId:"supervisor-session",
      centerNodeId:"worker",workerNodeIds:[],body:"Historical closed continuation",basis:f.basis});
    f.db.prepare("UPDATE messages SET kind='result',state='uncertain' WHERE message_id=?").run(pending.run.message_id);
    f.db.prepare("UPDATE task_runs SET state='failed',turn_open=0 WHERE run_id=?").run(pending.run.run_id);
    assert.equal(hasPendingStandaloneTurn(f.db,"worker-session"),false);
    assert.equal(getMessage(f.db,pending.run.message_id).state,"uncertain","No historical result is rewritten");
  }finally{f.close();}
});

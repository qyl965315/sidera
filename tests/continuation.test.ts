import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { Continuations } from "./fixtures/execution.ts";
import { getTask } from "../core/scheduler.ts";
import { getMessage } from "./fixtures/bus.ts";
import type { Hythe, HostMessage } from "../hythes/types.ts";
import { ChatGptMcpFrontend } from "../hythes/gpt-backend.ts";

test("push dependencies yield, resume twice in exact Sessions, persist, and never replay uncertain", async () => {
  const base = join(process.cwd(), ".sidera-dev", "sol", "temp");
  mkdirSync(base, { recursive: true });
  const file = join(mkdtempSync(join(base, "dependency-")), "test.sqlite");
  let db = openDatabase(file);
  for (const node of ["sol", "astra", "review", "worker"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)").run(node, node, new Date().toISOString());
    db.prepare("INSERT INTO sessions (session_id,node_id,hythe_id,host_kind,locator_ref,state,created_at) VALUES (?,?,'fake','test',?,'active',?)")
      .run(`${node}-session`, node, `${node}-exact`, new Date().toISOString());
  }
  const calls: { locator: string; input: any }[] = [];
  const fake: Hythe = { hytheId: "fake", hostKind: "test", capabilities: () => ["message.receive"],
    locate: async () => true,
    invoke: async (locator, _cap, input) => {
      calls.push({ locator, input });
      return { status: "accepted", hostRef: `turn-${calls.length}` };
    }, receive: async function* (): AsyncIterable<HostMessage> {} };
  const hythes = new Map([["fake", fake]]);
  let scheduler = new Continuations(db, hythes);
  const input = (requestId: string, origin: string, target: string) => ({ requestId,
    originNodeId: origin, originSessionId: `${origin}-session`, centerNodeId: target,
    workerNodeIds: [], body: requestId });
  assert.throws(() => scheduler.submit(input("no-grant", "sol", "astra")), { code: "denied" });
  for (const node of ["sol", "astra", "review", "worker"]) for (const capability of ["task.dispatch", "message.send"])
    issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: node, capability, resourceScope: "node/**" });
  const root = scheduler.submit(input("root", "sol", "astra"));
  await scheduler.pump();
  assert.equal(getTask(db, root.task.taskId).task.state, "running"); // Host accepted != completed.
  const finish = async (runId: string, body: string) => {
    const run = scheduler.run(runId), message = getMessage(db, run.message_id);
    await scheduler.ingest(run.session_id, { observedMessageId: run.message_id,
      hostRef: message.hostRef!, body, outcome: "completed" });
  };
  const research = scheduler.submit(input("research", "astra", "sol"), { runId: root.run.run_id, checkpoint: "need sources" });
  assert.equal(research.state, "waiting_dependency");
  await scheduler.pump();
  assert.deepEqual(calls.map(x => x.locator), ["astra-exact", "sol-exact"]);
  await assert.rejects(scheduler.ingest("astra-session", { observedMessageId: research.run.message_id,
    hostRef: "turn-2", body: "spoof", outcome: "completed" }), { code: "denied" });
  await finish(research.run.run_id, "sources");
  assert.equal(calls.length, 2); // Child result cannot re-enter a still-open parent turn.
  await finish(root.run.run_id, "yielded");
  assert.equal(calls.length, 3);
  const resumed = calls[2].input;
  assert.equal(resumed.taskId, root.task.taskId);
  const context = JSON.parse(resumed.body);
  assert.equal(context.parentRunId, root.run.run_id);
  assert.equal(context.childTaskId, research.task.taskId);
  assert.equal(context.result, "sources");
  assert.equal(context.checkpoint, "need sources");
  const review = scheduler.submit(input("review", "astra", "sol"), { runId: resumed.runId, checkpoint: "review edits" });
  // Reconcile same request without another task or host turn.
  assert.equal(scheduler.submit(input("review", "astra", "sol"), { runId: resumed.runId, checkpoint: "review edits" }).task.taskId, review.task.taskId);
  await finish(resumed.runId, "yielded for review");
  await finish(review.run.run_id, "approved");
  assert.equal(calls.length, 5);
  await finish(calls[4].input.runId, "done");
  assert.equal(getTask(db, root.task.taskId).task.state, "completed");
  assert.equal(calls[5].locator, "sol-exact");
  assert.equal(calls[5].input.body, "done");
  assert.ok(Number((db.prepare("SELECT count(*) AS n FROM grant_uses WHERE status = 'consumed'").get() as any).n) >= 6);
  db.close(); db = openDatabase(file); scheduler = new Continuations(db, hythes); scheduler.recover();
  await scheduler.pump();
  assert.equal(calls.length, 6);
  assert.equal(getTask(db, root.task.taskId).runs.length, 3);
  assert.equal(getTask(db, root.task.taskId).dependencies.length, 2);
  // Crash while accepted: recover state as uncertain, never resend.
  const interrupted = scheduler.submit(input("interrupted", "sol", "astra"));
  await scheduler.pump();
  db.close(); db = openDatabase(file); scheduler = new Continuations(db, hythes); scheduler.recover();
  await scheduler.pump();
  assert.equal(scheduler.run(interrupted.run.run_id).state, "uncertain");
  assert.equal(calls.length, 7);
  // A failed child wakes a quiescent Supervisor with a failure observation, never resends the child.
  const failureRoot = scheduler.submit(input("failure-root", "review", "worker"));
  await scheduler.pump();
  const failedChild = scheduler.submit(input("failed-child", "worker", "review"), {
    runId: failureRoot.run.run_id, checkpoint: "retain commitment and inspect the outcome" });
  await scheduler.pump();
  const failedRun = scheduler.run(failedChild.run.run_id);
  await scheduler.ingest(failedRun.session_id,{hostRef:getMessage(db,failedRun.message_id).hostRef!,
    observedMessageId:failedRun.message_id,body:"",outcome:"failed"});
  assert.equal(scheduler.run(failedRun.run_id).state,"uncertain");
  assert.equal(scheduler.run(failureRoot.run.run_id).state,"waiting_dependency");
  await finish(failureRoot.run.run_id,"WAIT");
  const failureWake = calls.at(-1)!.input;
  assert.equal(JSON.parse(failureWake.body).type,"dependency_failure");
  assert.equal(JSON.parse(failureWake.body).dependencyState,"uncertain");
  assert.equal(calls.filter(call=>call.input.body==="failed-child").length,1);
  const countAfterFailure = calls.length;
  await scheduler.pump();
  assert.equal(calls.length,countAfterFailure);
  const frontend = new ChatGptMcpFrontend("gpt-exact", () => false);
  assert.equal(frontend.discover().operations.sendNewTurn, false);
  assert.equal((await frontend.returnResult("gpt-exact", { messageId: "result", kind: "result" })).status, "uncertain");
  db.close();
});

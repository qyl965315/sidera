import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { retrieveArchive } from "../qwen/processor.ts";
import { createConnection } from "node:net";
import { once } from "node:events";
import { openDatabase } from "../core/db.ts";
import { issueGrant, reserveCapability, settleReservation } from "./fixtures/authority.ts";
import { ackMessage, deliverMessage, recoverInterruptedDelivery } from "./fixtures/bus.ts";
import { getTask } from "../core/scheduler.ts";
import { createTask } from "../core/scheduler.ts"; // Historical storage fixtures only.
import { completeTask, delegateTask } from "./legacy-scheduler.ts";
import type { Hythe, HostMessage, InvokeResult } from "../hythes/types.ts";
import { LocalPeregrineManager } from "../peregrine/local.ts";
import { CoreRuntime,fixtureBasis } from "./fixtures/execution.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";

function dispatchTask(db:Parameters<typeof createTask>[0],input:Parameters<typeof createTask>[1]) {
  return createTask(db,{...input,basis:input.basis??fixtureBasis(db,input.originNodeId)});
}

function seed(db: ReturnType<typeof openDatabase>): void {
  for (const id of ["chatgpt", "astra", "worker"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)")
      .run(id, id, new Date().toISOString());
  }
  for (const [sessionId, nodeId, locator] of [
    ["gpt-1", "chatgpt", "gpt-conversation-1"],
    ["astra-1", "astra", "codex-thread-1"],
    ["worker-1", "worker", "worker-thread-1"],
  ]) {
    db.prepare(`INSERT INTO sessions
      (session_id, node_id, hythe_id, host_kind, locator_ref, state, created_at)
      VALUES (?, ?, 'local', 'test', ?, 'active', ?)`)
      .run(sessionId, nodeId, locator, new Date().toISOString());
  }
  for(const session of db.prepare("SELECT session_id FROM sessions WHERE state=\'active\'").all())
    recordFixtureHostAvailable(db,String(session.session_id));
  for(const node of ["chatgpt","astra","worker"])grantSelf(db,node);
}

class RecordingHythe implements Hythe {
  readonly hytheId = "local";
  readonly hostKind = "test";
  readonly calls: { locator: string; input: unknown }[] = [];
  private readonly outcome: InvokeResult;
  constructor(outcome: InvokeResult =
    { status: "accepted", hostRef: "host-message-1" }) {
    this.outcome = outcome;
  }
  capabilities(): readonly string[] { return ["message.receive"]; }
  async locate(): Promise<boolean> { return true; }
  async invoke(locator: string, _capability: string, input: unknown): Promise<InvokeResult> {
    this.calls.push({ locator, input });
    return this.outcome;
  }
  async *receive(): AsyncIterable<HostMessage> { return; }
}

test("archive infrastructure cannot rewrite dispatch or make Shared Pool into subjectivity", async () => {
  const db = openDatabase(":memory:"); seed(db);
  try {
    issueGrant(db, { kind: "human", id: "owner" }, {
      subjectNodeId: "chatgpt", capability: "task.dispatch", resourceScope: "node/astra",
    });
    let indexed = false;
    const hythe = new RecordingHythe();
    const runtime = new CoreRuntime(db, new Map([["local", hythe]]), {
      async index(entry) { indexed = true; assert.equal(Object.isFrozen(entry), true);
        assert.equal(entry.kind, "history"); throw new Error("Index offline"); },
      async retrieve() { return []; }, async accessible() { return "untrusted accessible rendering"; },
    });
    const result = await runtime.dispatch({ requestId: "archive-boundary", originNodeId: "chatgpt",
      originSessionId: "gpt-1", centerNodeId: "astra", workerNodeIds: [], body: "exact original task" });
    assert.equal(indexed, true); assert.equal(result.firstMessage.body, "exact original task");
    assert.equal(result.firstMessage.state, "delivered");
    assert.equal(db.prepare("SELECT revision FROM node_subjectivity WHERE node_id='astra'").get()?.revision, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sovereign_memory").get()?.n, 0);
    const hits = await retrieveArchive({ async index() {}, async accessible(entry) { return entry.text; },
      async retrieve(_query, refs) { assert.deepEqual(refs, ["allowed-event"]);
        return [{ kind: "history", ref: "allowed-event", excerpt: "observation" },
          { kind: "history", ref: "other-node-private-event", excerpt: "must not escape" }]; }
    }, "find evidence", ["allowed-event"]);
    assert.deepEqual(hits.map(hit => hit.ref), ["allowed-event"]);
    assert.equal(db.prepare("SELECT revision FROM node_subjectivity WHERE node_id='astra'").get()?.revision, 0);
  } finally { db.close(); }
});

test("self sovereignty does not grant authority over another node; Human standing budget is bounded", () => {
  const db = openDatabase(":memory:");
  seed(db);
  assert.ok(reserveCapability(db, {
    subjectNodeId: "astra", sessionId: "astra-1", capability: "self.modify",
    resource: "node/astra/skills", requestId: "self-1",
  }).grantId);
  assert.throws(() => reserveCapability(db, {
    subjectNodeId: "astra", sessionId: "astra-1", capability: "self.modify",
    resource: "node/worker/skills", requestId: "self-2",
  }), { code: "denied" });
  const parent = issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "astra", capability: "message.*", resourceScope: "node/**",
    limit: 1, delegable: true,
  });
  const selfDerived=issueGrant(db, { kind: "node", nodeId: "astra" }, {
    subjectNodeId: "astra", capability: "message.send", resourceScope: "node/worker",
    parentGrantId: parent.grantId,
  });
  assert.equal(selfDerived.parentGrantId,parent.grantId);
  const workerDerived=issueGrant(db, { kind: "node", nodeId: "astra" }, {
    subjectNodeId: "worker", capability: "message.send", resourceScope: "node/chatgpt",
    parentGrantId: parent.grantId, limit: 1,
  });
  assert.equal(workerDerived.parentGrantId,parent.grantId);
  const first = reserveCapability(db, {
    subjectNodeId: "worker", sessionId: "worker-1", capability: "message.send",
    resource: "node/chatgpt", requestId: "send-1",
  });
  assert.ok(first.reservationId);
  assert.throws(() => reserveCapability(db, {
    subjectNodeId: "worker", sessionId: "worker-1", capability: "message.send",
    resource: "node/chatgpt", requestId: "send-2",
  }), { code: "denied" });
  settleReservation(db, first.reservationId!, "released");
  assert.ok(reserveCapability(db, {
    subjectNodeId: "worker", sessionId: "worker-1", capability: "message.send",
    resource: "node/chatgpt", requestId: "send-2",
  }).reservationId);
  db.close();
});

test("dispatch pins an exact Session; handoff and retry do not reroute it", async () => {
  const db = openDatabase(":memory:");
  seed(db);
  issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "chatgpt", capability: "task.dispatch", resourceScope: "node/astra",
  });
  const sent = dispatchTask(db, {
    requestId: "task-1", originNodeId: "chatgpt", originSessionId: "gpt-1",
    centerNodeId: "astra", workerNodeIds: ["worker"], body: "inspect one file",
  });
  assert.equal(sent.firstMessage.targetSessionId, "astra-1");
  const hythe = new RecordingHythe();
  const delivered = await deliverMessage(db, sent.firstMessage.messageId,
    new Map([["local", hythe]]));
  assert.equal(delivered.state, "delivered");
  assert.equal(hythe.calls[0].locator, "codex-thread-1");
  db.exec("UPDATE sessions SET state = 'retired' WHERE session_id = 'astra-1'");
  db.prepare(`INSERT INTO sessions
    (session_id, node_id, hythe_id, host_kind, locator_ref, state, created_at)
    VALUES ('astra-2', 'astra', 'local', 'test', 'codex-thread-2', 'active', ?)`)
    .run(new Date().toISOString());
  const retry = dispatchTask(db, {
    requestId: "task-1", originNodeId: "chatgpt", originSessionId: "gpt-1",
    centerNodeId: "astra", workerNodeIds: ["worker"], body: "inspect one file",
  });
  assert.equal(retry.firstMessage.messageId, sent.firstMessage.messageId);
  assert.throws(() => ackMessage(db, delivered.messageId, "astra-2"), { code: "denied" });
  assert.equal(ackMessage(db, delivered.messageId, "astra-1").state, "observed");
  db.close();
});

test("Center delegates to Worker and a result survives Core restart", () => {
  const root = join(process.cwd(), ".sidera-dev", "sol", "temp");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "core-test-"));
  try {
    const file = join(folder, "sidera.sqlite");
    let db = openDatabase(file);
    seed(db);
    for (const [node, capability, scope] of [
      ["chatgpt", "task.dispatch", "node/astra"],
      ["astra", "task.delegate", "node/worker"],
      ["worker", "message.send", "node/chatgpt"],
    ]) {
      issueGrant(db, { kind: "human", id: "owner" }, {
        subjectNodeId: node, capability, resourceScope: scope,
      });
    }
    const initial = dispatchTask(db, {
      requestId: "dispatch-1", originNodeId: "chatgpt", originSessionId: "gpt-1",
      centerNodeId: "astra", workerNodeIds: ["worker"], body: "compute 2 + 2",
    });
    const delegated = delegateTask(db, {
      taskId: initial.task.taskId, centerNodeId: "astra", centerSessionId: "astra-1",
      workerNodeId: "worker", requestId: "delegate-1", body: "calculate",
    });
    assert.equal(delegated.targetSessionId, "worker-1");
    const result = completeTask(db, {
      taskId: initial.task.taskId, fromNodeId: "worker", fromSessionId: "worker-1",
      requestId: "result-1", body: "4",
    });
    assert.equal(result.targetSessionId, "gpt-1");
    db.close();
    db = openDatabase(file);
    const view = getTask(db, initial.task.taskId);
    assert.equal(view.task.state, "completed");
    assert.deepEqual(view.messages.map(message => message.kind), ["task", "delegate", "result"]);
    db.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("uncertain delivery is not retried without reconciliation", async () => {
  const db = openDatabase(":memory:");
  seed(db);
  issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "chatgpt", capability: "task.dispatch", resourceScope: "node/astra",
    limit: 1,
  });
  const task = dispatchTask(db, {
    requestId: "uncertain-1", originNodeId: "chatgpt", originSessionId: "gpt-1",
    centerNodeId: "astra", workerNodeIds: [], body: "do one thing",
  });
  const hythe = new RecordingHythe({ status: "uncertain", reason: "host timeout" });
  const hythes = new Map([["local", hythe]]);
  assert.equal((await deliverMessage(db, task.firstMessage.messageId, hythes)).state,
    "uncertain");
  await deliverMessage(db, task.firstMessage.messageId, hythes);
  assert.equal(hythe.calls.length, 1);
  const reservation = db.prepare("SELECT status FROM grant_uses WHERE request_id = ?")
    .get("uncertain-1") as { status: string };
  assert.equal(reservation.status, "reserved");
  db.prepare("UPDATE messages SET state = 'sending' WHERE message_id = ?")
    .run(task.firstMessage.messageId);
  assert.equal(recoverInterruptedDelivery(db), 1);
  assert.equal((await deliverMessage(db, task.firstMessage.messageId, hythes)).state,
    "uncertain");
  assert.equal(hythe.calls.length, 1);
  db.close();
});

test("a Host turn without an Agent result ends the tool wait as uncertain", async () => {
  const db = openDatabase(":memory:");
  try {
    seed(db);
    issueGrant(db, { kind: "human", id: "owner" }, {
      subjectNodeId: "chatgpt", capability: "task.dispatch",
      resourceScope: "node/astra",
    });
    const hythe = new RecordingHythe();
    const runtime = new CoreRuntime(db, new Map([["local", hythe]]));
    let status: { state: string; body: string } | null = null;
    runtime.onResult(event => { status = event; });
    const { task, firstMessage } = await runtime.dispatch({
      requestId: "failed-host-turn", originNodeId: "chatgpt",
      originSessionId: "gpt-1", centerNodeId: "astra",
      workerNodeIds: [], body: "one task",
    });
    await runtime.ingest("astra-1", {
      hostRef: firstMessage.hostRef!, observedMessageId: firstMessage.messageId,
      body: "Host turn could not be confirmed", outcome: "failed",
    });
    assert.equal(getTask(db, task.taskId).task.state, "uncertain");
    assert.equal(getTask(db, task.taskId).messages[0].state, "uncertain");
    assert.deepEqual(status, { taskId: task.taskId, originNodeId: "chatgpt",
      body: "Host turn could not be confirmed", messageId: firstMessage.messageId, state: "uncertain" });
    const diagnostic = db.prepare("SELECT payload FROM events WHERE kind='runtime.host_failure'").get() as { payload: string };
    assert.equal(JSON.parse(diagnostic.payload).reason, "Host turn could not be confirmed");
    await deliverMessage(db, firstMessage.messageId, new Map([["local", hythe]]));
    assert.equal(hythe.calls.length, 1);
  } finally {
    db.close();
  }
});

test("self-controlled Peregrine runs headless with its own HOME, TEMP and workspace", async () => {
  const db = openDatabase(":memory:");
  seed(db);
  const root = join(process.cwd(), ".sidera-dev", "sol", "temp");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "peregrine-test-"));
  try {
    const manager = new LocalPeregrineManager(db, folder);
    const domain = manager.create("astra", "astra-1", "create-peregrine");
    const result = await manager.run({
      peregrineId: domain.peregrineId, ownerNodeId: "astra", sessionId: "astra-1",
      requestId: "run-peregrine", executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify({home:process.env.HOME,temp:process.env.TEMP,cwd:process.cwd()}))"],
      timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    const observed = JSON.parse(result.stdout.trim()) as
      { home: string; temp: string; cwd: string };
    assert.equal(observed.home, domain.homeRef);
    assert.equal(observed.temp, domain.tempRef);
    assert.equal(observed.cwd, domain.workspaceRef);
    manager.stop(domain.peregrineId, "astra", "astra-1", "stop-peregrine");
    manager.destroy(domain.peregrineId, "astra", "astra-1", "destroy-peregrine");
    assert.throws(() => manager.get(domain.peregrineId), { code: "not_found" });
  } finally {
    rmSync(folder, { recursive: true, force: true });
    db.close();
  }
});

test("one local RPC crosses two Hythes and returns an Agent result", async () => {
  const db = openDatabase(":memory:");
  seed(db);
  db.exec("UPDATE sessions SET hythe_id = 'gpt' WHERE session_id = 'gpt-1'");
  db.exec("UPDATE sessions SET hythe_id = 'codex' WHERE session_id = 'astra-1'");
  issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "chatgpt", capability: "task.dispatch", resourceScope: "node/astra",
  });
  issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "astra", capability: "message.send", resourceScope: "node/chatgpt",
  });
  const gpt = new RecordingHythe();
  const codex = new RecordingHythe();
  const hythes = new Map<string, Hythe>([["gpt", gpt], ["codex", codex]]);
  const runtime = new CoreRuntime(db, hythes);
  const rpc = new CoreRpcServer(db, runtime, hythes, {
    authenticate: token => token === "test-chatgpt-session" ?
      { kind: "node", nodeId: "chatgpt", sessionId: "gpt-1" } : null,
  });
  const port = await rpc.listen();
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await once(socket, "connect");
    socket.write(`${JSON.stringify({
      id: 1, token: "test-chatgpt-session", method: "task.dispatch",
      params: { requestId: "wire-1", centerNodeId: "astra", workerNodeIds: [],
        body: "return one result" },
    })}\n`);
    const [chunk] = await once(socket, "data") as [Buffer];
    const response = JSON.parse(chunk.toString().trim()) as {
      result: { task: { taskId: string }; firstMessage: { messageId: string; hostRef:string } };
    };
    assert.equal(codex.calls.length, 1);
    assert.equal(codex.calls[0].locator, "codex-thread-1");
    assert.ok(response.result.task.taskId);
    const pushedResult = once(socket, "data") as Promise<[Buffer]>;
    const completion = await runtime.ingest("astra-1", {
      hostRef: response.result.firstMessage.hostRef, observedMessageId: response.result.firstMessage.messageId,
      body: "completed in Astra", outcome:"completed",
    });
    assert.equal(completion.result?.state, "delivered");
    assert.equal(gpt.calls.length, 1);
    assert.equal(gpt.calls[0].locator, "gpt-conversation-1");
    assert.equal(getTask(db, response.result.task.taskId).task.state, "completed");
    const [resultChunk] = await pushedResult;
    const event = JSON.parse(resultChunk.toString().trim()) as {
      method: string; params: { body: string; taskId: string };
    };
    assert.equal(event.method, "task.result");
    assert.equal(event.params.body, "completed in Astra");
    assert.equal(event.params.taskId, response.result.task.taskId);
  } finally {
    socket.end();
    await once(socket, "close");
    await rpc.close();
    db.close();
  }
});

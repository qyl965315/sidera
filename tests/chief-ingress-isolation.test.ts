import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { createResponsibility } from "../core/organization.ts";
import { createTask } from "../core/scheduler.ts";
import { registerArtifact } from "../core/shared-transfer.ts";
import { openSupervision, linkTaskToSupervision, recordRound, decideSupervision } from "../core/supervision.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { callCore, withAuthenticatedMcpIngress, type CoreClientConfig } from "../hythes/core-client.ts";
import { SemanticStore } from "./fixtures/human.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { bindChiefConversation, ChiefDispatch } from "./fixtures/chief.ts";
import { recordFixtureHostAvailable } from "./fixtures/host-condition.ts";

// SYNTHETIC identities, Human acts and transport credentials. Real loopback RPC
// and canonical Task/Artifact lookup; no provider, production state or Host turn.
async function fixture() {
  const db = openDatabase(":memory:"), worldId = createWorld(db, "Isolation", "synthetic fixture");
  const store = new SemanticStore(db, worldId), human = store.createHuman("Owner", "synthetic fixture");
  const chiefNodeId = store.registerNode("Chief"), workers = [0, 1, 2].map(i => store.registerNode(`Worker ${i}`)), worker = workers[0]!;
  for (const node of [chiefNodeId, ...workers]) {
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture',?,?,'active','now')")
      .run(`${node}-session`, node, node === chiefNodeId ? "external-mcp-client" : "fixture", `fixture://${node}`);
    recordFixtureHostAvailable(db, `${node}-session`);
  }
  const caller = { nodeId: chiefNodeId, sessionId: `${chiefNodeId}-session` };
  const bindings = ["one", "two"].map(name => bindChiefConversation(db, { kind: "human", id: human }, {
    chiefNodeId, projectSpaceId: name, projectRef: `fixture:${name}`,
    frontendKind: "chatgpt", conversationRef: `fixture://chat/${name}`,
  }));
  const intent = store.createIntent(human, "fixture"), revision = store.reviseIntent(intent, null, "Bounded task", "fixture:intent");
  const responsibility = createResponsibility(db, { kind: "node", ...caller }, {
    requestId: randomUUID(), title: "Bounded work", scope: "fixture", ownerNodeId: chiefNodeId,
    basis: { intentRevisionId: revision, contextBasis: ["fixture:source"] },
  });
  const basis = { responsibilityId: responsibility.responsibilityId, intentRevisionId: revision, contextBasis: ["fixture:source"] };
  for (const target of workers) issueGrant(db, { kind: "human", id: human }, { subjectNodeId: chiefNodeId, capability: "task.dispatch", resourceScope: `node/${target}` });
  const tasks = [...bindings, null].map((binding, index) => {
    const task = createTask(db, { requestId: randomUUID(), originNodeId: chiefNodeId, originSessionId: caller.sessionId,
      centerNodeId: workers[index]!, workerNodeIds: [], body: binding ? `Private Task for ${binding.conversationRef}` : "Node-scoped standalone work", basis });
    if (binding) db.prepare("INSERT INTO chief_task_routes VALUES (?,?)").run(task.task.taskId, binding.bindingId);
    const artifact = registerArtifact(db, caller, { requestId: randomUUID(), taskId: task.task.taskId,
      reference: `fixture://artifact/${task.task.taskId}`, sourceRefs: [{ kind: "message", id: task.firstMessage.messageId }] });
    const runId = randomUUID();
    db.prepare("INSERT INTO task_runs VALUES (?,?,?,?,'running',0,'','now')")
      .run(runId, task.task.taskId, `${workers[index]}-session`, task.firstMessage.messageId);
    return { task, artifact, runId };
  });
  const hythes = new Map(), runtime = new CoreRuntime(db, hythes);
  const prepared: string[] = [];
  const chief = new ChiefDispatch(db, hythes, { inspect: async () => { throw Error("No UI"); }, deliver: async () => { throw Error("No push"); },
    prepare: binding => { prepared.push(binding.bindingId); return { prepared: true, routeId: "synthetic-route", reason: "synthetic fixture only" }; } });
  const token = "synthetic-core-token", rpc = new CoreRpcServer(db, runtime, hythes,
    { authenticate: value => value === token ? { kind: "node", ...caller } : null }, undefined, undefined, chief);
  const port = await rpc.listen(0);
  const clients: CoreClientConfig[] = bindings.map(binding => ({ port, token, chiefIngressScope: {
    nodeId: chiefNodeId, edgeId: "fixture", conversationRef: binding.conversationRef, bindingId: binding.bindingId,
  } }));
  const invoke = (index: number, method: string, params: Record<string, unknown>) =>
    withAuthenticatedMcpIngress(clients[index]!, undefined, () => callCore(clients[index]!, method, params)) as Promise<any>;
  const preview = (sourceRefs: unknown[]) => ({ requestId: randomUUID(), targetNodeId: worker, basis,
    purpose: "Bounded source preview", selector: "Exact references", sourceRefs });
  const linkSupervision = (index: number, supervisionId?: string) => {
    const id = supervisionId ?? openSupervision(db, { worldId, chiefNodeId, responsibilityId: responsibility.responsibilityId,
      goal: "Synthetic supervised work", acceptanceCriteria: "Bounded result", maxRounds: 3 });
    if (supervisionId) decideSupervision(db, { supervisionId, roundIndex: index, decision: "CONTINUE",
      reason: "Synthetic further work", instruction: "Bounded next step", actor: { kind: "node", nodeId: chiefNodeId } });
    linkTaskToSupervision(db, { supervisionId: id, taskId: tasks[index]!.task.task.taskId, agentNodeId: workers[index]! });
    recordRound(db, { supervisionId: id, roundIndex: index + 1, taskId: tasks[index]!.task.task.taskId, agentNodeId: workers[index]! });
    return id;
  };
  return { db, tasks, bindings, prepared, invoke, preview, linkSupervision,
    async close() { await rpc.close(); chief.close(); runtime.close(); db.close(); } };
}

test("Chief ingress reads only the original Chat's routed Artifact; standalone Node work stays shared", async () => {
  const f = await fixture();
  try {
    const original = f.tasks[0]!, standalone = f.tasks[2]!;
    assert.equal((await f.invoke(0, "artifact.get", { artifactId: original.artifact.artifactId })).taskId, original.task.task.taskId);
    await assert.rejects(f.invoke(1, "artifact.get", { artifactId: original.artifact.artifactId }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
    assert.equal((await f.invoke(1, "artifact.get", { artifactId: standalone.artifact.artifactId })).taskId, standalone.task.task.taskId);
    assert.equal((await f.invoke(1, "task.get", { taskId: standalone.task.task.taskId })).task.taskId, standalone.task.task.taskId);
    assert.equal((await f.invoke(1, "work.inspect", { taskId: standalone.task.task.taskId })).tasks[0].taskId, standalone.task.task.taskId);
  } finally { await f.close(); }
});

test("Chief ingress keeps Run basis within the original Chat", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.invoke(0, "run.basis", { runId: f.tasks[0]!.runId })).run_id, f.tasks[0]!.runId);
    await assert.rejects(f.invoke(1, "run.basis", { runId: f.tasks[0]!.runId }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
    assert.equal((await f.invoke(1, "run.basis", { runId: f.tasks[2]!.runId })).run_id, f.tasks[2]!.runId);
  } finally { await f.close(); }
});

test("Chief ingress rejects a supervised work projection containing another Chat's rounds", async () => {
  const f = await fixture();
  try {
    const supervision = f.linkSupervision(0);
    assert.equal((await f.invoke(0, "work.inspect", { taskId: f.tasks[0]!.task.task.taskId })).supervisions[0].rounds.length, 1);
    f.linkSupervision(1, supervision);
    await assert.rejects(f.invoke(0, "work.inspect", { taskId: f.tasks[0]!.task.task.taskId }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
  } finally { await f.close(); }
});

test("Authenticated Chief scope also constrains a Node hosted by a proactive Host", async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE sessions SET host_kind='fixture' WHERE host_kind='external-mcp-client'").run();
    await assert.rejects(f.invoke(1, "artifact.get", { artifactId: f.tasks[0]!.artifact.artifactId }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
    await assert.rejects(f.invoke(1, "task.get", { taskId: f.tasks[0]!.task.task.taskId }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
    assert.equal((await f.invoke(0, "artifact.get", { artifactId: f.tasks[0]!.artifact.artifactId })).taskId, f.tasks[0]!.task.task.taskId);
    f.db.prepare("UPDATE chief_conversations SET state='retired'").run();
    await assert.rejects(f.invoke(0, "artifact.get", { artifactId: f.tasks[0]!.artifact.artifactId }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
  } finally { await f.close(); }
});

test("Chief frontend preparation selects only the authenticated binding when the Node has two Projects", async () => {
  const f = await fixture();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(new Set(f.prepared), new Set(f.bindings.map(binding => binding.bindingId)), "Queued binding lifecycle events keep their exact Project");
    f.prepared.length = 0;
    assert.equal((await f.invoke(1, "chief.frontend_prepare", {})).prepared, true);
    assert.deepEqual(f.prepared, [f.bindings[1]!.bindingId]);
  } finally { await f.close(); }
});

test("Chief ingress cannot preview or relabel another Chat's Task-bound message or Artifact", async () => {
  const f = await fixture();
  try {
    const original = f.tasks[0]!, destination = f.tasks[1]!, standalone = f.tasks[2]!;
    for (const source of [{ kind: "artifact", id: original.artifact.artifactId }, { kind: "message", id: original.task.firstMessage.messageId }]) {
      assert.equal((await f.invoke(0, "context.preview", f.preview([source]))).envelope.sources.length, 1);
      await assert.rejects(f.invoke(1, "context.preview", f.preview([source])), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
      await assert.rejects(f.invoke(1, "artifact.register", { requestId: randomUUID(), taskId: destination.task.task.taskId,
        reference: "fixture://laundered", sourceRefs: [source] }), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
      const count = f.db.prepare("SELECT count(*) n FROM context_handoffs").get()!.n;
      await assert.rejects(f.invoke(1, "context.handoff", f.preview([source])), /denied: .*scope|outside this authenticated Chief Conversation inbox/);
      assert.equal(f.db.prepare("SELECT count(*) n FROM context_handoffs").get()!.n, count);
    }
    assert.equal((await f.invoke(1, "context.preview", f.preview([{ kind: "message", id: standalone.task.firstMessage.messageId }]))).envelope.sources.length, 1);
  } finally { await f.close(); }
});

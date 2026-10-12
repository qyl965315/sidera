import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { bindChiefConversation, ChiefDispatch } from "./fixtures/chief.ts";
import { putResource } from "../core/resources.ts";
import { registerArtifact } from "../core/shared-transfer.ts";
import { callCore, withAuthenticatedMcpIngress, type CoreClientConfig } from "../hythes/core-client.ts";
import type { Hythe } from "../hythes/types.ts";

/** Synthetic records and authenticated loopback RPC only. No provider execution. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sidera-chief-resource-scope-"));
  const db = openDatabase(join(dir, "test.sqlite")), at = new Date().toISOString();
  for (const node of ["chief", "worker-a", "worker-b"] ) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node, node, at);
    // This Chief also has an internal Host: ingress scope must not depend on
    // the compatibility external-mcp-client host_kind alone.
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)")
      .run(`${node}-session`, node, `fixture://${node}`, at);
  }
  const bindings = ["a", "b"].map(id => bindChiefConversation(db, { kind: "human", id: "synthetic-owner" }, {
    projectSpaceId: id, projectRef: `synthetic:${id}`, chiefNodeId: "chief", frontendKind: "chatgpt",
    conversationRef: `https://chatgpt.com/c/synthetic-${id}`,
  }));
  const fake: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"],
    locate: async () => true, invoke: async () => { throw Error("Resource scope tests must not execute a Host"); },
    async *receive() {} };
  const hythes = new Map([["fixture", fake]]), runtime = new CoreRuntime(db, hythes);
  for (const node of ["worker-a", "worker-b"])
    issueGrant(db, { kind: "human", id: "synthetic-owner" }, {
      subjectNodeId: "chief", capability: "task.dispatch", resourceScope: `node/${node}`,
    });
  const caller = { nodeId: "chief", sessionId: "chief-session" };
  const tasks = bindings.map((binding, i) => {
    const task = runtime.continuations.submit({ requestId: randomUUID(), originNodeId: "chief",
      originSessionId: caller.sessionId, centerNodeId: i ? "worker-b" : "worker-a", workerNodeIds: [],
      body: "Synthetic resource provenance only", projectRef: binding.projectRef });
    db.prepare("INSERT INTO chief_task_routes VALUES (?,?)").run(task.task.taskId, binding.bindingId);
    return task;
  });
  const artifact = registerArtifact(db, caller, { requestId: randomUUID(), taskId: tasks[0]!.task.taskId,
    reference: "synthetic://private-result-a" });
  const chief = new ChiefDispatch(db, hythes, {
    inspect: async () => ({ ready: false, reason: "synthetic read-only fixture" }),
    deliver: async () => { throw Error("No frontend effects in this test"); },
  });
  const rpc = new CoreRpcServer(db, runtime, hythes, {
    authenticate: token => token === "synthetic-token" ? { kind: "node" as const, ...caller } : null,
  }, undefined, dir, chief);
  const port = await rpc.listen(0);
  const configs: CoreClientConfig[] = bindings.map(binding => ({ port, token: "synthetic-token",
    chiefIngressScope: { nodeId: "chief", edgeId: "synthetic-loopback", conversationRef: binding.conversationRef,
      bindingId: binding.bindingId } }));
  const invoke = (index: number, method: string, input: Record<string, unknown>) =>
    withAuthenticatedMcpIngress(configs[index]!, undefined, () => callCore(configs[index]!, method, input));
  const publish = (name: string, links: Record<string, string> = {}) => putResource(db, dir, caller, {
    requestId: randomUUID(), name, dataText: `synthetic bytes: ${name}`, ...links,
  }).resource;
  return { db, tasks, artifact, configs, invoke, publish,
    async close() { await rpc.close(); chief.close(); runtime.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("SYNTHETIC scoped Resource reads follow direct Task, Run and Artifact provenance without hiding standalone Node resources", async () => {
  const f = await fixture();
  try {
    const privateResources = [
      f.publish("private-direct", { taskId: f.tasks[0]!.task.taskId }),
      f.publish("private-run", { runId: f.tasks[0]!.run.run_id }),
      f.publish("private-artifact", { artifactId: f.artifact.artifactId }),
    ];
    const own = f.publish("project-b", { taskId: f.tasks[1]!.task.taskId }), shared = f.publish("shared-node");
    for (const resource of privateResources) {
      await assert.rejects(f.invoke(1, "resource.get", { resourceId: resource.resourceId }), /denied/);
      await assert.rejects(f.invoke(1, "resource.metadata", { resourceId: resource.resourceId }), /denied/);
      const read = await f.invoke(0, "resource.get", { resourceId: resource.resourceId }) as { data: string };
      assert.equal(read.data, `synthetic bytes: ${resource.name}`);
      await assert.rejects(f.invoke(1, "resource.scope", { requestId: randomUUID(), resourceId: resource.resourceId,
        targetNodeId: "worker-b", basis: "must not cross the original Task binding" }), /denied/);
    }
    const listed = await f.invoke(1, "resource.list", {}) as { resources: Array<{ resourceId: string }> };
    assert.deepEqual(new Set(listed.resources.map(r => r.resourceId)), new Set([own.resourceId, shared.resourceId]));
    assert.equal(f.db.prepare("SELECT count(*) n FROM resource_scopes").get()!.n, 0);
    assert.equal((await f.invoke(1, "resource.get", { resourceId: shared.resourceId }) as { data: string }).data,
      "synthetic bytes: shared-node");
    // Ordinary internal Node authority remains independent of a Chat inbox.
    const internal = await callCore({ port: f.configs[0]!.port, token: "synthetic-token" }, "resource.metadata",
      { resourceId: privateResources[0]!.resourceId }) as { resourceId: string };
    assert.equal(internal.resourceId, privateResources[0]!.resourceId);
  } finally { await f.close(); }
});

test("SYNTHETIC Resource publication dedupes within exact Task context and rejects mixed foreign provenance", async () => {
  const f = await fixture();
  try {
    const input = { requestId: randomUUID(), name: "same-result", sourceRef: "synthetic:same-source", dataText: "same bytes" };
    const a = { ...input, taskId: f.tasks[0]!.task.taskId }, b = { ...input, requestId: randomUUID(), taskId: f.tasks[1]!.task.taskId };
    const first = await f.invoke(0, "resource.put", a) as { resource: { resourceId: string }; replay: boolean };
    const second = await f.invoke(1, "resource.put", b) as typeof first;
    assert.notEqual(first.resource.resourceId, second.resource.resourceId);
    assert.equal(second.replay, false);
    const replay = await f.invoke(1, "resource.put", b) as typeof first;
    assert.equal(replay.resource.resourceId, second.resource.resourceId); assert.equal(replay.replay, true);
    await assert.rejects(f.invoke(1, "resource.put", a), /denied/);
    await assert.rejects(f.invoke(1, "resource.put", { ...b, requestId: randomUUID(), runId: f.tasks[0]!.run.run_id }), /denied/);
    await assert.rejects(f.invoke(1, "resource.put", { ...b, requestId: randomUUID(), artifactId: f.artifact.artifactId }), /denied/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM resources").get()!.n, 2);
  } finally { await f.close(); }
});

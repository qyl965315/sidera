import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { ChiefDispatch, type ChiefFrontend } from "../core/chief.ts";
import { recordFrontendPresence } from "../core/frontend-presence.ts";
import { recordFrontendRoute, latestFrontendRoute } from "../core/frontend-route.ts";
import { recordWorld } from "../core/worlds.ts";
import { readHistory } from "../core/history.ts";
import { chiefConversationRole } from "../core/ontology.ts";
import { ExternalMcpClientHythe } from "../hythes/external-mcp-client.ts";
import type { Hythe } from "../hythes/types.ts";
import { CoreRuntime, mockProfile } from "./fixtures/execution.ts";
import { bindChiefConversation } from "./fixtures/chief.ts";
import { issueGrant } from "./fixtures/authority.ts";

// ALL identity, Human acts, Grants, Host health and prepared return evidence here
// are SYNTHETIC fixtures. Core/SQLite/Authority/Effect/adapter calls are executed.
// No Chat UI, model, remote account, real Human approval or autonomous turn exists.
function fixture(external = false, uncertain = false) {
  const dir = mkdtempSync(join(tmpdir(), "sidera-chatfirst-contract-"));
  const file = join(dir, "fixture.sqlite"), source = join(dir, "bounded-input.txt");
  writeFileSync(source, "synthetic bounded read-only Operator work\n", "utf8");
  const db = openDatabase(file), at = new Date().toISOString();
  for (const node of ["origin", "worker"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node, `synthetic:${node}`, at);
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,'active',?)")
      .run(`${node}-session`, node, node, "fixture", `fixture://${node}/exact`, at);
  }
  const binding = bindChiefConversation(db, { kind: "human", id: "synthetic-owner" }, {
    chiefNodeId: "origin", projectSpaceId: "synthetic-project", projectRef: "synthetic-project",
    frontendKind: "fixture-protocol", conversationRef: "fixture://chat/original",
  });
  const receipts: Array<{ locator: string; messageId: string; hostRef: string; body: string }> = [];
  let received = 0;
  const worker: Hythe = {
    hytheId: "worker", hostKind: "fixture", capabilities: () => ["message.receive"],
    canStartTurn: () => true, locate: async locator => locator === "fixture://worker/exact",
    async *receive() {
      // A deterministic adapter stream, never a model/provider completion.
      while (!uncertain && received < receipts.length) {
        const receipt = receipts[received++]!;
        yield { observedMessageId: receipt.messageId, hostRef: receipt.hostRef,
          body: receipt.body, outcome: "completed" as const };
      }
    }, effectProfile: () => mockProfile,
    invoke: async (locator, operation, input, _id, boundary) => boundary!.cross(
      { product: "fixture", locator, operation }, () => {
        const messageId = (input as { messageId: string }).messageId;
        // Real bounded local work at the target adapter seam; no model claim.
        const bytes = readFileSync(source);
        const body = JSON.stringify({ synthetic: true, bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
        const hostRef = `synthetic-receipt:${messageId}`;
        receipts.push({ locator, messageId, hostRef, body });
        return uncertain ? { status: "uncertain" as const, reason: "synthetic lost response after effect" }
          : { status: "accepted" as const, hostRef };
      }),
  };
  const origin: Hythe = external ? new ExternalMcpClientHythe("origin", {
    edgeId: "synthetic-edge", locatorRef: "fixture://origin/exact",
  }) : {
    hytheId: "origin", hostKind: "fixture", capabilities: () => [],
    canStartTurn: () => false, locate: async locator => locator === "fixture://origin/exact",
    async *receive() {}, invoke: async () => { throw Error("No autonomous Chat invocation allowed"); },
  };
  const hythes = new Map([["origin", origin], ["worker", worker]]);
  const runtime = new CoreRuntime(db, hythes);
  const frontend: ChiefFrontend = {
    restore: b => latestFrontendRoute(db, { worldId: recordWorld(db, "nodes", b.chiefNodeId), bindingId: b.bindingId }),
    inspect: async () => { throw Error("No UI inspection allowed"); },
    deliver: async () => { throw Error("No Chat push allowed"); },
  };
  const chief = new ChiefDispatch(db, hythes, frontend);
  const caller = { nodeId: "origin", sessionId: "origin-session" };
  const grant = (subjectNodeId: string, capability: string, target: string) => issueGrant(db,
    { kind: "human", id: "synthetic-owner" }, { subjectNodeId, capability,
      resourceScope: `node/${target}`, projectRef: binding.projectRef, limit: 1 });
  grant("worker", "message.send", "origin");
  const prepareSyntheticReturn = () => {
    const worldId = recordWorld(db, "nodes", "origin");
    recordFrontendPresence(db, { worldId, bindingId: binding.bindingId,
      conversationRef: binding.conversationRef, evidenceClass: "ROUTE_VERIFIED",
      evidenceRef: "synthetic:exact-fixture-presence", method: "synthetic fixture only" });
    recordFrontendRoute(db, { worldId, bindingId: binding.bindingId, conversationRef: binding.conversationRef,
      candidate: { routeId: "synthetic-protocol", routeClass: "protocol", supportsSend: true, controlProfile: mockProfile },
      evidenceRef: "synthetic:prepared-route-not-delivery", method: "synthetic fixture only" });
  };
  const action = (requestId: string) => chief.action(caller, { requestId, targetNodeId: "worker",
    conversationRef: binding.conversationRef, capability: "task.dispatch", payload: { body: "Hash bounded input" } },
    () => runtime.continuations.submit({ requestId, originNodeId: "origin", originSessionId: "origin-session",
      centerNodeId: "worker", workerNodeIds: [], projectRef: binding.projectRef, body: "Hash bounded input" }));
  return { dir, file, source, db, binding, receipts, runtime, chief, caller, hythes, frontend,
    grant, prepareSyntheticReturn, action, close() { runtime.close(); if (db.isOpen) db.close();
      rmSync(dir, { recursive: true, force: true }); } };
}

test("Chat-first baseline: registered external transport and selected Chief do not imply dispatch or return", async t => {
  const f = fixture(true);
  try {
    f.grant("origin", "task.dispatch", "worker");
    assert.equal(chiefConversationRole(f.db, f.binding.projectRef)?.conversationRef, f.binding.conversationRef);
    assert.equal(f.hythes.get("origin")!.canStartTurn!(), false);
    const result = await f.action("synthetic:blocked-external");
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.durableTaskCreated, false);
    assert.ok((result.reasons as string[]).includes("CHIEF_RETURN_ROUTE_UNAVAILABLE"));
    assert.ok((result.reasons as string[]).includes("CHIEF_RUNTIME_TRANSPORT_UNAVAILABLE"));
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM task_runs").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM effect_attempt_state").get()!.n, 0);
    assert.equal(f.receipts.length, 0);
    assert.deepEqual(await f.action("synthetic:blocked-external"), JSON.parse(JSON.stringify(result)));
    t.diagnostic(JSON.stringify({ evidenceClass: "SYNTHETIC", registeredTransport: true,
      selectedChiefBinding: f.binding.bindingId, dispatch: "BLOCKED", remoteLive: "UNVERIFIED",
      fullP0: "NOT_PASSED", reasons: result.reasons }));
  } finally { f.close(); }
});

test("SYNTHETIC seam: authorized Chief action reaches exact adapter, persists result and reads it after restart", async t => {
  const f = fixture();
  try {
    f.prepareSyntheticReturn();
    const denied = await f.action("synthetic:no-grant");
    assert.equal(denied.state, "BLOCKED");
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n, 0);
    assert.equal(f.receipts.length, 0);
    f.grant("origin", "task.dispatch", "worker");
    const root = await f.action("synthetic:bounded-digest") as any;
    assert.ok(root.task.taskId);
    assert.equal(root.chiefBinding.bindingId, f.binding.bindingId);
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM task_runs").get()!.n, 1);
    assert.equal(f.receipts.length, 0, "admission is not target receipt");
    await f.runtime.continuations.pump();
    assert.equal(f.receipts.length, 1);
    const receipt = f.receipts[0]!;
    assert.equal(receipt.locator, "fixture://worker/exact");
    assert.equal(receipt.messageId, root.run.message_id);
    assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(root.task.taskId)!.state, "running");
    await assert.rejects(f.runtime.ingest("origin-session", { observedMessageId: receipt.messageId,
      hostRef: receipt.hostRef, body: receipt.body, outcome: "completed" }), /Session|session/);
    await f.runtime.receive("worker-session");
    assert.equal(f.runtime.continuations.run(root.run.run_id).state, "completed");
    assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(root.task.taskId)!.state, "completed");
    const effect = f.db.prepare(`SELECT s.attempt_id,s.state FROM effect_attempt_state s
      JOIN action_attempts a USING(attempt_id) JOIN action_runs r USING(action_id)
      WHERE r.run_id=?`).get(root.run.run_id)!;
    assert.ok(effect.attempt_id);
    assert.equal(effect.state, "completed");
    assert.ok(readHistory(f.db).some(h => JSON.stringify(h).includes(root.task.taskId)), "canonical History references this Task");
    await f.action("synthetic:bounded-digest");
    assert.equal(f.receipts.length, 1, "same request does not re-execute adapter");
    const history = readHistory(f.db);
    f.runtime.close(); f.db.close();
    const restored = openDatabase(f.file);
    try {
      // No runtime pump, UI or provider connection is needed to retrieve retained text.
      const chief = new ChiefDispatch(restored, f.hythes, {
        ...f.frontend, restore: () => null,
      });
      const status = await chief.status(f.caller, { conversationRef: f.binding.conversationRef });
      const retained = status.resultReturn.retainedResults.find(r => r.taskId === root.task.taskId)!;
      assert.ok(retained);
      assert.equal(retained.originalBindingId, f.binding.bindingId);
      assert.equal(retained.workerBody, receipt.body);
      assert.equal(retained.reviewedBody, null);
      assert.equal(JSON.parse(String(retained.workerBody)).sha256,
        createHash("sha256").update(readFileSync(f.source)).digest("hex"));
      assert.equal(status.resultReturn.mode, "authorized-ingress-read");
      assert.equal(status.resultReturn.readMarksHumanObserved, false);
      assert.equal(restored.prepare("SELECT count(*) n FROM events WHERE kind='HumanObserved'").get()!.n, 0);
      assert.equal(restored.prepare("SELECT count(*) n FROM chief_presentations").get()!.n, 0);
      assert.equal(restored.prepare("SELECT state FROM effect_attempt_state WHERE attempt_id=?").get(effect.attempt_id)!.state, "completed");
      assert.equal(restored.prepare("SELECT binding_id FROM chief_task_routes WHERE task_id=?").get(root.task.taskId)!.binding_id, f.binding.bindingId);
      assert.equal(restored.prepare("SELECT host_ref FROM messages WHERE message_id=?").get(receipt.messageId)!.host_ref, receipt.hostRef);
      const restoredHistory = readHistory(restored);
      for (const original of history) assert.deepEqual(restoredHistory.find(h => h.id === original.id), original);
      const wrong = await chief.status(f.caller, { conversationRef: "fixture://chat/wrong" });
      assert.deepEqual(wrong.resultReturn.retainedResults, []);
      assert.equal(f.receipts.length, 1);
      const replay = await chief.action(f.caller, { requestId: "synthetic:bounded-digest",
        targetNodeId: "worker", conversationRef: f.binding.conversationRef,
        capability: "task.dispatch", payload: { body: "Hash bounded input" } },
        () => { throw Error("Restarted request must return its stored result, not execute"); });
      assert.equal((replay.task as { taskId: string }).taskId, root.task.taskId);
      t.diagnostic(JSON.stringify({ evidenceClass: "SYNTHETIC", taskId: root.task.taskId,
        runId: root.run.run_id, effectAttemptId: effect.attempt_id, adapterReceipt: receipt.hostRef,
        originResult: "RETRIEVABLE_AT_CORE_SEAM", restarted: true, autonomousChat: false,
        ingress: "DIRECT_CORE_SEAM_NO_RPC", completionSource: "SYNTHETIC_ADAPTER_RECEIVE_STREAM",
        preparedReturn: "SYNTHETIC_NOT_EXERCISED", originIsolation: "SAME_PROJECT_HANDOFF_UNVERIFIED",
        remoteLive: "UNVERIFIED", fullP0: "NOT_PASSED" }));
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("Chat-first selects exact Project bindings and blocks ambiguous or unauthenticated external ingress", async t => {
  const f = fixture(true);
  try {
    const second = bindChiefConversation(f.db, { kind: "human", id: "synthetic-owner" }, {
      chiefNodeId: "origin", projectSpaceId: "synthetic-project-2", projectRef: "synthetic-project-2",
      frontendKind: "fixture-protocol", conversationRef: "fixture://chat/second",
    });
    assert.equal(chiefConversationRole(f.db, second.projectRef)?.bindingId, second.bindingId);
    assert.equal(f.chief.projects("origin").length, 2, "both canonical bindings exist");
    const selected = await f.chief.status(f.caller, { bindingId: second.bindingId, projectRef: second.projectRef });
    assert.equal(selected.binding?.bindingId, second.bindingId);
    assert.equal(selected.state, "BLOCKED", "Selecting a Project alone cannot invent transport or Authority");
    const ambiguous = await f.chief.status(f.caller);
    assert.ok(ambiguous.reasons.includes("CHIEF_SCOPE_AMBIGUOUS"));
    f.db.prepare("UPDATE sessions SET host_kind='external-mcp-client' WHERE session_id=?").run(f.caller.sessionId);
    const unscoped = await f.chief.status(f.caller, { bindingId: second.bindingId, projectRef: second.projectRef });
    assert.ok(unscoped.reasons.includes("CHIEF_INGRESS_SCOPE_UNAVAILABLE"));
    assert.equal(unscoped.binding, null, "A tool-selected binding cannot authenticate an external Chat");
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n, 0);
    assert.equal(f.receipts.length, 0);
    t.diagnostic("SYNTHETIC: exact Project selection works; omitted ambiguity and missing authenticated MCP ingress stay BLOCKED with no Task. Remote ChatGPT P0 remains UNVERIFIED.");
  } finally { f.close(); }
});

test("SYNTHETIC uncertain adapter receipt survives restart without replay", async () => {
  const f = fixture(false, true);
  try {
    f.prepareSyntheticReturn(); f.grant("origin", "task.dispatch", "worker");
    const root = await f.action("synthetic:uncertain") as any;
    await f.runtime.continuations.pump();
    assert.equal(f.receipts.length, 1);
    assert.equal(f.runtime.continuations.run(root.run.run_id).state, "uncertain");
    f.runtime.close(); f.db.close();
    const restored = openDatabase(f.file), runtime = new CoreRuntime(restored, f.hythes);
    try {
      await runtime.continuations.pump();
      assert.equal(runtime.continuations.run(root.run.run_id).state, "uncertain");
      assert.equal(f.receipts.length, 1);
      assert.equal(restored.prepare("SELECT count(*) n FROM messages WHERE kind='result'").get()!.n, 0);
    } finally { runtime.close(); restored.close(); }
  } finally { f.close(); }
});

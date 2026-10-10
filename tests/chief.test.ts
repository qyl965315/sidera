import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { recordFrontendPresence } from "../core/frontend-presence.ts";
import { recordFrontendRoute, latestFrontendRoute } from "../core/frontend-route.ts";
import { recordWorld } from "../core/worlds.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { bindChiefConversation, handoffChiefConversation, ChiefDispatch, type ChiefFrontend } from "./fixtures/chief.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { mockProfile } from "./fixtures/execution.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { callCore } from "../hythes/core-client.ts";
import { getMessage } from "./fixtures/bus.ts";
import type { Hythe } from "../hythes/types.ts";

function fixture(file = ":memory:") {
  const db = openDatabase(file), at = new Date().toISOString();
  for (const node of ["chief", "supervisor", "astra"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)").run(node, node, at);
    db.prepare("INSERT INTO sessions VALUES (?, ?, 'fixture', 'test', ?, 'active', ?)")
      .run(`${node}-session`, node, `${node}-runtime`, at);
  }
  db.prepare("INSERT INTO role_appointments VALUES ('role','chief','ChiefSupervisor','project',NULL,NULL,?)").run(at);
  const binding = bindChiefConversation(db, { kind: "human", id: "fixture" }, {
    projectSpaceId: "project", projectRef: "D:/test-project", chiefNodeId: "chief",
    frontendKind: "chatgpt-web", conversationRef: "https://chatgpt.com/c/original-chief",
  });
  // Readiness comes from durable Presence evidence; the frontend is never
  // consulted for readiness, only for actual delivery.
  const setPresence = (live: boolean) => recordFrontendPresence(db, {
    worldId: recordWorld(db, "nodes", binding.chiefNodeId), bindingId: binding.bindingId,
    conversationRef: binding.conversationRef, evidenceClass: "ROUTE_VERIFIED",
    evidenceRef: `fixture:${live ? "live" : "expired"}`, method: "fixture route evidence",
    ttlMs: live ? 60 * 60_000 : -1 });
  setPresence(true);
  // A declared outbound route must be PREPARED before it can carry a governed
  // send. This is durable evidence, not an in-memory flag, so it survives a
  // restart exactly like the presence observation above.
  recordFrontendRoute(db, { worldId: recordWorld(db, "nodes", binding.chiefNodeId),
    bindingId: binding.bindingId, conversationRef: binding.conversationRef,
    candidate: { routeId: "fixture-native", routeClass: "native", supportsSend: true, controlProfile: mockProfile },
    evidenceRef: "fixture:declared-route", method: "fixture route preparation" });
  // Mutable so a test can withdraw the final-send profile and prove dispatch is
  // refused rather than silently downgraded to another backend.
  let routeProfile: any = mockProfile;
  const routeState = (b: { chiefNodeId: string; bindingId: string }) => routeProfile
    ? latestFrontendRoute(db, { worldId: recordWorld(db, "nodes", b.chiefNodeId), bindingId: b.bindingId })
    : { state: "USABLE", routeId: "fixture-native", routeClass: "native", controlProfile: null,
        preparedAt: new Date().toISOString(), invalidAfter: new Date(Date.now() + 600_000).toISOString(),
        evidenceRef: "fixture:profile-withdrawn", method: "fixture" };
  const calls: any[] = [], presentations: any[] = [];
  let ready = true, uncertain = false;
  const frontend: ChiefFrontend = {
    effectProfile:()=>mockProfile, restore: routeState,
    inspect: async () => ({ ready, reason: ready ? "exact" : "Host unavailable" }),
    deliver: async (bound, message,boundary) => boundary!.cross({product:bound.frontendKind,locator:bound.conversationRef,operation:"conversation.send"},()=>{ presentations.push({ bound, message });
      return uncertain ? { status: "uncertain" as const, reason: "after possible Host effect" } : { status: "accepted" as const, hostRef: "frontend-turn" }; }),
  };
  const hythe: Hythe = { hytheId: "fixture", hostKind: "test", capabilities: () => ["message.receive"],
    canStartTurn: () => true, locate: async () => true, async *receive() {},
    invoke: async (locator, _capability, input) => { calls.push({ locator, input });
      return { status: "accepted", hostRef: `turn-${calls.length}` }; },
  };
  const hythes = new Map([["fixture", hythe]]), runtime = new CoreRuntime(db, hythes);
  const chief = new ChiefDispatch(db, hythes, frontend);
  runtime.continuations.presentRootResult = messageId => chief.present(messageId);
  runtime.reviewRootResult=(id,session,host,body)=>chief.review(id,session,host,body);
  const caller = { nodeId: "chief", sessionId: "chief-session" };
  const grant = (node: string, target: string, capability: string) => issueGrant(db, { kind: "human", id: "fixture" },
    { subjectNodeId: node, capability, resourceScope: `node/${target}` });
  const action = (requestId: string) => chief.action(caller, { requestId, targetNodeId: "supervisor",
    capability: "task.dispatch", conversationRef: binding.conversationRef, payload: { body: "继续 Sidera 收口。" } },
    () => runtime.continuations.submit({ requestId, originNodeId: "chief", originSessionId: "chief-session",
      centerNodeId: "supervisor", workerNodeIds: [], body: "继续 Sidera 收口。" }));
  const finish = async (runId: string, body: string) => {
    const run = runtime.continuations.run(runId), message = getMessage(db, run.message_id);
    await runtime.ingest(run.session_id, { hostRef: message.hostRef!, observedMessageId: message.messageId, body, outcome: "completed" });
  };
  return { db, binding, chief, caller, frontend, hythes, runtime, calls, presentations, grant, action, finish,
    unavailable: () => { ready = false; setPresence(false); }, available: () => { ready = true; setPresence(true); }, uncertain: () => { uncertain = true; },
    withdrawProfile: () => { routeProfile = null; } };
}

test("Chief blocks before Task/Responsibility, reports state, dedupes and hides Runtime Sessions", async () => {
  const f = fixture();
  const rpc = new CoreRpcServer(f.db, f.runtime, f.hythes, {
    authenticate: token => token === "chief-token" ? { kind: "node", ...f.caller } : null,
  }, undefined, undefined, f.chief);
  try {
    f.grant("chief", "supervisor", "task.dispatch"); f.grant("chief", "supervisor", "responsibility.create");
    f.grant("supervisor","chief","message.send");
    assert.throws(() => bindChiefConversation(f.db, { kind: "node" }, { ...f.binding }), { code: "denied" });
    assert.throws(() => bindChiefConversation(f.db, { kind: "human" }, {
      ...f.binding, conversationRef: "https://chatgpt.com/c/new-report" }), { code: "conflict" });
    const port = await rpc.listen(0), core = { port, token: "chief-token" };
    f.unavailable();
    const blocked = await callCore(core, "task.submit", { requestId: "blocked", centerNodeId: "supervisor", body: "继续 Sidera 收口。" }) as any;
    assert.equal(blocked.state, "BLOCKED"); assert.equal(blocked.humanRelayRequired, false);
    assert.equal(blocked.durableTaskCreated, false); assert.ok(blocked.reasons.includes("CHIEF_RETURN_TRANSPORT_UNAVAILABLE"));
    const responsibility = await callCore(core, "responsibility.create", {
      requestId: "blocked-responsibility", ownerNodeId: "supervisor", title: "Close", scope: "project" }) as any;
    assert.equal(responsibility.state, "BLOCKED");
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM responsibilities").get()?.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM grant_uses").get()?.n, 0); assert.equal(f.calls.length, 0);
    f.available();
    // Recovery never implicitly replays a previously blocked intent.
    assert.deepEqual(await callCore(core, "task.submit", { requestId: "blocked", centerNodeId: "supervisor", body: "继续 Sidera 收口。" }), blocked);
    const mismatch = await f.chief.status(f.caller, { targetNodeId: "supervisor", conversationRef: "https://chatgpt.com/c/wrong" });
    assert.equal(mismatch.available, false); assert.ok(mismatch.reasons.includes("CHIEF_CONVERSATION_MISMATCH"));
    assert.equal((await f.chief.status(f.caller, { targetNodeId: "astra" })).available, false); // no Grant
    // Stronger property than before: readiness is a pure read of durable
    // Presence evidence, so the frontend is never consulted at all. A frontend
    // whose inspect/deliver hang forever must therefore be unable to stall or
    // block a status query - which proves status() constructs no UI backend.
    const stalled = new ChiefDispatch(f.db, f.hythes, { ...f.frontend,
      inspect: () => new Promise(() => {}), deliver: () => new Promise(() => {}) }, 5);
    assert.equal((await stalled.status(f.caller, { targetNodeId: "supervisor" })).available, true);
    const projects = await callCore(core, "project.list", {}) as any[];
    assert.equal(projects.length, 1); assert.equal(projects[0].conversationRef, f.binding.conversationRef);
    assert.equal(JSON.stringify(projects).includes("runtime"), false); assert.equal(JSON.stringify(projects).includes("session"), false);
    const accepted = await callCore(core, "task.submit", { requestId: "fresh", centerNodeId: "supervisor", body: "继续 Sidera 收口。" }) as any;
    assert.ok(accepted.task.taskId); assert.equal(accepted.chiefBinding.bindingId, f.binding.bindingId);
    await f.runtime.continuations.pump(); assert.equal(f.calls.length, 1);
    f.unavailable();
    const legacy=await callCore(core,"task.dispatch",{requestId:"legacy-bypass",centerNodeId:"supervisor",body:"bypass"}) as any;
    assert.equal(legacy.state,"BLOCKED");assert.equal(legacy.durableTaskCreated,false);
  } finally { await rpc.close(); f.db.close(); }
});

test("Chief cannot advertise dispatch when a live return frontend lacks the final-send control profile", async () => {
  const f = fixture();
  try {
    f.grant("chief", "supervisor", "task.dispatch");
    // The final-send profile now lives on the prepared ROUTE, not on the frontend
    // object. Withdrawing it must refuse dispatch, not downgrade to another route.
    f.withdrawProfile();
    const chief = new ChiefDispatch(f.db, f.hythes, f.frontend);
    const status = await chief.status(f.caller, { targetNodeId: "supervisor" });
    assert.equal(status.transport.frontend.ready, true);
    assert.equal(status.available, false);
    assert.ok(status.reasons.includes("CHIEF_RETURN_CONTROL_PROFILE_UNAVAILABLE"));
    let admitted = false;
    const result = await chief.action(f.caller, { requestId: "no-return-profile", targetNodeId: "supervisor",
      capability: "task.dispatch", payload: { body: "fixture" } }, () => { admitted = true; return {}; });
    assert.equal(result.state, "BLOCKED");
    assert.equal(admitted, false);
  } finally { f.runtime.close(); f.db.close(); }
});

test("Chief → Supervisor → Astra follows an explicit Human handoff, persists provenance and never resends uncertain presentation", async () => {
  const base = join(process.cwd(), ".sidera-dev", "sol", "temp"); mkdirSync(base, { recursive: true });
  const file = join(mkdtempSync(join(base, "chief-")), "test.sqlite"), f = fixture(file);
  try {
    for (const [from, to, cap] of [["chief","supervisor","task.dispatch"], ["supervisor","astra","task.dispatch"],
      ["astra","supervisor","message.send"], ["supervisor","chief","message.send"]]) f.grant(from!,to!,cap!);
    const root = await f.action("root") as any;
    const replacement = { requestId: "human-new-chat", expectedBindingId: f.binding.bindingId,
      conversationRef: "https://chatgpt.com/c/human-selected-replacement" };
    assert.throws(() => handoffChiefConversation(f.db, { kind: "node" }, replacement), { code: "denied" });
    const newBinding = handoffChiefConversation(f.db, { kind: "human", id: "fixture" }, replacement);
    assert.notEqual(newBinding.bindingId, f.binding.bindingId);
    assert.deepEqual(handoffChiefConversation(f.db, { kind: "human", id: "fixture" }, replacement), newBinding);
    assert.equal(f.chief.binding("chief")?.bindingId, newBinding.bindingId);
    assert.equal(latestFrontendRoute(f.db,{worldId:recordWorld(f.db,"nodes","chief"),bindingId:newBinding.bindingId}).state,"UNKNOWN");
    recordFrontendPresence(f.db,{worldId:recordWorld(f.db,"nodes","chief"),bindingId:newBinding.bindingId,conversationRef:newBinding.conversationRef,evidenceClass:"ROUTE_VERIFIED",evidenceRef:"fixture:new exact authenticated inbound",method:"fixture"});
    recordFrontendRoute(f.db,{worldId:recordWorld(f.db,"nodes","chief"),bindingId:newBinding.bindingId,conversationRef:newBinding.conversationRef,candidate:{routeId:"fixture-native",routeClass:"native",supportsSend:true,controlProfile:mockProfile},evidenceRef:"fixture:new exact route",method:"fixture"});
    await f.runtime.continuations.pump();
    const child = f.runtime.continuations.submit({ requestId: "child", originNodeId: "supervisor",
      originSessionId: "supervisor-session", centerNodeId: "astra", workerNodeIds: [], body: "independent contribution" },
      { runId: root.run.run_id, checkpoint: "WAIT" });
    await f.runtime.continuations.pump(); await f.finish(root.run.run_id, "WAIT");
    await f.finish(child.run.run_id, "verified contribution");
    const resumed = f.calls.at(-1)!.input; assert.equal(resumed.taskId, root.task.taskId);
    f.uncertain(); await f.finish(resumed.runId, "Closure evidence");
    assert.equal(f.presentations.length, 0); // Worker result must first wake the Chief review turn.
    const chiefResult=getMessage(f.db,String(f.db.prepare("SELECT message_id FROM messages WHERE task_id=? AND kind='result'").get(root.task.taskId)!.message_id));
    await f.runtime.ingest("chief-session",{observedMessageId:chiefResult.messageId,hostRef:chiefResult.hostRef!,body:"Chief reviewed closure evidence",outcome:"completed"});
    assert.equal(f.presentations.length, 1); assert.equal(f.presentations[0].bound.conversationRef, newBinding.conversationRef);
    const result = f.db.prepare("SELECT message_id FROM messages WHERE task_id=? AND kind='result'").get(root.task.taskId)!;
    assert.equal(f.db.prepare("SELECT state FROM chief_presentations WHERE message_id=?").get(result.message_id)?.state, "uncertain");
    await f.chief.present(String(result.message_id)); assert.equal(f.presentations.length, 1);
    assert.equal(f.calls.at(-1)!.locator, "chief-runtime"); // Internal return remains distinct.
    f.db.close(); const restored = openDatabase(file);
    try {
      const chief = new ChiefDispatch(restored, f.hythes, f.frontend);
      assert.equal(chief.binding("chief")?.bindingId, newBinding.bindingId);
      await chief.present(String(result.message_id)); assert.equal(f.presentations.length, 1);
      assert.equal(restored.prepare("SELECT state FROM tasks WHERE task_id=?").get(root.task.taskId)?.state, "completed");
    } finally { restored.close(); }
  } finally { if (f.db.isOpen) f.db.close(); }
});

test("A1: a fresh transport poll alone never verifies the exact return path", async () => {
  const f = fixture();
  try {
    f.grant("chief", "supervisor", "task.dispatch");
    f.unavailable(); // Expire earlier verified evidence; a poll cannot renew it.
    // Make transport evidence the NEWEST observation: the tunnel genuinely
    // answered, so the observation is LIVE. It still proves nothing about
    // whether the exact Human Chat can be reached for a return.
    recordFrontendPresence(f.db, { worldId: recordWorld(f.db, "nodes", "chief"),
      bindingId: f.binding.bindingId, conversationRef: f.binding.conversationRef,
      evidenceClass: "TRANSPORT_POLL", evidenceRef: "fixture:tunnel-poll",
      method: "fixture tunnel poll", observedAt: new Date(Date.now() + 1000).toISOString() });
    const status = await f.chief.status(f.caller, { targetNodeId: "supervisor" });
    assert.equal(status.transport.health?.state, "LIVE",
      "transport health must be genuinely fresh here, or the test proves nothing");
    assert.equal(status.transport.frontend.ready, false,
      "a fresh transport poll must not read as a verified exact return path");
    assert.ok(status.reasons.includes("CHIEF_RETURN_TRANSPORT_UNAVAILABLE"));
    assert.equal(status.available, false, "dispatch must stay blocked on unverified presence");
  } finally { f.db.close(); }
});

test("A2: a prepared route is required, and route evidence is not delivery evidence", async () => {
  const f = fixture();
  try {
    f.grant("chief", "supervisor", "task.dispatch");
    // The return Authority is a separate grant on the executing Node; without it
    // the mesh correctly reports no available authorized node.
    f.grant("supervisor", "chief", "message.send");
    const status = await f.chief.status(f.caller, { targetNodeId: "supervisor" });
    // Prepared route says a governed send is POSSIBLE; it must not be reported
    // as a delivery that already happened.
    assert.equal(status.transport.route.state, "USABLE");
    assert.ok(status.transport.route.controlProfileId);
    assert.equal(status.boundary.egress.state, "not_attempted",
      "no message has been sent, so delivery must be not_attempted");
    assert.equal(status.available, true);
  } finally { f.db.close(); }
});

test("retained root results are readable on authorized ingress without egress or observation", async () => {
  const f = fixture();
  try {
    f.grant("chief", "supervisor", "task.dispatch");
    f.grant("supervisor", "chief", "message.send");
    const root = await f.action("retained-result") as any;
    await f.runtime.continuations.pump();
    await f.finish(root.run.run_id, "Worker closure evidence");
    f.unavailable();
    const before = f.calls.length;
    const status = await f.chief.status(f.caller, { conversationRef: f.binding.conversationRef });
    assert.equal(status.resultReturn.mode, "authorized-ingress-read");
    const result = status.resultReturn.retainedResults[0] as any;
    assert.equal(result.taskId, root.task.taskId);
    assert.equal(result.workerBody, "Worker closure evidence");
    assert.equal(result.reviewedBody, null);
    assert.equal(result.originalBindingId, f.binding.bindingId);
    assert.equal(f.calls.length, before);
    assert.equal(f.presentations.length, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='HumanObserved'").get()?.n, 0);
    assert.deepEqual((await f.chief.status(f.caller, { conversationRef: "https://chatgpt.com/c/another" })).resultReturn.retainedResults, []);
    assert.deepEqual((await f.chief.status({ ...f.caller, sessionId: "wrong" })).resultReturn.retainedResults, []);
  } finally { f.runtime.close(); f.db.close(); }
});

test("Chief discovery uses canonical Project scope instead of its Console space alias",async()=>{
 const f=fixture();try{
  for(const [node,target,capability] of [["chief","supervisor","task.dispatch"],["chief","supervisor","responsibility.create"],["supervisor","chief","message.send"]])
   issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:node!,capability:capability!,resourceScope:"node/"+target,projectRef:f.binding.projectRef});
  const status=await f.chief.status(f.caller,{targetNodeId:"supervisor"});
  assert.equal(status.available,true);
  assert.equal(status.binding?.projectRef,"D:/test-project");
 }finally{f.runtime.close();f.chief.close();f.db.close();}
});

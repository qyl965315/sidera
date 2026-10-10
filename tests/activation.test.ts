import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../core/db.ts";
import { createWorld, recordWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { ActivationController, evaluateActivation, humanRootedFor, type ActivationInput } from "../core/activation.ts";
import { openHumanIngress, admitHumanAct, recordInterpretation, explicitHumanStatement, canonical } from "../core/human-admission.ts";
import { createHash } from "node:crypto";
import { issueGrant, revokeGrant } from "./fixtures/authority.ts";
import { getGrant } from "../core/authority.ts";
import { CoreRuntime, mockProfile } from "./fixtures/execution.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { ChiefDispatch } from "../core/chief.ts";
import { recordFrontendPresence, latestFrontendPresence } from "../core/frontend-presence.ts";
import { observationFreshness } from "../core/activation.ts";
import { recordFrontendRoute, latestFrontendRoute } from "../core/frontend-route.ts";
import { callCore } from "../hythes/core-client.ts";
import type { Hythe } from "../hythes/types.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";

/**
 * Runtime Activation is derived from durable facts plus live Presence
 * observations. These tests pin the falsification direction: missing or stale
 * facts must block, and there is no input that turns activation on by itself.
 */
function fixture(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => { if (db.isOpen) db.close(); });
  const world = createWorld(db, "Activation fixture World", "activation fixture only");
  const store = new SemanticStore(db, world);
  const human = store.createHuman("Fixture Human", "activation fixture principal");
  const chief = store.registerNode("Chief");
  const target = store.registerNode("Target");
  const chiefSession = `${chief}-session`, targetSession = `${target}-session`;
  db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(chiefSession, chief, `mock://${chief}`);
  db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(targetSession, target, `mock://${target}`);
  db.prepare(`INSERT INTO chief_conversations VALUES (?,?,?,?,?,?,?,?)`)
    .run("binding-fixture", "sidera-r1", "fixture-project", chief, "chatgpt-web", "https://chatgpt.com/c/fixture", "active", "now");
  // Durable route evidence, not a live probe: the Chief must never open the
  // frontend in order to decide whether it may present a result.
  recordFrontendRoute(db, { worldId: world, bindingId: "binding-fixture",
    conversationRef: "https://chatgpt.com/c/fixture",
    candidate: { routeId: "fixture-native", routeClass: "native", supportsSend: true, controlProfile: mockProfile },
    evidenceRef: "fixture:declared-route", method: "fixture route preparation" });
  recordFrontendPresence(db, { worldId: world, bindingId: "binding-fixture",
    conversationRef: "https://chatgpt.com/c/fixture", evidenceClass: "ROUTE_VERIFIED",
    evidenceRef: "fixture:route-verified", method: "fixture route evidence" });  const source = { sourceId: randomUUID() };
  db.prepare("INSERT INTO human_frontend_sources VALUES (?,?,?,?,?,1)")
    .run(source.sourceId, world, human, "fixture:chief-chat", "fixture:human-frontend");
  const grant = issueGrant(db, { kind: "human", id: human }, { subjectNodeId: chief,
    capability: "task.dispatch", resourceScope: `node/${target}` });
  const returnGrant=issueGrant(db,{kind:"human",id:human},{subjectNodeId:target,capability:"message.send",resourceScope:`node/${chief}`});
  const input = (over: Partial<ActivationInput> = {}): ActivationInput => ({
    worldId: world, chiefNodeId: chief, chiefSessionId: chiefSession,
    live: { frontendPresence: "LIVE", chiefRuntimePresence: "LIVE",
      targetPresence: { [target]: "LIVE" }, effectProfiles: { [target]: "fixture:controlled-send" },
      frontendEffectProfile: "fixture:controlled-return" },
    required: [{ capability: "task.dispatch", resource: `node/${target}` }],
    ...over,
  });
  return { db, world, store, human, chief, target, chiefSession, targetSession, grant,returnGrant, source, input };
}
test("Dispatch activation requires an admitted reverse result Grant, not a legacy grant-shaped row",t=>{
 const f=fixture(t);revokeGrant(f.db,{kind:"human",id:f.human},{requestId:randomUUID(),grantId:f.returnGrant.grantId});
 f.db.prepare("INSERT INTO grants(grant_id,subject_node_id,capability,resource_scope,issuer,delegable) VALUES ('legacy-return',?,'message.send',?,'human:old',0)").run(f.target,`node/${f.chief}`);
 const decision=evaluateActivation(f.db,f.input());assert.equal(decision.ready,false);assert.ok(decision.reasons.includes("RETURN_AUTHORITY"));
 assert.deepEqual(decision.detail.deniedReturnTargets,[f.target]);
});

test("Declared profiles do not make the final gate evaluable without exact account bindings",t=>{
 const f=fixture(t);const live={...f.input().live,effectIdentityRequired:{[f.target]:true},frontendIdentityRequired:true};
 const decision=evaluateActivation(f.db,f.input({live}));
 assert.equal(decision.prerequisites.EFFECT_CONTROL_PROFILE,"satisfied");
 assert.equal(decision.prerequisites.EFFECT_GATE_EVALUABLE,"unsatisfied");
 assert.deepEqual(decision.detail.missingExternalIdentities,[f.target]);assert.equal(decision.detail.frontendIdentityKnown,false);
});

test("Target Presence is required only for the operation scope; incomplete mesh remains explicit", t => {
  const f = fixture(t), other = f.store.registerNode("Unavailable unrelated worker");
  const live = { ...f.input().live, targetPresence: { [f.target]: "LIVE" as const, [other]: "UNAVAILABLE" as const } };
  const decision = evaluateActivation(f.db, f.input({ live }));
  assert.equal(decision.ready, true);
  assert.deepEqual(decision.detail.mesh, { complete: false, condition: "MESH_INCOMPLETE",
    targetPresence: live.targetPresence, unavailableTargets: [other] });
  const selected = evaluateActivation(f.db, f.input({ live,
    required: [{ capability: "task.dispatch", resource: `node/${other}` }] }));
  assert.ok(selected.reasons.includes("TARGET_PRESENCE"));
  assert.ok(selected.reasons.includes("HUMAN_ROOTED_AUTHORITY"));
  const missing = evaluateActivation(f.db, f.input({ live,
    required: [{ capability: "task.dispatch", resource: "node/nonexistent" }] }));
  assert.ok(missing.reasons.includes("TARGET_NODE_IDENTITY"));
  assert.ok(missing.reasons.includes("TARGET_PRESENCE"));
});

test("Scoped activation rechecks durable authority within a current observation", async t => {
  const f = fixture(t), controller = new ActivationController(f.db, {
    base: () => ({ ...f.input(), required: [] }), probe: async () => f.input().live,
  });
  await controller.refresh();
  assert.equal(controller.decision(f.input().required).ready, true);
  revokeGrant(f.db, { kind: "human", id: f.human }, { requestId: randomUUID(), grantId: f.grant.grantId });
  assert.ok(controller.decision(f.input().required).reasons.includes("HUMAN_ROOTED_AUTHORITY"));
  controller.invalidate();
  assert.equal(controller.decision(f.input().required).ready, false);
  assert.deepEqual(controller.decision().reasons, ["RUNTIME_OBSERVATION_NOT_TAKEN"]);
});

test("A failed fresh probe withdraws a previously ready observation immediately", async t => {
  const f = fixture(t);
  let fail = false;
  const controller = new ActivationController(f.db, { base: () => f.input(), probe: async () => {
    if (fail) throw new Error("fixture transport lost");
    return f.input().live;
  } });
  assert.equal((await controller.refresh()).ready, true);
  fail = true;
  assert.deepEqual((await controller.refresh()).reasons, ["RUNTIME_OBSERVATION_FAILED"]);
  assert.equal(controller.decision().ready, false);
  assert.equal(controller.observedAt(), null);
});

test("RPC admits a selected LIVE target despite incomplete mesh and blocks an unavailable selected target", async t => {
  const f = fixture(t), other = f.store.registerNode("Unavailable worker");
  f.db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(`${other}-session`, other, `mock://${other}`);
  issueGrant(f.db, { kind: "human", id: f.human }, { subjectNodeId: f.chief,
    capability: "task.dispatch", resourceScope: `node/${other}` });
  issueGrant(f.db, { kind: "human", id: f.human }, { subjectNodeId: f.chief,
    capability: "self.*", resourceScope: `node/${f.chief}/**` });
  const live = { ...f.input().live, targetPresence: { [f.chief]: "LIVE" as const, [f.target]: "LIVE" as const, [other]: "UNAVAILABLE" as const },
    effectProfiles: { [f.chief]: mockProfile.id, [f.target]: mockProfile.id, [other]: mockProfile.id } };
  const activation = new ActivationController(f.db, { base: () => ({ ...f.input(),
    required: [{ capability: "self.*", resource: `node/${f.chief}/**` }] }), probe: async () => live });
  const hythe: Hythe = { hytheId: "mock", hostKind: "mock", capabilities: () => ["message.receive"],
    locate: async locator => locator !== `mock://${other}`, async *receive() {},
    invoke: async () => ({ status: "accepted", hostRef: "fixture-accepted" }) };
  const hythes = new Map([[hythe.hytheId, hythe]]), runtime = new CoreRuntime(f.db, hythes, undefined, { activation });
  const chief = new ChiefDispatch(f.db, hythes, { effectProfile: () => mockProfile,
    restore: (b: { chiefNodeId: string; bindingId: string }) => latestFrontendRoute(f.db, { worldId: recordWorld(f.db, "nodes", b.chiefNodeId), bindingId: b.bindingId }),
    inspect: async () => ({ ready: true, reason: "fixture" }),
    deliver: async () => ({ status: "rejected", reason: "not used" }) });
  const rpc = new CoreRpcServer(f.db, runtime, hythes, { authenticate: () => ({ kind: "node", nodeId: f.chief, sessionId: f.chiefSession }) }, undefined, undefined, chief);
  try {
    const core = { port: await rpc.listen(), token: "fixture" };
    await activation.refresh(); // Explicit startup observation; status remains read-only.
    const status = await callCore(core, "chief.status", { targetNodeId: f.target }) as { available: boolean; mesh: { complete: boolean } };
    assert.equal(status.available, true);
    assert.equal(status.mesh.complete, false);
    activation.invalidate();
    const current=await callCore(core,"chief.status",{targetNodeId:f.target}) as {available:boolean;aggregateObservation:{reasons:string[]}};
    assert.equal(current.available,true,"Fresh participant admission must agree with actual dispatch despite an old aggregate cache");
    assert.deepEqual(current.aggregateObservation.reasons,["RUNTIME_OBSERVATION_NOT_TAKEN"]);
    await activation.refresh();
    await assert.rejects(callCore(core, "chief.dispatch", { requestId: "unavailable", centerNodeId: other, body: "fixture" }), /TARGET_PRESENCE/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tasks").get()?.n, 0);
    const result = await callCore(core, "chief.dispatch", { requestId: "live", centerNodeId: f.target, body: "fixture" }) as { task?: { taskId: string } };
    assert.ok(result.task?.taskId);
  } finally { await rpc.close(); runtime.close(); }
});

test("RA-T01 Observation-only cannot exit if the applicable World is missing", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input({ worldId: randomUUID() }));
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.WORLD_APPLICABLE, "unsatisfied");
  assert.ok(decision.reasons.includes("WORLD_APPLICABLE"));
});

test("RA-T02 Cannot exit with stale Human frontend Presence", t => {
  const f = fixture(t);
  for (const stale of ["LAST_KNOWN", "UNAVAILABLE"] as const) {
    const decision = evaluateActivation(f.db, f.input({ live: { ...f.input().live, frontendPresence: stale } }));
    assert.equal(decision.ready, false, `${stale} must not activate`);
    assert.equal(decision.prerequisites.HUMAN_FRONTEND_PRESENCE, "unsatisfied");
    assert.equal(decision.prerequisites.RETURN_ROUTE, "unsatisfied");
  }
  assert.equal(evaluateActivation(f.db, f.input()).ready, true);
});

test("RA-T03 Cannot exit with invalid Chief runtime Presence", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input({ live: { ...f.input().live, chiefRuntimePresence: "UNAVAILABLE" } }));
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.CHIEF_RUNTIME_PRESENCE, "unsatisfied");
});

test("RA-T04 Cannot exit with only legacy invalid Authority", t => {
  const f = fixture(t);
  const now = new Date().toISOString();
  // A pre-M2 "Human-looking" grant with no admitted Human act and no provenance.
  f.db.prepare(`INSERT INTO grants(grant_id,subject_node_id,capability,resource_scope,issuer,delegable,parent_grant_id)
    VALUES (?,?,?,?,?,0,NULL)`).run("legacy-grant", f.chief, "task.dispatch", `node/${f.target}`, "human:legacy-project-manager");
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM grant_provenance WHERE grant_id='legacy-grant'").get() as { n: number }).n, 0);
  assert.equal(humanRootedFor(f.db, f.chief, f.world, { capability: "task.dispatch", resource: `node/${f.target}` }), true,
    "the admitted grant is the only Human-rooted basis");
  // Remove the valid grant: the legacy one must not take its place.
  f.db.prepare("UPDATE grants SET revoked_at=? WHERE grant_id=?").run(now, f.grant.grantId);
  const decision = evaluateActivation(f.db, f.input());
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.HUMAN_ROOTED_AUTHORITY, "unsatisfied");
});

test("RA-T05 Cannot exit if the M2 Effect/control profile is unavailable where required", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input({ live: { ...f.input().live, effectProfiles: {} } }));
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.EFFECT_CONTROL_PROFILE, "unsatisfied");
  assert.equal(decision.prerequisites.EFFECT_GATE_EVALUABLE, "unsatisfied");
});

test("A live Human frontend without a final-send profile cannot activate", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input({ live: { ...f.input().live, frontendEffectProfile: null } }));
  assert.equal(decision.prerequisites.HUMAN_FRONTEND_PRESENCE, "satisfied");
  assert.ok(decision.reasons.includes("EFFECT_CONTROL_PROFILE"));
  assert.ok(decision.reasons.includes("EFFECT_GATE_EVALUABLE"));
});

test("RA-T06 Valid current facts derive active readiness", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input());
  assert.equal(decision.ready, true);
  assert.equal(decision.mode, "active");
  assert.deepEqual(decision.reasons, []);
  for (const [name, state] of Object.entries(decision.prerequisites))
    assert.equal(state, "satisfied", `${name} should be satisfied`);
});

test("RA-T07 Losing a readiness prerequisite re-blocks operation", t => {
  const f = fixture(t);
  assert.equal(evaluateActivation(f.db, f.input()).ready, true);
  const broke = (expect: string) => {
    const decision = evaluateActivation(f.db, f.input());
    assert.equal(decision.ready, false);
    assert.ok(decision.reasons.includes(expect), `expected ${expect}, saw ${decision.reasons.join(",")}`);
  };
  const ready = () => assert.equal(evaluateActivation(f.db, f.input()).ready, true);

  // Restorable facts must round-trip both directions.
  f.db.prepare("UPDATE human_frontend_sources SET active=0").run();
  broke("HUMAN_FRONTEND_PRESENCE");
  f.db.prepare("UPDATE human_frontend_sources SET active=1").run();
  ready();

  f.db.prepare("UPDATE sessions SET state='retired' WHERE session_id=?").run(f.chiefSession);
  broke("CHIEF_CONVERSATION_IDENTITY");
  f.db.prepare("UPDATE sessions SET state='active' WHERE session_id=?").run(f.chiefSession);
  ready();

  f.db.prepare("UPDATE chief_conversations SET state='retired'").run();
  broke("HUMAN_FRONTEND_BINDING");
  f.db.prepare("UPDATE chief_conversations SET state='active'").run();
  ready();

  // Irreversible fact: an admitted Human revocation permanently re-blocks.
  const g = fixture(t);
  assert.equal(evaluateActivation(g.db, g.input()).ready, true);
  revokeGrant(g.db, { kind: "human", id: g.human }, { requestId: randomUUID(), grantId: g.grant.grantId });
  const decision = evaluateActivation(g.db, g.input());
  assert.equal(decision.ready, false);
  assert.ok(decision.reasons.includes("HUMAN_ROOTED_AUTHORITY"));
  // M2 forbids clearing a revocation: it is append-only history, not a toggle.
  assert.throws(() => g.db.prepare("UPDATE grants SET revoked_at=NULL WHERE grant_id=?").run(g.grant.grantId),
    { errstr: "constraint failed" });
});
test("RA-T08 lastKnown Presence alone is insufficient", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input({
    live: { frontendPresence: "LAST_KNOWN", chiefRuntimePresence: "LAST_KNOWN",
      targetPresence: { [f.target]: "LAST_KNOWN" }, effectProfiles: { [f.target]: "fixture:controlled-send" } },
  }));
  assert.equal(decision.ready, false);
  assert.ok(decision.reasons.includes("HUMAN_FRONTEND_PRESENCE"));
  assert.ok(decision.reasons.includes("CHIEF_RUNTIME_PRESENCE"));
  assert.ok(decision.reasons.includes("TARGET_PRESENCE"));
});

test("RA-T09 Human-rooted bounded grant becomes valid only for the exact scope", t => {
  const f = fixture(t);
  const other = f.store.registerNode("Other");
  f.db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(`${other}-session`, other, `mock://${other}`);
  assert.equal(humanRootedFor(f.db, f.chief, f.world, { capability: "task.dispatch", resource: `node/${f.target}` }), true);
  assert.equal(humanRootedFor(f.db, f.chief, f.world, { capability: "task.dispatch", resource: `node/${other}` }), false,
    "a grant for one target must not cover another");
  assert.equal(humanRootedFor(f.db, f.chief, f.world, { capability: "message.send", resource: `node/${f.target}` }), false,
    "a grant for one capability must not cover another");
  const decision = evaluateActivation(f.db, f.input({
    required: [{ capability: "task.dispatch", resource: `node/${other}` }],
    live: { ...f.input().live, targetPresence: { [other]: "LIVE" }, effectProfiles: { [other]: "fixture:controlled-send" } },
  }));
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.HUMAN_ROOTED_AUTHORITY, "unsatisfied");
});

test("RA-T10 Legacy delegated or expired grant remains ineffective", t => {
  const f = fixture(t);
  f.db.prepare("UPDATE grants SET revoked_at=? WHERE grant_id=?").run(new Date().toISOString(), f.grant.grantId);
  // Legacy delegation: Human-looking issuer, delegable flag, no admitted act.
  f.db.prepare(`INSERT INTO grants(grant_id,subject_node_id,capability,resource_scope,issuer,delegable,parent_grant_id)
    VALUES ('legacy-delegable',?,?,?,'human:legacy-owner',1,NULL)`)
    .run(f.chief, "task.dispatch", `node/${f.target}`);
  // Expired but otherwise well-formed-looking legacy grant.
  f.db.prepare(`INSERT INTO grants(grant_id,subject_node_id,capability,resource_scope,issuer,delegable,parent_grant_id,expires_at)
    VALUES ('legacy-expired',?,?,?,'human:legacy-owner',0,NULL,?)`)
    .run(f.chief, "task.dispatch", `node/${f.target}`, "2020-01-01T00:00:00.000Z");
  assert.equal(humanRootedFor(f.db, f.chief, f.world, { capability: "task.dispatch", resource: `node/${f.target}` }), false);
  assert.equal(evaluateActivation(f.db, f.input()).ready, false);
  for (const id of ["legacy-delegable", "legacy-expired"])
    assert.ok(getGrant(f.db, id), `${id} remains in history`);
});

test("M3-T01 Safe activation exit requires every mandatory prerequisite", t => {
  const f = fixture(t);
  const base = f.input();
  for (const name of Object.keys(evaluateActivation(f.db, base).prerequisites)) {
    const decision = evaluateActivation(f.db, base);
    assert.ok(decision.prerequisites[name as keyof typeof decision.prerequisites] !== "unknown",
      `${name} must be decided, never left unknown`);
  }
  assert.equal(evaluateActivation(f.db, base).reasons.length, 0);
});

test("M3-T02 Maintenance cannot be disabled by flag-only mutation", t => {
  const f = fixture(t);
  // The operator override is one-way: it can only add maintenance.
  const forced = evaluateActivation(f.db, f.input({ maintenanceForced: true }));
  assert.equal(forced.ready, false);
  assert.ok(forced.reasons.includes("MAINTENANCE_FORCED"));
  // Clearing it cannot manufacture readiness from missing facts.
  const empty = openDatabase(":memory:");
  t.after(() => { if (empty.isOpen) empty.close(); });
  const world = createWorld(empty, "Empty", "fixture");
  const decision = evaluateActivation(empty, { worldId: world, chiefNodeId: randomUUID(),
    chiefSessionId: randomUUID(), live: { frontendPresence: "LIVE", chiefRuntimePresence: "LIVE" }, required: [] });
  assert.equal(decision.ready, false);
  assert.ok(decision.reasons.includes("HUMAN_PRINCIPAL"));
});

test("M3-T03 Fresh Human frontend Presence is required for the return route", t => {
  const f = fixture(t);
  f.db.prepare("UPDATE chief_conversations SET state='retired'").run();
  const decision = evaluateActivation(f.db, f.input());
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.HUMAN_FRONTEND_BINDING, "unsatisfied");
  assert.equal(decision.prerequisites.RETURN_ROUTE, "unsatisfied");
});

test("M3-T04 lastKnown Human route alone is insufficient", t => {
  const f = fixture(t);
  const decision = evaluateActivation(f.db, f.input({ live: { ...f.input().live, frontendPresence: "LAST_KNOWN" } }));
  assert.equal(decision.ready, false);
  assert.equal(decision.prerequisites.RETURN_ROUTE, "unsatisfied");
  assert.equal(recordWorld(f.db, "nodes", f.chief), f.world);
});
test("M3-T09 Work delegation does not mint Authority", t => {
  const f = fixture(t);
  // Selecting or asking another Node to work is not Authority delegation.
  assert.throws(() => issueGrant(f.db, { kind: "node", nodeId: f.chief }, {
    requestId: randomUUID(), subjectNodeId: f.target,
    capability: "task.dispatch", resourceScope: `node/${f.chief}`,
  }), { code: "denied" }, "a Node must not be able to issue an effective grant");
  // v1 policy keeps delegation disabled at the World level.
  assert.equal((f.db.prepare("SELECT delegation_enabled FROM trust_policy WHERE world_id=?").get(f.world) as { delegation_enabled: number }).delegation_enabled, 0);
  assert.equal(humanRootedFor(f.db, f.target, f.world, { capability: "task.dispatch", resource: `node/${f.chief}` }), false);
});

test("RA-T11 Human-reviewed batch admission activates exactly the reviewed scope", t => {
  const f = fixture(t);
  const store = new SemanticStore(f.db, f.world);
  const ingress = openHumanIngress(f.db, { worldId: f.world, humanId: f.human,
    presenceRef: "fixture:operator-terminal", sourceRef: "fixture:human-reviewed-batch" });
  // The Human reviews the exact statement; the digest is what was reviewed.
  const reviewed = { requestId: `human-root:dispatch:${f.chief}:${f.target}`,
    subjectNodeId: f.chief, capability: "task.dispatch", resourceScope: `node/${f.target}`,
    delegable: false, productScope: "*", effectScope: "admission" as const, disclosureScope: "handoff_bounded" };
  const proposal = { type: "authority.grant", objectRef: f.chief, scope: `node/${f.target}`,
    targetRevision: null, args: reviewed, causalRefs: ["human:local-operator-terminal"] };
  const body = explicitHumanStatement(proposal);
  assert.equal(createHash("sha256").update(canonical(proposal)).digest("hex").length, 64);
  const utteranceId = ingress.capture("human-act:reviewed-batch", body);
  // A Node interpretation of the same text still cannot establish the act.
  recordInterpretation(f.db, { worldId: f.world, nodeId: f.target, proposal, confidence: 1, confirmed: true });
  const proof = admitHumanAct(f.db, { worldId: f.world, humanId: f.human, utteranceId, proposal });

  f.db.prepare("UPDATE grants SET revoked_at=? WHERE grant_id=?").run(new Date().toISOString(), f.grant.grantId);
  assert.equal(evaluateActivation(f.db, f.input()).ready, false);
  issueGrant(f.db, { kind: "human", id: f.human, actId: proof.actId }, reviewed);
  const decision = evaluateActivation(f.db, f.input());
  assert.equal(decision.ready, true, decision.reasons.join(","));
  assert.equal(decision.mode, "active");
  // The reviewed scope is exact: a different target in the same World is uncovered.
  assert.equal(humanRootedFor(f.db, f.chief, f.world, { capability: "task.dispatch", resource: `node/${store.registerNode("Unreviewed")}` }), false);
});

test("G1: expired aggregate recomputes exact scoped readiness without pretending the Chat went offline", async t => {
  const f = fixture(t);
  const controller = new ActivationController(f.db, {
    base: () => f.input(), probe: async () => f.input().live, ttlMs: 1 });
  assert.equal((await controller.refresh()).ready, true);
  await new Promise(r => setTimeout(r, 20));
  const decision = controller.decision();
  assert.equal(decision.ready, false,"Unobserved exact Host contexts must block");
  assert.ok(decision.reasons.includes("CHIEF_RUNTIME_PRESENCE"));
  assert.ok(decision.reasons.includes("TARGET_PRESENCE"));
  const detail = decision.detail as Record<string, unknown>;
  assert.equal(detail.observationSource,"per-object-duration-bounded-evidence");
  assert.equal(detail.noNetworkCalls,true);
  const per = detail.freshness as Record<string, { state: string; judgment: string }>;
  assert.equal(per.exactPresence.state,"LIVE","Existing valid Chat Presence must remain independent");
  assert.equal(per.preparedRoute.state,"USABLE");
});

test("G1: independently valid scoped Host and exact Chat evidence survives an expired aggregate", async t => {
  const f=fixture(t);
  recordFixtureHostAvailable(f.db,f.chiefSession);
  recordFixtureHostAvailable(f.db,f.targetSession);
  const controller=new ActivationController(f.db,{base:()=>f.input(),probe:async()=>f.input().live,ttlMs:1});
  assert.equal((await controller.refresh()).ready,true);
  await new Promise(resolve=>setTimeout(resolve,20));
  const before=f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n;
  const derived=controller.decision();
  assert.equal(derived.ready,true,JSON.stringify(derived));
  assert.equal(derived.detail.observationSource,"per-object-duration-bounded-evidence");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n,before,"Repeated read is not a Probe");
  f.db.prepare("UPDATE session_health SET updated_at='1990-01-01T00:00:00.000Z' WHERE session_id=?")
    .run(f.targetSession);
  assert.equal(controller.decision().ready,false,"Tampered or mismatched Host evidence must withdraw eligibility");
});

test("P0: freshness separates transport health, exact Presence and route", t => {
  const f = fixture(t);
  const worldId = recordWorld(f.db, "nodes", f.chief), bindingId = "binding-fixture";
  // A NEWER transport-only poll must not be promoted into exact Presence.
  recordFrontendPresence(f.db, { worldId, bindingId, conversationRef: "https://chatgpt.com/c/fixture",
    evidenceClass: "TRANSPORT_POLL", evidenceRef: "fixture:newer-tunnel-poll", method: "fixture tunnel poll",
    observedAt: new Date(Date.now() + 5_000).toISOString() });
  const fresh = observationFreshness(f.db, { worldId, bindingId });
  assert.equal(fresh.transportHealth.state, "LIVE", "transport health is genuinely fresh");
  assert.equal(fresh.exactPresence.source, "fixture route evidence",
    "exact Presence must be answered by route-verified evidence, never by the newer transport poll");
  assert.equal(fresh.exactPresence.state, "LIVE");
  assert.notEqual(fresh.exactPresence.evidenceRef, fresh.transportHealth.evidenceRef,
    "the two objects must cite different evidence");
  assert.notEqual(fresh.preparedRoute.state, "UNKNOWN", "a route was prepared in the fixture");
  for (const key of ["transportHealth", "exactPresence", "preparedRoute"] as const) {
    assert.ok(fresh[key].object.length > 0);
    assert.ok(fresh[key].recoveryAction.includes("chief_frontend_prepare"));
  }
});

test("P0: reading status is read-only and never renews an observation", async t => {
  const f = fixture(t);
  const controller = new ActivationController(f.db, {
    base: () => f.input(), probe: async () => f.input().live, ttlMs: 1 });
  await controller.refresh();
  await new Promise(r => setTimeout(r, 20));
  const count = () => (f.db.prepare("SELECT COUNT(*) AS n FROM frontend_presence_observations").get() as { n: number }).n;
  const before = count();
  controller.decision(); controller.decision(); controller.decision();
  assert.equal(count(), before, "a status read must not write new observations");
  assert.equal(controller.decision().ready, false, "and it must not renew readiness either");
});

test("P0: a newer transport poll must not mask an older valid route-verified Presence", t => {
  const f = fixture(t);
  const worldId = recordWorld(f.db, "nodes", f.chief), bindingId = "binding-fixture";
  // The fixture already recorded ROUTE_VERIFIED. Put a NEWER transport poll on top.
  recordFrontendPresence(f.db, { worldId, bindingId, conversationRef: "https://chatgpt.com/c/fixture",
    evidenceClass: "TRANSPORT_POLL", evidenceRef: "fixture:newer-poll", method: "fixture tunnel poll",
    observedAt: new Date(Date.now() + 10_000).toISOString() });
  const fresh = observationFreshness(f.db, { worldId, bindingId });
  assert.equal(fresh.exactPresence.state, "LIVE",
    "an older still-valid route-verified observation still answers for exact Presence");
  assert.equal(fresh.exactPresence.source, "fixture route evidence",
    "the route-verified observation must win over the newer transport poll");
  // With no route-verified observation at all, exact Presence must be UNVERIFIED,
  // never promoted from transport.
  // Observations are append-only, so use a second binding that has ONLY transport
  // evidence rather than deleting the route-verified one.
  const other = fixture(t);
  const w2 = recordWorld(other.db, "nodes", other.chief);
  const transportOnly = "binding-transport-only";
  recordFrontendPresence(other.db, { worldId: w2, bindingId: transportOnly, conversationRef: "https://chatgpt.com/c/only-poll",
    evidenceClass: "TRANSPORT_POLL", evidenceRef: "fixture:only-poll", method: "fixture tunnel poll" });
  const fresh2 = observationFreshness(other.db, { worldId: w2, bindingId: transportOnly });
  assert.equal(fresh2.transportHealth.state, "LIVE");
  assert.equal(fresh2.exactPresence.state, "UNVERIFIED");
  assert.match(fresh2.exactPresence.judgment, /transport evidence is NOT exact-conversation evidence/);
});

test("Historical UI route evidence neither establishes exact Presence nor masks a valid protocol observation",()=>{
 const db=openDatabase(":memory:");try{
  db.prepare("INSERT INTO nodes VALUES ('diagnostic','Diagnostic','active','now')").run();
  const worldId=recordWorld(db,"nodes","diagnostic"),bindingId="diagnostic-only",at=Date.now();
  recordFrontendPresence(db,{worldId,bindingId,conversationRef:"exact-chat",evidenceClass:"UI_ROUTE_VERIFIED",evidenceRef:"historical-ui",method:"retained UI observation",observedAt:new Date(at).toISOString()});
  assert.equal(observationFreshness(db,{worldId,bindingId,at}).exactPresence.state,"UNVERIFIED");
  assert.equal(latestFrontendPresence(db,{worldId,bindingId,at,verifiedOnly:true}).state,"UNKNOWN");
  recordFrontendPresence(db,{worldId,bindingId,conversationRef:"exact-chat",evidenceClass:"ROUTE_VERIFIED",evidenceRef:"protocol",method:"exact protocol read",observedAt:new Date(at-1000).toISOString()});
  assert.equal(latestFrontendPresence(db,{worldId,bindingId,at,verifiedOnly:true}).evidenceClass,"ROUTE_VERIFIED");
  assert.equal(latestFrontendPresence(db,{worldId,bindingId,at,productionOnly:true}).evidenceClass,"ROUTE_VERIFIED");
 }finally{db.close();}
});

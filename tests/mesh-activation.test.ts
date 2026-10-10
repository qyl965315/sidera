import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { CoreRuntime } from "../core/runtime.ts";
import { ActivationController, humanRootedFor } from "../core/activation.ts";
import { startCooperation } from "../core/cooperation.ts";
import { fixtureBasis, mockProfile } from "./fixtures/execution.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";
import { grantSelf, issueGrant, revokeGrant, setAuthorityConstraint } from "./fixtures/authority.ts";
import { recordWorld } from "../core/worlds.ts";
import type { EffectControlProfile } from "../core/effect-gate.ts";
import type { Hythe } from "../hythes/types.ts";

function fixture(t: TestContext, options: { acceptedBasis?: boolean; unknownBasis?: boolean; forced?: boolean } = {}) {
  const db = openDatabase(":memory:"), world = createWorld(db, "Mesh admission", "bounded test");
  const store = new SemanticStore(db, world), human = store.createHuman("Human", "fixture Human");
  const caller = store.registerNode("Ordinary supervisor"), target = store.registerNode("Ordinary worker");
  const at = new Date().toISOString();
  for (const node of [caller, target]) {
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)").run(`${node}:session`, node, `fixture:${node}`, at);
    recordFixtureHostAvailable(db,`${node}:session`);
    grantSelf(db, node);
  }
  const dispatch = issueGrant(db, { kind: "human", id: human }, { subjectNodeId: caller, capability: "task.dispatch", resourceScope: `node/${target}` });
  const reply = issueGrant(db, { kind: "human", id: human }, { subjectNodeId: target, capability: "message.send", resourceScope: `node/${caller}` });
  const basis = options.acceptedBasis ? fixtureBasis(db, caller) : undefined;
  if (basis) db.prepare("UPDATE responsibilities SET accepted_at=? WHERE responsibility_id=?").run(at, basis.responsibilityId);
  if (options.unknownBasis) db.prepare(`INSERT INTO responsibilities(responsibility_id,title,scope,owner_node_id,state,created_at,updated_at,accepted_at)
    VALUES ('unknown-basis','Unknown legacy obligation','fixture',?,'active',?,?,?)`).run(caller, at, at, at);
  let profile: EffectControlProfile | undefined = mockProfile, invocations = 0, frontendProbes = 0;
  const locators: string[] = [];
  const hythe: Hythe = {
    hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"], canStartTurn: () => true,
    effectProfile: () => profile,
    locate: async locator => { locators.push(locator); return true; }, async *receive() {},
    invoke: async (locator, operation, _input, _id, boundary) => {
      assert.ok(boundary, "final Effect gate must still supply the permit");
      return boundary.cross({ product: "fixture", locator, operation }, () => {
        invocations++; return { status: "accepted" as const, hostRef: `fixture-turn:${invocations}` };
      });
    },
  };
  const activation = new ActivationController(db, {
    base: () => ({ worldId: world, chiefNodeId: "unrelated-unbound-chief", chiefSessionId: "absent", required: [] }),
    probe: async () => { frontendProbes++; throw new Error("An unrelated frontend must not be inspected"); },
    maintenanceForced: options.forced,
  });
  const runtime = new CoreRuntime(db, new Map([[hythe.hytheId, hythe]]), undefined, { activation });
  t.after(() => { runtime.close(); db.close(); });
  const queue = (payload: Record<string, unknown>, createdAt = new Date().toISOString()) => {
    const eventId = randomUUID();
    db.prepare("INSERT INTO events VALUES (?,?, 'human.message',?,?)").run(eventId, caller, JSON.stringify(payload), createdAt);
    db.prepare("INSERT INTO runtime_observations(event_id,target_node_id,state) VALUES (?,?,'queued')").run(eventId, caller);
    return eventId;
  };
  return { db, runtime, caller, target, human, dispatch, reply, basis, queue, locators, hythe,
    setProfile: (value: EffectControlProfile | undefined) => { profile = value; },
    counts: () => ({ invocations, frontendProbes }) };
}

test("legal Node-to-Node admission uses exact participants while an unrelated Chief frontend stays blocked", async t => {
  const f = fixture(t);
  assert.equal(f.runtime.maintenance().blocked, true);
  const admitted = await f.runtime.executionAdmission(f.caller, f.target);
  assert.equal(admitted.ready, true, JSON.stringify(admitted));
  assert.deepEqual(admitted.reasons, []);
  assert.deepEqual(f.locators, [`fixture:${f.caller}`, `fixture:${f.target}`]);
  assert.deepEqual(f.counts(), { invocations: 0, frontendProbes: 0 });
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0, "an observation cannot create work");
  assert.equal(f.runtime.maintenance().blocked, true, "Node admission cannot fabricate Human route readiness");
});

test("Node admission retains profile, identity, rooted forward/return authority and forced-maintenance gates", async t => {
  const f = fixture(t);
  f.setProfile(undefined);
  assert.ok((await f.runtime.executionAdmission(f.caller, f.target)).reasons.includes("TARGET_EFFECT_CONTROL_PROFILE"));
  f.setProfile({ ...mockProfile, externalIdentityRequired: true });
  assert.ok((await f.runtime.executionAdmission(f.caller, f.target)).reasons.includes("TARGET_EXTERNAL_IDENTITY"));
  f.setProfile(mockProfile);
  revokeGrant(f.db, { kind: "human", id: f.human }, { requestId: randomUUID(), grantId: f.reply.grantId });
  assert.ok((await f.runtime.executionAdmission(f.caller, f.target)).reasons.includes("RETURN_AUTHORITY"));
  revokeGrant(f.db, { kind: "human", id: f.human }, { requestId: randomUUID(), grantId: f.dispatch.grantId });
  assert.ok((await f.runtime.executionAdmission(f.caller, f.target)).reasons.includes("HUMAN_ROOTED_AUTHORITY"));
  const forced = fixture(t, { forced: true });
  assert.ok((await forced.runtime.executionAdmission(forced.caller, forced.target)).reasons.includes("MAINTENANCE_FORCED"));
  assert.equal(forced.locators.length, 0);
  assert.equal(f.counts().invocations, 0);
});

test("an event without an accepted current semantic basis remains queued and starts no model turn", async t => {
  for (const unknownBasis of [false, true]) {
    const f = fixture(t, { unknownBasis }), eventId = f.queue({ targetNodeId: f.caller });
    await f.runtime.continuations.wakeObservations();
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0);
    assert.equal(f.db.prepare("SELECT state FROM runtime_observations WHERE event_id=?").get(eventId)?.state, "queued");
    assert.deepEqual(f.counts(), { invocations: 0, frontendProbes: 0 });
  }
});

test("an event self-wake carries its owned Responsibility basis through the unchanged final Effect gate", async t => {
  const f = fixture(t, { acceptedBasis: true });
  const eventId = f.queue({ targetNodeId: f.caller, responsibilityId: f.basis!.responsibilityId });
  await f.runtime.continuations.wakeObservations();
  const task = f.db.prepare("SELECT task_id FROM runtime_event_tasks WHERE event_id=?").get(eventId);
  assert.ok(task);
  const basis = f.db.prepare("SELECT responsibility_id,intent_revision_id,context_basis_json FROM task_bases WHERE task_id=?").get(task.task_id);
  assert.equal(basis?.responsibility_id, f.basis!.responsibilityId);
  assert.equal(basis?.intent_revision_id, f.basis!.intentRevisionId);
  assert.ok(JSON.parse(String(basis?.context_basis_json)).includes(`event:${eventId}`));
  assert.equal(f.db.prepare("SELECT state FROM runtime_observations WHERE event_id=?").get(eventId)?.state, "admitted");
  assert.deepEqual(f.counts(), { invocations: 1, frontendProbes: 0 });
});

test("a cooperation kickoff and old unrelated events do not generate duplicate self Tasks", async t => {
  const old = fixture(t, { acceptedBasis: true });
  const prior = old.queue({ targetNodeId: old.caller }, "2000-01-01T00:00:00.000Z");
  await old.runtime.continuations.wakeObservations();
  assert.equal(old.db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0);
  assert.equal(old.db.prepare("SELECT state FROM runtime_observations WHERE event_id=?").get(prior)?.state, "queued");
  const kickoff = fixture(t, { acceptedBasis: true });
  const eventId = kickoff.queue({ targetNodeId: kickoff.caller, responsibilityId: kickoff.basis!.responsibilityId });
  const receipt = startCooperation(kickoff.db, { nodeId: kickoff.caller, sessionId: `${kickoff.caller}:session` }, {
    requestId: "one-real-supervisor-kickoff", goal: "Choose work and review through canonical cooperation", basis: kickoff.basis!,
  });
  await kickoff.runtime.continuations.wakeObservations();
  assert.equal(kickoff.db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0);
  assert.equal(kickoff.db.prepare("SELECT state FROM messages WHERE message_id=?").get(receipt.messageId)?.state, "queued");
  assert.equal(kickoff.db.prepare("SELECT state FROM runtime_observations WHERE event_id=?").get(eventId)?.state, "queued");
  assert.equal(kickoff.counts().invocations, 0);
});

test("A missed observation terminal event reconciles the exact original turn without replay or self-result",async t=>{
  const f=fixture(t,{acceptedBasis:true});let reads=0,confirmed=false;
  f.hythe.completedTurn=async(_locator,hostRef,messageId)=>{reads++;return confirmed?
    {hostRef,observedMessageId:messageId,body:"Observed",outcome:"completed"}:null;};
  const eventId=f.queue({targetNodeId:f.caller,responsibilityId:f.basis!.responsibilityId});
  await f.runtime.continuations.wakeObservations();
  const run=f.db.prepare("SELECT r.* FROM task_runs r JOIN runtime_event_tasks e USING(task_id) WHERE e.event_id=?").get(eventId)!;
  assert.throws(()=>startCooperation(f.db,{nodeId:f.caller,sessionId:`${f.caller}:session`},
    {requestId:"busy",goal:"Overlap",basis:f.basis!}),{code:"unavailable"});
  await assert.rejects(f.runtime.continuations.reconcileCompletedResult(String(run.run_id)),{code:"unavailable"});
  assert.equal(f.db.prepare("SELECT state FROM task_runs WHERE run_id=?").get(run.run_id)?.state,"running");
  confirmed=true;await f.runtime.continuations.reconcileCompletedResult(String(run.run_id));
  await f.runtime.continuations.reconcileCompletedResult(String(run.run_id));
  assert.equal(reads,2);assert.equal(f.counts().invocations,1);
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(run.task_id)?.state,"completed");
  assert.equal(f.db.prepare("SELECT turn_open FROM task_runs WHERE run_id=?").get(run.run_id)?.turn_open,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.observation_reconciled'").get()?.n,1);
});

test("one bounded Host observation deadline reports unavailable without retrying or waking work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), originalLocate = f.hythe.locate;
  let targetChecks = 0;
  f.hythe.locate = locator => locator === `fixture:${f.target}`
    ? (targetChecks++, new Promise<boolean>(() => {})) : originalLocate(locator);
  const observation = f.runtime.executionAdmission(f.caller, f.target);
  // The deadline belongs to the target Host probe, not to an arbitrary
  // number of scheduler microtasks preceding it. Wait for that exact probe.
  for (let i = 0; i < 32 && targetChecks === 0; i++) await Promise.resolve();
  assert.equal(targetChecks, 1, "The target probe must be reached before advancing its mock clock");
  t.mock.timers.tick(10_000);
  const result = await observation;
  assert.ok(result.reasons.includes("TARGET_PRESENCE"));
  t.mock.timers.tick(60_000);
  assert.equal(targetChecks, 1);
  assert.equal(f.counts().invocations, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0);
});

test("activation applies canonical resource /** matching without granting another Node or bypassing constraints", t => {
  const f = fixture(t), world = recordWorld(f.db, "nodes", f.caller);
  const requirement = { capability: "self.task.resume", resource: `node/${f.caller}/session/${f.caller}:session`,
    product: "fixture", effectScope: "admission" };
  assert.equal(humanRootedFor(f.db, f.caller, world, requirement), true);
  assert.equal(humanRootedFor(f.db, f.caller, world, { ...requirement, resource: `node/${f.caller}` }), true);
  assert.equal(humanRootedFor(f.db, f.caller, world, { ...requirement, resource: `node/${f.target}/session/${f.target}:session` }), false);
  assert.equal(humanRootedFor(f.db, f.caller, world, { ...requirement, resource: `node/${f.caller}-suffix/session/other` }), false);
  assert.equal(humanRootedFor(f.db, f.caller, world, { ...requirement, capability: "task.dispatch" }), false);
  setAuthorityConstraint(f.db, { kind: "human", id: f.human }, { constraintId: "exact-self-maintenance",
    subjectNodeId: f.caller, resourceScope: `node/${f.caller}/session/**`, active: true, reason: "fixture scoped denial" });
  assert.equal(humanRootedFor(f.db, f.caller, world, requirement), false);
});

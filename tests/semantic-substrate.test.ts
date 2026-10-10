import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { compatibilityWorld, createWorld, migrateWorlds, readWorldRecord, recordWorld } from "../core/worlds.ts";
import { SemanticStore, intentProof } from "./fixtures/human.ts";
import { createResponsibility, getResponsibility } from "./fixtures/organization.ts";
import { issueGrant, canUseCapability } from "./fixtures/authority.ts";
import { Registry, registryAuthority } from "../core/registry.ts";
import { Continuations } from "./fixtures/execution.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { callCore } from "../hythes/core-client.ts";
import { getTask } from "../core/scheduler.ts";
import { getMessage } from "./fixtures/bus.ts";
import type { Hythe, HostMessage } from "../hythes/types.ts";

function fixture(t: TestContext, disk = false) {
  const file = disk ? join(mkdtempSync(join(tmpdir(), "sidera-mone-")), "test.sqlite") : ":memory:";
  let db = openDatabase(file);
  t.after(() => { if (db.isOpen) db.close(); });
  const world = createWorld(db, "test World", "synthetic M1 test fixture"), store = new SemanticStore(db, world);
  const actor = store.registerNode("Supervisor"), target = store.registerNode("Worker");
  const bind = (id: string, suffix = "one") => {
    const session = `${id}-${suffix}`;
    db.prepare("INSERT INTO sessions VALUES (?,?,'fake','fixture',?,'active',?)").run(session, id, `fixture://${session}`, new Date().toISOString());
    return session;
  };
  const actorSession = bind(actor), targetSession = bind(target);
  for (const node of [actor,target]) for (const capability of ["task.dispatch","message.send"])
    issueGrant(db, {kind:"human",id:"fixture-grant-source"}, {subjectNodeId:node,capability,resourceScope:"node/**"});
  const human = store.createHuman("Synthetic Human", "fixture human identity; not a provider account");
  const intent = store.createIntent(human, "fixture recorded Human intent; admission not exercised");
  const i1 = store.reviseIntent(intent, null, "I1", "fixture:human:I1");
  const responsibility = createResponsibility(db, {kind:"node",nodeId:actor,sessionId:actorSession}, {
    requestId:"responsibility",title:"Pursue the intent",scope:"fixture",ownerNodeId:actor,
    basis:{intentRevisionId:i1,contextBasis:["fixture:context:one"]},
  });
  const calls: unknown[] = [];
  const hythe: Hythe = {hytheId:"fake",hostKind:"fixture",capabilities:()=>["message.receive"],locate:async()=>true,
    invoke:async(locator,_cap,input)=>{ calls.push({locator,input}); return {status:"accepted",hostRef:`host-${calls.length}`}; },
    receive:async function* (): AsyncIterable<HostMessage> {} };
  const hythes = new Map([["fake",hythe]]);
  const input = (requestId="root") => ({requestId,originNodeId:actor,originSessionId:actorSession,centerNodeId:target,workerNodeIds:[],body:"Do fixture work",
    basis:{responsibilityId:responsibility.responsibilityId,intentRevisionId:i1,contextBasis:["fixture:context:one"]}});
  const scheduler = new Continuations(db,hythes);
  return {db,world,store,actor,target,actorSession,targetSession,bind,human,intent,i1,responsibility,input,scheduler,hythes,calls,
    reopen(){ db.close(); db=openDatabase(file); this.db=db; this.store=new SemanticStore(db,world); this.scheduler=new Continuations(db,hythes); this.scheduler.recover(); }};
}

test("M1 T1: World isolation covers records, cross-World references, Authority and RPC reads", async t => {
  const f=fixture(t), otherWorld=createWorld(f.db,"other","fixture distinct World"), other=new SemanticStore(f.db,otherWorld);
  const outsider=other.registerNode("outsider");
  f.bind(outsider);
  const task=f.scheduler.submit(f.input());
  assert.equal(recordWorld(f.db,"tasks",task.task.taskId),f.world);
  assert.throws(()=>readWorldRecord(f.db,otherWorld,"tasks",[task.task.taskId]),{code:"denied"});
  assert.throws(()=>f.scheduler.submit({...f.input("cross"),centerNodeId:outsider}),{code:"denied"});
  assert.throws(()=>f.scheduler.submit({...f.input("hidden-worker"),workerNodeIds:[outsider]}),{code:"denied"});
  assert.equal(canUseCapability(f.db,{subjectNodeId:f.actor,sessionId:f.actorSession,requestId:"cross",capability:"task.dispatch",resource:`node/${outsider}`}),false);
  assert.throws(()=>f.db.prepare("UPDATE tasks SET center_node_id=? WHERE task_id=?").run(outsider,task.task.taskId),/Cross-World/);
  for(const table of ["nodes","sessions","responsibilities","tasks","task_runs","messages","events","tensions","grants"]){
    const info=f.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;pk:number}[];
    const pk=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>`s.${c.name}`).join(",");
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table} s WHERE NOT EXISTS(SELECT 1 FROM world_records w WHERE table_name=? AND record_key=json_array(${pk}))`).get(table)!.n,0);
  }
  const runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
  const rpc=new CoreRpcServer(f.db,runtime,f.hythes,{authenticate:()=>({kind:"node",nodeId:outsider,sessionId:`${outsider}-one`})});
  try {
    const core={port:await rpc.listen(),token:"fixture"};
    await assert.rejects(callCore(core,"responsibility.get",{responsibilityId:f.responsibility.responsibilityId}),/Cross-World/);
    await assert.rejects(callCore(core,"intent.current",{intentId:f.intent}),/not found in this World/);
  } finally { await rpc.close(); runtime.close(); }
  f.db.prepare("INSERT INTO nodes VALUES ('unscoped','legacy caller','active','now')").run();
  assert.equal(recordWorld(f.db,"nodes","unscoped"),compatibilityWorld(f.db));
  assert.notEqual(compatibilityWorld(f.db),otherWorld);
});

test("M1 T2: Session replacement retains Node, World and identity lineage",async t=>{
  const f=fixture(t), before=f.db.prepare("SELECT * FROM node_identity WHERE node_id=?").get(f.target);
  const registry=new Registry(f.db,{authorize:registryAuthority(f.db),getHythe:id=>f.hythes.get(id)});
  const context={actorNodeId:f.target,actorSessionId:f.targetSession,requestId:"replace",resourceScope:`node/${f.target}`};
  const session=await registry.bindSession(context,{nodeId:f.target,hytheId:"fake",hostKind:"fixture",locatorRef:"fixture://replacement"});
  await registry.handoffSession({...context,requestId:"handoff"},f.target,session.sessionId,f.targetSession);
  assert.equal(registry.getActiveSession(f.target)!.sessionId,session.sessionId);
  assert.deepEqual(f.db.prepare("SELECT * FROM node_identity WHERE node_id=?").get(f.target),before);
  assert.equal(recordWorld(f.db,"sessions",session.sessionId),f.world);
});

test("M1 T3: separate ExternalIdentities survive one suspension with Human, World, Node and Responsibility",t=>{
  const f=fixture(t,true);
  const a=f.store.addExternalIdentity(f.human,"provider-a","subject-a","account login A");
  const b=f.store.addExternalIdentity(f.human,"provider-b","subject-b","account login B");
  f.store.setIdentityState(a,"suspended"); f.reopen();
  const accounts=f.db.prepare("SELECT * FROM external_identities WHERE human_id=? ORDER BY provider").all(f.human);
  assert.deepEqual(accounts.map(a=>[a.state,a.provenance]),[["suspended","account login A"],["active","account login B"]]);
  assert.notEqual(a,b);
  assert.ok(f.db.prepare("SELECT 1 FROM human_principals WHERE human_id=?").get(f.human));
  assert.ok(f.db.prepare("SELECT 1 FROM sidera_worlds WHERE world_id=?").get(f.world));
  assert.ok(f.db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(f.actor));
  assert.equal(getResponsibility(f.db,f.responsibility.responsibilityId).state,"active");
});

test("M1 T4: Entitlement, UNKNOWN resource and action Feasibility remain independent",t=>{
  const f=fixture(t);
  const identity=f.store.addExternalIdentity(f.human,"fixture-provider","account-ref","fixture login");
  const entitlement=f.store.recordEntitlement(identity,{operation:"reasoning",plan:"existing subscription"},"fixture:rule","2026-01-01",null);
  const observation=f.store.observeResource(entitlement,{knowledge:"UNKNOWN",value:null,sourceRef:"fixture:quota-unavailable",observedAt:"2026-01-01",freshUntil:null});
  const action=f.store.logicalAction(f.actor,f.target,"fixture.operation","fixture:work");
  const no=f.store.assessFeasibility(action,"false","fixture:host-unreachable"), unknown=f.store.assessFeasibility(action,"unknown","fixture:no-current-host-evidence");
  assert.equal(f.store.entitlement(entitlement).valid_until,null);
  assert.equal(f.store.resourceObservation(observation).knowledge,"UNKNOWN");
  assert.equal(f.store.resourceObservation(observation).value_json,null);
  assert.equal(f.store.resourceObservation(observation).freshness,"UNKNOWN");
  assert.equal(f.store.feasibility(no).executable,"false"); assert.equal(f.store.feasibility(unknown).executable,"unknown");
  assert.throws(()=>f.store.observeResource(entitlement,{knowledge:"UNKNOWN",value:100,sourceRef:"fiction",observedAt:"now",freshUntil:null}),/UNKNOWN/);
});

test("M1 T5: immutable I1 -> I2 -> I3 history remains queryable",t=>{
  const f=fixture(t), i2=f.store.reviseIntent(f.intent,f.i1,"I2","fixture:human:I2"), i3=f.store.reviseIntent(f.intent,i2,"I3","fixture:human:I3");
  assert.equal(f.store.revision(f.i1).content,"I1"); assert.equal(f.store.revision(i2).parent_revision_id,f.i1);
  assert.equal(f.store.currentIntent(f.intent).candidates[0]!.revision_id,i3);
  assert.throws(()=>f.db.prepare("UPDATE intent_revisions SET content='overwritten' WHERE revision_id=?").run(f.i1),/immutable/);
});

test("M1 T6: sibling Intent revisions are both retained across reopen",t=>{
  const f=fixture(t,true);
  const pa=intentProof(f.store,f.intent,f.i1,"I2A","fixture:human:A"),pb=intentProof(f.store,f.intent,f.i1,"I2B","fixture:human:B");
  const a=f.store.reviseIntent(f.intent,f.i1,"I2A","fixture:human:A",pa),b=f.store.reviseIntent(f.intent,f.i1,"I2B","fixture:human:B",pb);
  f.reopen();
  assert.equal(f.store.currentIntent(f.intent).state,"CONFLICT");
  assert.deepEqual(new Set(f.store.currentIntent(f.intent).candidates.map(r=>r.revision_id)),new Set([a,b]));
});

test("M1 T7: CurrentIntent is reconstructed from ancestry, not timestamp or insertion order",t=>{
  const f=fixture(t);
  // Deliberately opposite clock order: neither late-arriving nor later-dated child wins.
  for(const [id,time] of [["candidate-a","2099-01-01"],["candidate-b","2000-01-01"]])
    f.db.prepare("INSERT INTO intent_revisions VALUES (?,?,?,?,?,?,?)").run(id,f.world,f.intent,f.i1,id,"fixture:human",time);
  const c=f.store.reviseIntent(f.intent,"candidate-a","I3A","fixture:human:3A");
  const projection=f.store.currentIntent(f.intent);
  assert.equal(projection.state,"CONFLICT"); assert.deepEqual(new Set(projection.candidates.map(r=>r.revision_id)),new Set([c,"candidate-b"]));
});

test("M1 T8: Responsibility and basis outlive uncertain Core restart reconstruction",async t=>{
  const f=fixture(t,true), task=f.scheduler.submit(f.input()); await f.scheduler.pump();
  f.reopen();
  assert.equal(f.scheduler.run(task.run.run_id).state,"running");
  assert.equal(f.db.prepare("SELECT state FROM session_health WHERE session_id=?").get(f.targetSession)!.state,"unknown");
  assert.equal(getResponsibility(f.db,f.responsibility.responsibilityId).state,"active");
  assert.equal(f.store.runBasis(task.run.run_id).responsibility_id,f.responsibility.responsibilityId);
  await f.scheduler.pump(); assert.equal(f.calls.length,1);
});

test("M1 T9: canonical Run and child WAIT/continuation retain explicit Intent/context basis",async t=>{
  const f=fixture(t), root=f.scheduler.submit(f.input());
  // JSON field order is not semantic identity (including the RPC parser's shape).
  assert.equal(f.scheduler.submit({...f.input(),basis:{contextBasis:["fixture:context:one"],intentRevisionId:f.i1,responsibilityId:f.responsibility.responsibilityId}}).task.taskId,root.task.taskId);
  await f.scheduler.pump();
  const basis=f.store.runBasis(root.run.run_id);
  assert.equal(basis.intent_revision_id,f.i1); assert.deepEqual(JSON.parse(basis.context_basis_json),["fixture:context:one"]);
  const child=f.scheduler.submit({requestId:"child",originNodeId:f.target,originSessionId:f.targetSession,centerNodeId:f.actor,workerNodeIds:[],body:"reverse delegation"},
    {runId:root.run.run_id,checkpoint:"need fixture evidence"});
  await f.scheduler.pump();
  assert.equal(f.store.runBasis(child.run.run_id).intent_revision_id,f.i1);
  const finish=async(runId:string)=>{const run=f.scheduler.run(runId),m=getMessage(f.db,run.message_id); await f.scheduler.ingest(run.session_id,{observedMessageId:m.messageId,hostRef:m.hostRef!,body:"result",outcome:"completed"});};
  await finish(root.run.run_id); await finish(child.run.run_id);
  const continuation=f.db.prepare("SELECT continuation_run_id FROM task_dependencies WHERE parent_run_id=?").get(root.run.run_id)!;
  assert.ok(continuation.continuation_run_id);
  assert.equal(f.store.runBasis(String(continuation.continuation_run_id)).intent_revision_id,f.i1);
  assert.throws(()=>f.scheduler.submit({...f.input(),basis:{...f.input().basis,contextBasis:["changed-context"]}}),/Request ID/);
});

test("M1 T10: stale Run is detectable without changing Authority, Feasibility or runtime state",t=>{
  const f=fixture(t), task=f.scheduler.submit(f.input()), before=getTask(f.db,task.task.taskId).task.state;
  f.store.reviseIntent(f.intent,f.i1,"new scope","fixture:human:I2");
  assert.equal(f.store.runBasis(task.run.run_id).currency,"STALE");
  assert.equal(getTask(f.db,task.task.taskId).task.state,before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM feasibility_assessments").get()!.n,0);
  assert.equal(canUseCapability(f.db,{subjectNodeId:f.actor,sessionId:f.actorSession,requestId:"still-authorized",capability:"task.dispatch",resource:`node/${f.target}`}),true);
});

test("M1 T11: LogicalAction and pinned Attempt survive uncertain restart without replay",async t=>{
  const f=fixture(t,true), task=f.scheduler.submit(f.input()); await f.scheduler.pump();
  const map=f.db.prepare("SELECT action_id FROM message_actions WHERE message_id=?").get(task.run.message_id)!;
  const original=f.store.action(String(map.action_id)); f.reopen();
  f.db.prepare("UPDATE sessions SET state='retired' WHERE session_id=?").run(f.targetSession); f.bind(f.target,"two");
  assert.deepEqual(f.store.action(String(map.action_id)),original);
  assert.equal(original.attempts[0]!.target_session_id,f.targetSession);
  assert.equal(f.scheduler.run(task.run.run_id).state,"running"); await f.scheduler.pump(); assert.equal(f.calls.length,1);
  assert.equal(f.db.prepare("SELECT state FROM attempt_observations WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1").get(original.attempts[0]!.attempt_id)!.state,"transport:delivered");
});

test("M1 T12: two Attempt identities/generations and fencing metadata retain one durable action",t=>{
  const f=fixture(t,true), action=f.store.logicalAction(f.actor,f.target,"fixture.operation","fixture:logical-action");
  const first=f.store.attempt(action,f.targetSession);
  f.db.prepare("UPDATE sessions SET state='retired' WHERE session_id=?").run(f.targetSession);
  const replacement=f.bind(f.target,"two"), second=f.store.attempt(action,replacement);
  assert.notEqual(first,second); f.reopen();
  const view=f.store.action(action); assert.deepEqual(view.attempts.map(a=>a.generation),[1,2]);
  assert.equal(new Set(view.attempts.map(a=>a.fence_token)).size,2); assert.equal(view.action.target_node_id,f.target);
  assert.equal(f.calls.length,0); // Allocation is not a permit or execution.
  assert.throws(()=>f.store.attempt(action,f.actorSession),/durable target/);
});

test("M1 T13: additive legacy import is idempotent and never invents Human, Intent, entitlement or effect",t=>{
  const invalid=new DatabaseSync(":memory:");
  try {
    invalid.exec("CREATE TABLE unsupported_legacy(value TEXT)");
    assert.throws(()=>migrateWorlds(invalid),/no stable key/);
    assert.equal(invalid.prepare("SELECT 1 FROM sqlite_master WHERE name='semantic_migrations'").get(),undefined);
    invalid.exec("ALTER TABLE unsupported_legacy RENAME TO retained_without_key");
    // This fixture has no stable identity: migration refuses rather than guessing
    // an identity or dropping the data. A real operator must resolve the schema.
    assert.ok(invalid.prepare("SELECT 1 FROM sqlite_master WHERE name='retained_without_key'").get());
  } finally { invalid.close(); }
  const file=join(mkdtempSync(join(tmpdir(),"sidera-mone-legacy-")),"legacy.sqlite");
  let db=new DatabaseSync(file);
  db.exec(`CREATE TABLE nodes(node_id TEXT PRIMARY KEY,display_name TEXT,lifecycle TEXT,created_at TEXT);
    INSERT INTO nodes VALUES ('legacy-node','old node','active','old-time');
    CREATE TABLE sessions(session_id TEXT PRIMARY KEY,node_id TEXT,hythe_id TEXT,host_kind TEXT,locator_ref TEXT,state TEXT,created_at TEXT);
    INSERT INTO sessions VALUES ('old-session','legacy-node','fake','fixture','fixture://old','active','old-time');
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,request_id TEXT,origin_node_id TEXT,center_node_id TEXT,worker_node_ids TEXT,state TEXT,budget_ref TEXT,created_at TEXT);
    INSERT INTO tasks VALUES ('old-task','old-request','legacy-node','legacy-node','[]','uncertain',NULL,'old-time');
    CREATE TABLE messages(message_id TEXT PRIMARY KEY,request_id TEXT,task_id TEXT,from_node_id TEXT,to_node_id TEXT,target_session_id TEXT,sequence INTEGER,kind TEXT,body TEXT,state TEXT,host_ref TEXT,reservation_id TEXT,created_at TEXT);
    INSERT INTO messages VALUES ('old-message','old-request','old-task','legacy-node','legacy-node','old-session',1,'task','unmodified historic body','uncertain','old-host-ref',NULL,'old-time');
    CREATE TABLE task_runs(run_id TEXT PRIMARY KEY,task_id TEXT,session_id TEXT,message_id TEXT,state TEXT,turn_open INTEGER,checkpoint TEXT,created_at TEXT);
    INSERT INTO task_runs VALUES ('old-run','old-task','old-session','old-message','uncertain',0,'old-checkpoint','old-time');`);
  const original=db.prepare("SELECT * FROM messages").get(); db.close();
  db=openDatabase(file); const world=compatibilityWorld(db); db.close(); db=openDatabase(file);
  t.after(()=>db.close());
  assert.deepEqual(db.prepare("SELECT * FROM messages").get(),original); assert.equal(compatibilityWorld(db),world);
  for(const table of ["human_principals","external_identities","intents","intent_revisions","entitlements","resource_observations","action_attempts"])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
  assert.equal(new SemanticStore(db,world).runBasis("old-run").currency,"UNKNOWN");
  assert.match(String(db.prepare("SELECT provenance FROM world_records WHERE table_name='messages'").get()!.provenance),/legacy_import.*UNKNOWN/);
  assert.equal(db.prepare("SELECT count(*) n FROM logical_actions").get()!.n,1);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length,0);
});

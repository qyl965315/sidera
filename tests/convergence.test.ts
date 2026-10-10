import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { startLocalService } from "../core/service.ts";
import { launchCore } from "../core/launch.ts";
import { reconcileSpecs,activateLostSession } from "../core/onboarding.ts";
import { IdentityStore } from "../core/identity.ts";
import { Registry } from "../core/registry.ts";
import { openDatabase,withTransaction,onCommittedEvent } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { CoreRuntime,guardMocks,fixtureBasis } from "./fixtures/execution.ts";
import { sessionStrategy } from "../core/session-strategy.ts";
import { mutateTension } from "../core/tensions.ts";
import { issueGrant,reserveCapability,setAuthorityConstraint } from "./fixtures/authority.ts";
import { reconcileResourceLoss,reconcileLegacyEmptyTerminal,archiveLegacyUncertainObservation,reconcileCorrelatedHostFailure } from "../core/reconciliation.ts";
import { effectAwareRoute,invokeCapability } from "../core/control-plane.ts";
import { hostManifest } from "../hythes/manifest.ts";
import { canonicalMcpServer,canonicalToolNames } from "../hythes/canonical-mcp.ts";
import { canonicalCodexMcpOverrides } from "../hythes/codex.ts";
import { registeredToolNames } from "../hythes/tool-catalog.ts";
import { HostLifecycle } from "../hythes/lifecycle.ts";
import { openSupervision,linkTaskToSupervision,supervisionView } from "../core/supervision.ts";

test("Managed Codex MCP exposure refreshes stale allowlists from canonical registration",()=>{
 const old='[mcp_servers.sidera_peregrine]\nenabled_tools = ["task_dispatch"]\n';
 const overrides=canonicalCodexMcpOverrides(old);
 const tools=JSON.parse(overrides.find(x=>x.startsWith("mcp_servers.sidera_peregrine.enabled_tools="))!.split("=").slice(1).join("="));
 for(const needed of ["world_inspect","work_inspect","supervision_open","supervision_decide","message_reconcile_result"])assert.ok(tools.includes(needed));
 assert.deepEqual(tools,[...canonicalToolNames()].sort());
 const gateway=canonicalCodexMcpOverrides('[mcp_servers.sidera]\ncommand="node"\n');
 const gatewayTools=JSON.parse(gateway.find(x=>x.startsWith("mcp_servers.sidera.enabled_tools="))!.split("=").slice(1).join("="));
 assert.deepEqual(gatewayTools,["sidera_status","sidera_capabilities","sidera_read","sidera_invoke","sidera_work","sidera_resource"]);
 assert.ok(gateway.includes('mcp_servers.sidera.default_tools_approval_mode="approve"'));
 assert.ok(overrides.includes('mcp_servers.sidera_peregrine.default_tools_approval_mode="approve"'));
 for(const needed of gatewayTools)assert.ok(gateway.includes(`mcp_servers.sidera.tools.${needed}.approval_mode="approve"`));
 assert.deepEqual(canonicalCodexMcpOverrides('[mcp_servers.unrelated]\nenabled_tools=["x"]'),[]);
 assert.ok(overrides.every(arg=>arg==='-c'||arg.startsWith('mcp_servers.sidera_peregrine.')));
});
import type { Hythe } from "../hythes/types.ts";

function fixture() {
 const db=openDatabase(":memory:");
 for(const id of ["origin","worker","glm"]){db.prepare("INSERT INTO nodes VALUES (?,?,'active','now')").run(id,id);
  db.prepare("INSERT INTO sessions VALUES (?,?,'host','codex-app-server',?,'active','now')").run(`${id}-session`,id,`${id}-exact`);}
 const lifecycle=new HostLifecycle(),calls:string[]=[];
 for(const node of ["origin","worker","glm"])grantSelf(db,node);
 const hythe:Hythe={hytheId:"host",hostKind:"codex-app-server",capabilities:()=>["message.receive"],
  manifest:()=>hostManifest({hytheId:"host",hostKind:"codex-app-server"}),controls:()=>["session.inspect"],
  locate:async()=>true,control:async locator=>({locator}),canStartTurn:()=>false,
  onLifecycle:fn=>lifecycle.subscribe(fn),invoke:async locator=>{calls.push(locator);return {status:"accepted",hostRef:`turn-${calls.length}`};},async *receive(){}};
 return {db,lifecycle,calls,hythes:new Map([[hythe.hytheId,hythe]])};
}
test("execution loss reconciles exact accepted Runs durably without completion or replay",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
 try {
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  const root=runtime.continuations.submit({requestId:"root",originNodeId:"origin",originSessionId:"origin-session",centerNodeId:"worker",workerNodeIds:[],body:"work"});
  await runtime.continuations.pump();assert.equal(f.calls.length,1);
  f.lifecycle.lost("native process exit","worker-exact");
  assert.equal(runtime.continuations.run(root.run.run_id).turn_open,0);
  assert.equal(runtime.continuations.run(root.run.run_id).state,"uncertain");
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(root.task.taskId)?.state,"uncertain");
  assert.equal(f.db.prepare("SELECT host_ref FROM messages WHERE message_id=?").get(root.run.message_id)?.host_ref,"turn-1");
  assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_observations o JOIN events e USING(event_id) WHERE e.kind='runtime.execution_reconciled'").get()?.n,2);
  await runtime.continuations.pump();assert.equal(f.calls.length,1);
  const id="loss-dedupe";const loss={eventId:id,sessionId:"worker-session",source:"test",reason:"exit"};
  assert.deepEqual(reconcileResourceLoss(f.db,loss),reconcileResourceLoss(f.db,loss));
  assert.throws(()=>reconcileResourceLoss(f.db,{...loss,sessionId:"origin-session"}));
 }finally{runtime.close();f.db.close();}
});
test("legacy uncertain observation-only wake can be archived without replay or success claim",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
 try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"task.dispatch",resourceScope:"node/worker"});
  const submitted=runtime.continuations.submit({requestId:"legacy-observation-archive",originNodeId:"worker",originSessionId:"worker-session",
    centerNodeId:"worker",workerNodeIds:[],body:"observation only"});
  f.db.prepare("INSERT INTO runtime_event_tasks VALUES (?,?,?)").run(submitted.task.taskId,"legacy-observation-event","worker");
  f.db.prepare("UPDATE task_runs SET state='uncertain',turn_open=0 WHERE run_id=?").run(submitted.run.run_id);
  f.db.prepare("UPDATE tasks SET state='uncertain' WHERE task_id=?").run(submitted.task.taskId);
  f.db.prepare("UPDATE messages SET state='uncertain',host_ref='legacy-observation-host' WHERE message_id=?").run(submitted.run.message_id);
  const result=archiveLegacyUncertainObservation(f.db,{runId:submitted.run.run_id});
  assert.equal(result.state,"failed");assert.equal(result.businessEffects,"UNKNOWN");assert.equal(result.replay,false);
  assert.equal(f.db.prepare("SELECT state FROM task_runs WHERE run_id=?").get(submitted.run.run_id)?.state,"failed");
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(submitted.task.taskId)?.state,"failed");
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.legacy_observation_archived'").get()?.n,1);
  assert.equal(f.calls.length,0);
 }finally{runtime.close();f.db.close();}
});
test("legacy terminal SUCCESS with empty body is reconciled as failed without replay or no-effect claim",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
 try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  const submitted=runtime.continuations.submit({requestId:"legacy-empty",originNodeId:"origin",originSessionId:"origin-session",
    centerNodeId:"worker",workerNodeIds:[],body:"legacy work"});
  const runId=submitted.run.run_id,messageId=submitted.run.message_id;
  f.db.prepare("UPDATE messages SET state='observed',host_ref='legacy-host-ref' WHERE message_id=?").run(messageId);
  f.db.prepare("UPDATE task_runs SET state='uncertain',turn_open=0 WHERE run_id=?").run(runId);
  f.db.prepare("UPDATE tasks SET state='uncertain' WHERE task_id=?").run(submitted.task.taskId);
  f.db.prepare("INSERT INTO events VALUES ('legacy-host-usage',NULL,'host.usage',?,?)")
    .run(JSON.stringify({hostKind:"fixture",conversationId:"worker-exact",requestId:"legacy-empty",
      status:"SUCCESS",responseLength:0}),new Date().toISOString());
  const result=reconcileLegacyEmptyTerminal(f.db,{runId,evidenceEventId:"legacy-host-usage"});
  assert.equal(result.state,"failed");assert.equal(result.businessEffects,"UNKNOWN");assert.equal(result.replay,false);
  assert.equal(f.db.prepare("SELECT state FROM task_runs WHERE run_id=?").get(runId)?.state,"failed");
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(submitted.task.taskId)?.state,"failed");
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.legacy_terminal_empty_reconciled'").get()?.n,1);
  assert.equal(f.calls.length,0);
 }finally{runtime.close();f.db.close();}
});
test("correlated Host failure can close Task scheduling while preserving uncertain Effect evidence",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes);
 try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  const submitted=runtime.continuations.submit({requestId:"correlated-failure",originNodeId:"origin",originSessionId:"origin-session",
    centerNodeId:"worker",workerNodeIds:[],body:"work"});
  await runtime.continuations.pump();
  assert.equal(f.calls.length,1);
  const message=f.db.prepare("SELECT host_ref FROM messages WHERE message_id=?").get(submitted.run.message_id) as {host_ref:string};
  await runtime.continuations.ingest("worker-session",{hostRef:message.host_ref,observedMessageId:submitted.run.message_id,body:"provider terminal failure",outcome:"failed"});
  const evidence=f.db.prepare("SELECT event_id FROM events WHERE kind='runtime.host_failure' AND json_extract(payload,'$.runId')=?").get(submitted.run.run_id) as {event_id:string};
  assert.equal(runtime.continuations.run(submitted.run.run_id).state,"uncertain");
  const result=reconcileCorrelatedHostFailure(f.db,{runId:submitted.run.run_id,evidenceEventId:evidence.event_id});
  assert.equal(result.state,"failed");assert.equal(result.effectState,"uncertain");assert.equal(result.replay,false);
  assert.equal(f.db.prepare("SELECT state FROM task_runs WHERE run_id=?").get(submitted.run.run_id)?.state,"failed");
  assert.equal(f.db.prepare("SELECT state FROM effect_attempt_state e JOIN action_attempts a USING(attempt_id) WHERE a.source_message_id=?").get(submitted.run.message_id)?.state,"uncertain");
  assert.equal(f.calls.length,1);
 }finally{runtime.close();f.db.close();}
});

test("supervised Host failure becomes an accountable failed round without replay",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
 try{
  const world=recordWorld(f.db,"nodes","origin");
  const supervisionId=openSupervision(f.db,{worldId:world,chiefNodeId:"origin",goal:"Verify worker",
    acceptanceCriteria:"Worker returns exact evidence",maxRounds:3});
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  const submitted=runtime.continuations.submit({requestId:"supervised-failure",originNodeId:"origin",originSessionId:"origin-session",
    centerNodeId:"worker",workerNodeIds:[],body:"work"});
  linkTaskToSupervision(f.db,{supervisionId,taskId:submitted.task.taskId,agentNodeId:"worker"});
  await runtime.continuations.pump();
  const message=f.db.prepare("SELECT host_ref FROM messages WHERE message_id=?").get(submitted.run.message_id) as {host_ref:string};
  await runtime.continuations.ingest("worker-session",{hostRef:message.host_ref,observedMessageId:submitted.run.message_id,
    body:"provider overloaded",outcome:"failed"});
  assert.equal(runtime.continuations.run(submitted.run.run_id).state,"uncertain");
  const view=supervisionView(f.db,supervisionId);
  assert.equal(view.state,"awaiting_decision"); assert.equal(view.awaitingDecisionRound,1);
  const round=f.db.prepare("SELECT task_id,result_message_id,state FROM supervision_rounds WHERE supervision_id=? AND round_index=1").get(supervisionId) as any;
  assert.equal(round.task_id,submitted.task.taskId); assert.equal(round.result_message_id,null); assert.equal(round.state,"awaiting_decision");
  const ev=f.db.prepare("SELECT payload FROM events WHERE kind='supervision.round_failed'").get() as {payload:string};
  const payload=JSON.parse(ev.payload);
  assert.equal(payload.taskId,submitted.task.taskId); assert.equal(payload.runId,submitted.run.run_id);
  assert.equal(payload.state,"uncertain"); assert.equal(payload.effectState,"uncertain"); assert.equal(payload.targetNodeId,"origin");
  assert.equal(payload.replay,false); assert.equal(f.calls.length,1);
 }finally{runtime.close();f.db.close();}
});
test("only committed world changes publish; revoked production Authority stays zero with C retained",async()=>{
 const f=fixture();await Promise.resolve();const observed:string[]=[];const stop=onCommittedEvent(f.db,id=>observed.push(id));
 try {
  assert.throws(()=>withTransaction(f.db,"rollback_event",()=>{f.db.prepare("INSERT INTO events VALUES ('rollback',NULL,'human.message','{}','now')").run();throw Error("abort");}));
  await Promise.resolve();assert.deepEqual(observed,[]);
  const grant=issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"glm",capability:"project.source.read",resourceScope:"project/sidera/source/**"});
  setAuthorityConstraint(f.db,{kind:"human",id:"fixture"},{constraintId:"production-zero",subjectNodeId:"glm",resourceScope:"project/sidera/source/**",reason:"Human trust policy",active:true});
  assert.throws(()=>reserveCapability(f.db,{subjectNodeId:"glm",sessionId:"glm-session",requestId:"production",capability:"project.source.read",resource:"project/sidera/source/core/rpc.ts"}),{code:"denied"});
  assert.ok(grant.grantId);assert.ok(f.hythes.get("host")!.manifest!().operations.some(o=>o.supported));
  assert.ok(reserveCapability(f.db,{subjectNodeId:"glm",sessionId:"glm-session",requestId:"synthetic",capability:"self.workspace.read",resource:"node/glm/workspace/fixture"}).grantId);
  assert.throws(()=>f.db.prepare("INSERT INTO sovereign_memory VALUES ('glm','legacy','{}','now')").run(),/read-only/);
  assert.throws(()=>f.db.prepare("UPDATE node_identity SET self_state='{}changed' WHERE node_id='glm'").run(),/read-only/);
 }finally{stop();f.db.close();}
});
test("historical uncertain observation wakes do not block fresh real work on the same Session",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
 try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  const old=runtime.continuations.submit({requestId:"old-observation",originNodeId:"origin",originSessionId:"origin-session",
    centerNodeId:"worker",workerNodeIds:[],body:"observation only"});
  f.db.prepare("INSERT INTO runtime_event_tasks VALUES (?,?,?)").run(old.task.taskId,"old-event","worker");
  f.db.prepare("UPDATE task_runs SET state='uncertain',turn_open=0 WHERE run_id=?").run(old.run.run_id);
  f.db.prepare("UPDATE tasks SET state='uncertain' WHERE task_id=?").run(old.task.taskId);
  f.db.prepare("UPDATE messages SET state='uncertain',host_ref='old-observation-host' WHERE message_id=?").run(old.run.message_id);
  const fresh=runtime.continuations.submit({requestId:"fresh-real",originNodeId:"origin",originSessionId:"origin-session",
    centerNodeId:"worker",workerNodeIds:[],body:"fresh real work"});
  await runtime.continuations.pump();
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0],"worker-exact");
  assert.equal(runtime.continuations.run(fresh.run.run_id).turn_open,1);
  assert.equal(runtime.continuations.run(old.run.run_id).state,"uncertain");
 }finally{runtime.close();f.db.close();}
});
test("semantic routing enforces exact Node/Session and safe read failover cannot replay uncertain writes",async()=>{
 const f=fixture();
 try {
  const own=await invokeCapability(f.db,f.hythes,{nodeId:"worker",sessionId:"worker-session"},{requestId:"self",targetNodeId:"worker",operation:"session.inspect",input:{}});
  assert.equal(own.targetSessionId,"worker-session");
  await assert.rejects(invokeCapability(f.db,f.hythes,{nodeId:"origin",sessionId:"origin-session"},{requestId:"deny",targetNodeId:"worker",operation:"session.inspect",input:{}}),{code:"denied"});
  const calls:string[]=[];
  const routes=[{id:"native",routeClass:"native" as const,logicalLocator:"exact",invoke:async()=>{calls.push("native");throw Error("lost");}},
    {id:"fallback",routeClass:"ui-fallback" as const,logicalLocator:"exact",invoke:async()=>{calls.push("fallback");return {status:"host_confirmed"};}}];
  assert.equal((await effectAwareRoute("conversation.read","exact",routes)).status,"PASS");assert.deepEqual(calls,["native","fallback"]);
  calls.length=0;assert.equal((await effectAwareRoute("conversation.send","exact",routes)).status,"UNCERTAIN");assert.deepEqual(calls,["native"]);
  calls.length=0;assert.equal((await effectAwareRoute("conversation.read","different",routes)).status,"HOST_UNAVAILABLE");assert.equal(calls.length,0);
 }finally{f.db.close();}
});
test("production architecture has one task writer, one tool catalog and no Host branches or logical polling",()=>{
 const rpc=readFileSync(new URL("../core/rpc.ts",import.meta.url),"utf8"),service=readFileSync(new URL("../core/service.ts",import.meta.url),"utf8");
 assert.equal((rpc.match(/continuations\.submit\(/g)??[]).length,2); // Chief preflight and normal caller share this same writer.
 assert.doesNotMatch(rpc,/runtime\.dispatch\(|delegateTask\(|runtime\.complete\(/);
 assert.doesNotMatch(service,/astra|grok|dsh|zcode|antigravity|dispatch_to_astra/i);
 for(const file of ["runtime","continuations","service"]) {
   const source=readFileSync(new URL('../core/'+file+'.ts',import.meta.url),'utf8');
   assert.doesNotMatch(source,/setInterval\s*\(|setTimeout\s*\(/);
  }
  const probe=readFileSync(new URL('../core/host-health.ts',import.meta.url),'utf8');
  assert.doesNotMatch(probe,/setInterval\s*\(|invoke\(|createSession\(/);
  assert.equal((probe.match(/setTimeout\s*\(/g)??[]).length,1);
  assert.match(probe,/setTimeout\s*\(\s*\(\)\s*=>\s*resolve\("TIMEOUT"\)\s*,\s*timeoutMs\s*\)/);assert.match(probe,/clearTimeout\(timer\)/);
  const names=canonicalToolNames();assert.equal(new Set(names).size,names.length);assert.ok(names.includes("chief_dispatch_status"));assert.ok(names.includes("capability_invoke"));assert.ok(!names.includes("dispatch_to_astra"));
 const server=canonicalMcpServer({token:"fixture",port:0});assert.deepEqual(registeredToolNames(server),names);void server.close();
 const identity=readFileSync(new URL("../core/identity.ts",import.meta.url),"utf8");assert.doesNotMatch(identity,/INSERT INTO sovereign_memory/);
});

test("a real killed Core child is settled by its external owner witness, never replayed",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sidera-owner-"));
 const child=launchCore(root,fileURLToPath(new URL("./fixtures/core-owner.ts",import.meta.url)),["ignore","pipe","pipe","ipc"]);
 const receipt=await new Promise<{runId:string;taskId:string}>((resolve,reject)=>{child.once("message",value=>resolve(value as any));child.once("error",reject);child.once("exit",()=>reject(Error("Child exited before readiness")));});
 const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));child.kill("SIGKILL");await closed;
 const db=openDatabase(join(root,".sidera-dev","sol","data","sidera.sqlite"));
 try{
  assert.deepEqual({...db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id=?").get(receipt.runId)}, {state:"uncertain",turn_open:0});
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE kind='task'").get()?.n,1);
  assert.equal(db.prepare("SELECT state FROM execution_owners").get()?.state,"exited");
  assert.equal(db.prepare("SELECT count(*) n FROM runtime_reconciliations").get()?.n,1);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test("Node seven is configured once; authorized Session handoff preserves Node and sovereign identity",async()=>{
 const f=fixture();
 try{
  const spec={nodeId:"seventh",displayName:"Node seven",sessionId:"seven-session",locatorRef:"seven-exact",hytheId:"host",hostKind:"codex-app-server",options:{},coreToken:"synthetic"};
  reconcileSpecs(f.db,[spec],f.hythes);
  const before=f.db.prepare("SELECT * FROM node_subjectivity WHERE node_id='seventh'").get();
  f.db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,'running',NULL,'now')")
    .run("origin-follows-node","origin-follows-node","seventh","worker","[]");
  f.db.prepare("INSERT INTO task_origins VALUES (?,?)").run("origin-follows-node","seven-session");
  const registry=new Registry(f.db,{authorize:()=>true,getHythe:id=>f.hythes.get(id)});
  const context={actorNodeId:"seventh",requestId:"handoff",resourceScope:"node/seventh"};
  const next=await registry.bindSession({...context,requestId:"new"},{nodeId:"seventh",hytheId:"host",hostKind:"codex-app-server",locatorRef:"seven-new"});
  await registry.handoffSession(context,"seventh",next.sessionId,"seven-session");
  reconcileSpecs(f.db,[spec],f.hythes);assert.equal(spec.sessionId,next.sessionId);
  assert.equal(f.db.prepare("SELECT session_id FROM task_origins WHERE task_id='origin-follows-node'").get()?.session_id,next.sessionId);
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='task.origin_session_handoff'").get()?.n,1);
  assert.deepEqual(f.db.prepare("SELECT * FROM node_subjectivity WHERE node_id='seventh'").get(),before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM nodes WHERE node_id='seventh'").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='session.handoff'").get()?.n,1);
 }finally{f.db.close();}
});

test("a distinct replacement container preserves an uncertain Task and cannot replay its activation intent",async()=>{
 const f=fixture(),runtime=new CoreRuntime(f.db,f.hythes,undefined,{observationOnly:true});
 try{
  const actor={nodeId:"worker",sessionId:"worker-session"};
  new IdentityStore(f.db).bindModel(actor,"initial",{provider:"fixture",modelId:"verified"});
  const world=recordWorld(f.db,"nodes","worker"),store=new SemanticStore(f.db,world);
  const human=store.createHuman("fixture human","test"),identity=store.addExternalIdentity(human,"fixture","fixture-account","test");
  f.db.prepare("INSERT INTO presence_accounts VALUES (?,?,?,'bound')").run(actor.sessionId,world,identity);
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  const old=runtime.continuations.submit({requestId:"original",originNodeId:"origin",originSessionId:"origin-session",centerNodeId:"worker",workerNodeIds:[],body:"original effect"});
  await runtime.continuations.pump();runtime.resourceLost(actor.sessionId,"owner gone","test");
  const h=f.hythes.get("host")!;let created=0;
  h.canReplaceLostSession=()=>true;h.createSession=async()=>{created++;return "distinct-locator";};h.modelBinding=()=>({provider:"fixture",modelId:"verified"});
  const spec={nodeId:"worker",displayName:"worker",sessionId:actor.sessionId,locatorRef:"worker-exact",hytheId:"host",hostKind:"codex-app-server",options:{},coreToken:"fixture",recoverLostSession:true};
  assert.equal(await activateLostSession(f.db,spec,guardMocks(f.hythes).get("host")!),true);assert.notEqual(spec.sessionId,actor.sessionId);
  assert.equal(f.db.prepare("SELECT identity_id FROM presence_accounts WHERE session_id=?").get(spec.sessionId)?.identity_id,identity);
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='session.identity_continued' AND json_extract(payload,'$.toSessionId')=?").get(spec.sessionId)?.n,1);
  const original=runtime.continuations.run(old.run.run_id);assert.equal(original.session_id,actor.sessionId);assert.equal(original.state,"uncertain");
  assert.equal(f.calls.length,1);assert.equal(created,1);
  await assert.rejects(activateLostSession(f.db,{...spec,sessionId:actor.sessionId,locatorRef:"worker-exact"},h),{code:"uncertain"});assert.equal(created,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n,1);
 }finally{runtime.close();f.db.close();}
});

test("a second service owner is refused before database recovery writes",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sidera-owner-cas-")),data=join(root,".sidera-dev","sol","data"),server=createServer(socket=>socket.end());
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));mkdirSync(data,{recursive:true});
 const port=(server.address() as {port:number}).port;
 writeFileSync(join(data,"runtime-spec.json"),JSON.stringify({version:1,corePort:port,nodes:[]}));
 try{await assert.rejects(startLocalService(root),/Existing Core listener/);assert.equal(existsSync(join(data,"sidera.sqlite")),false);}
 finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 try{
  writeFileSync(join(data,"runtime-spec.json"),JSON.stringify({version:1,corePort:port,nodes:[{hostKind:"missing-adapter"}]}));
  await assert.rejects(startLocalService(root),/Host adapter missing/);
  const db=openDatabase(join(data,"sidera.sqlite"));
  try{
   assert.equal(db.prepare("SELECT state FROM execution_owners").get()?.state,"exited");
   db.prepare("INSERT INTO execution_owners VALUES ('initializing',?,'active','now')").run(process.pid);
  }finally{db.close();}
  await assert.rejects(startLocalService(root),/Existing live Core owner/);
  const preserved=openDatabase(join(data,"sidera.sqlite"));
  try{assert.equal(preserved.prepare("SELECT state FROM execution_owners WHERE owner_id='initializing'").get()?.state,"active");}
  finally{preserved.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("event batches survive an atomic unsent wake handoff without waking on their own retirement",async()=>{
 const f=fixture(),h=f.hythes.get("host")!;
 let created=0;h.canStartTurn=()=>true;h.prepareWake=async()=>`fresh-${++created}`;
 const basis=fixtureBasis(f.db,"worker"),at=new Date().toISOString();
 f.db.prepare("UPDATE responsibilities SET accepted_at=? WHERE responsibility_id=?").run(at,basis.responsibilityId);
 const world=recordWorld(f.db,"nodes","worker"),store=new SemanticStore(f.db,world);
 const human=store.createHuman("wake owner","test"),identity=store.addExternalIdentity(human,"fixture","wake-account","test");
 f.db.prepare("INSERT INTO presence_accounts VALUES (?,?,?,'bound')").run("worker-session",world,identity);
 const runtime=new CoreRuntime(f.db,f.hythes,undefined,{initialReady:false});
 runtime.continuations.prepareWake=sessionStrategy(f.db,guardMocks(f.hythes),async()=>{});
 try{
  f.db.prepare("INSERT INTO sessions VALUES ('historical','worker','host','codex-app-server','historical-exact','retired','now')").run();
  mutateTension(f.db,{nodeId:"worker",sessionId:"worker-session"},{requestId:"tension",kind:"coordination",statement:"Review actual observations"});
  for(const id of ["one","two"])f.db.prepare("INSERT INTO events VALUES (?,NULL,'human.message',?,?)")
   .run(id,JSON.stringify({targetNodeId:"worker",responsibilityId:basis.responsibilityId}),new Date().toISOString());
  await new Promise<void>(resolve=>setImmediate(resolve));
  runtime.ready=true;await runtime.continuations.wakeObservations();
  await new Promise<void>(resolve=>setImmediate(resolve));
  const run=f.db.prepare("SELECT * FROM task_runs").get() as any;
  assert.equal(created,1);assert.equal(f.calls.length,1);assert.equal(run.state,"running");assert.equal(run.turn_open,1);
  assert.notEqual(run.session_id,"worker-session");
  assert.equal(f.db.prepare("SELECT identity_id FROM presence_accounts WHERE session_id=?").get(run.session_id)?.identity_id,identity);
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='session.identity_continued'").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_observations WHERE state='admitted' AND event_id IN ('one','two')").get()?.n,2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.resource_lost'").get()?.n,0);
  assert.equal(f.db.prepare("SELECT 1 FROM session_health WHERE session_id='historical'").get(),undefined);
  assert.equal(f.db.prepare("SELECT state FROM session_health WHERE session_id=?").get(run.session_id)?.state,"available");
  await runtime.ingest(run.session_id,{observedMessageId:run.message_id,hostRef:"turn-1",outcome:"completed",body:"Observation reviewed"});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.db.prepare("SELECT state FROM tasks").get()?.state,"completed");assert.equal(f.calls.length,1);
  runtime.resourceLost(run.session_id,"native exit","test");runtime.resourceLost(run.session_id,"same exit observed again","test");
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.resource_lost'").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_observations WHERE state='queued' AND event_id IN (SELECT event_id FROM events WHERE kind='runtime.resource_lost')").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n,1);
 }finally{runtime.close();f.db.close();}
});

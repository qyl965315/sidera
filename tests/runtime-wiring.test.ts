import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {openDatabase} from "../core/db.ts";
import {recordWorld} from "../core/worlds.ts";
import {recordFrontendPresence} from "../core/frontend-presence.ts";
import {latestFrontendRoute,selectRoute} from "../core/frontend-route.ts";
import {HumanBoundary,type HumanRoute} from "../hythes/human-boundary.ts";
import {frontendFactory} from "../hythes/frontend-factory.ts";
import {bindChiefConversation,handoffChiefConversation,ChiefDispatch} from "./fixtures/chief.ts";
import {CoreRuntime,mockProfile,fixtureBasis} from "./fixtures/execution.ts";
import {issueGrant} from "./fixtures/authority.ts";
import {getMessage} from "./fixtures/bus.ts";
import {CoreRpcServer} from "../core/rpc.ts";
import {callCore} from "../hythes/core-client.ts";
import {hostManifest} from "../hythes/manifest.ts";
import {captureBuildIdentity} from "../core/build-identity.ts";
import {supervisionView,decideSupervision} from "../core/supervision.ts";
import {boundaryEvent} from "../core/boundary.ts";
import type {Hythe} from "../hythes/types.ts";

function fixture(file=":memory:") {
 const db=openDatabase(file);
 for(const id of ["chief","worker","reviewer"]){db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id,id,new Date().toISOString());db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','test',?,'active',?)").run(id+"-session",id,id+"-locator",new Date().toISOString());}
 const binding=bindChiefConversation(db,{kind:"human",id:"fixture"},{projectSpaceId:"space",projectRef:"test",chiefNodeId:"chief",frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/exact"});
 const world=recordWorld(db,"nodes","chief"),presented:unknown[]=[],calls:Array<{locator:string;input:any;hostRef:string}>=[];
 const route=(id:string,routeClass:HumanRoute["routeClass"],available=true):HumanRoute=>({id,routeClass,requirementSatisfied:()=>available,effectProfile:()=>mockProfile,
  manifest:hostManifest({hytheId:id,hostKind:"fixture"},{operations:["conversation.locate","conversation.send","conversation.observe"],routeClass,createsSession:false}),
  async invoke(op,b,input,boundary){if(op==="conversation.send")return boundary!.cross({product:b.frontendKind,locator:b.conversationRef,operation:op},()=>{presented.push(input);return {status:"accepted",hostRef:"presentation"};});if(op==="conversation.observe")return {status:"host_confirmed",data:{turns:[{items:presented.map((value:any)=>({type:"userMessage",id:value.messageId,content:[{text:value.body}]}))}]}};return {status:"host_confirmed",data:{located:true,conversationRef:b.conversationRef}};}});
 const presence=(evidenceClass:"TRANSPORT_POLL"|"ROUTE_VERIFIED"|"UI_ROUTE_VERIFIED")=>recordFrontendPresence(db,{worldId:world,bindingId:binding.bindingId,conversationRef:binding.conversationRef,evidenceClass,evidenceRef:"fixture:"+evidenceClass,method:"fixture"});
 let browserCalls=0;
 const frontend=new HumanBoundary(db,[route("native","native"),{...route("historical-ui","ui-fallback"),invoke:async()=>{browserCalls++;throw Error("Browser forbidden");}}]);
 const hythe:Hythe={hytheId:"fixture",hostKind:"test",capabilities:()=>["message.receive"],canStartTurn:()=>true,locate:async()=>true,async *receive(){},invoke:async(locator,_c,input)=>{const hostRef="turn-"+calls.length;calls.push({locator,input,hostRef});return {status:"accepted",hostRef};}};
 const hythes=new Map([["fixture",hythe]]),runtime=new CoreRuntime(db,hythes),chief=new ChiefDispatch(db,hythes,frontend);
 runtime.reviewRootResult=(...args)=>chief.review(...args);
 const rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:token=>["chief","worker","reviewer"].includes(token)?{kind:"node",nodeId:token,sessionId:token+"-session"}:null},undefined,undefined,chief);
 const finish=async(run:any,body:string)=>{const message=getMessage(db,run.message_id);await runtime.ingest(run.session_id,{hostRef:message.hostRef!,observedMessageId:message.messageId,body,outcome:"completed"});};
 return {db,world,binding,frontend,presence,route,presented,runtime,chief,rpc,finish,calls,close:async()=>{chief.close();runtime.close();await rpc.close();await frontend.close();db.close();assert.equal(browserCalls,0,"Startup, handoff and supervised continuation must not invoke UI");}};
}
test("Production lifecycle rejects UI-only/poll/UI evidence; unavailable native/protocol never launch browser",async()=>{
 const f=fixture();try{
  let browser=0;const ui={...f.route("ui","ui-fallback"),invoke:async()=>{browser++;throw Error("Browser forbidden");}};
  assert.equal(selectRoute([{routeId:"ui",routeClass:"ui-fallback",supportsSend:true,controlProfile:mockProfile}]),null);
  for(const evidence of ["TRANSPORT_POLL","UI_ROUTE_VERIFIED"] as const){f.presence(evidence);assert.equal(f.frontend.prepare(f.binding).prepared,false);}
  f.presence("ROUTE_VERIFIED");
  for(const routes of [[ui],[f.route("native","native",false),ui],[f.route("protocol","protocol",false),ui]]){
   const boundary=new HumanBoundary(f.db,routes);assert.equal(boundary.prepare(f.binding).prepared,false);assert.equal((await boundary.verifyPresence(f.binding)).prepared,false);
   assert.equal((await boundary.inspect(f.binding)).ready,false);
  }
  const historical=await frontendFactory(f.db,process.cwd(),{kind:"chatgpt-ui",options:{}});
  assert.equal((await historical.verifyPresence!(f.binding)).prepared,false);assert.equal(browser,0);
  const unproved={...f.route("unproved","native"),requirement:"authenticated executor",requirementSatisfied:undefined,
   invoke:async()=>{throw Error("Unproved route must not be invoked");}};
  const missingProof=new HumanBoundary(f.db,[unproved,ui]);
  assert.equal(missingProof.prepare(f.binding).prepared,false);
  assert.equal((await missingProof.verifyPresence(f.binding)).prepared,false);
  assert.equal((await missingProof.inspect(f.binding)).ready,false);
 }finally{await f.close();}
});
test("Startup preparation is explicit; status only probes exact Host health; handoff invalidates old route without inheriting Presence",async()=>{
 const f=fixture();try{
  assert.equal(f.frontend.prepare(f.binding).prepared,false);
  assert.equal((await f.chief.prepareFrontend("chief")).prepared,true);
  const before=f.db.prepare("SELECT count(*) n FROM events").get()!.n,preps=f.db.prepare("SELECT count(*) n FROM frontend_route_preparations").get()!.n;
  await f.chief.status({nodeId:"chief",sessionId:"chief-session"});
  const observations=f.db.prepare("SELECT kind FROM events ORDER BY rowid LIMIT -1 OFFSET ?").all(before);
  assert.ok(observations.length>0);assert.ok(observations.every(e=>e.kind==="host.health.observed"));
  assert.equal(f.calls.length,0,"Host status never starts an Agent turn");
  assert.equal(f.db.prepare("SELECT count(*) n FROM frontend_route_preparations").get()!.n,preps);
  const bound=handoffChiefConversation(f.db,{kind:"human",id:"fixture"},{requestId:"handoff",expectedBindingId:f.binding.bindingId,conversationRef:"https://chatgpt.com/c/new-exact"});
  assert.equal(latestFrontendRoute(f.db,{worldId:f.world,bindingId:f.binding.bindingId}).state,"STALE");
  assert.equal(f.frontend.prepare(bound).prepared,false);
  await new Promise<void>(r=>setImmediate(r)); // committed handoff lifecycle authenticates new exact binding
  assert.equal(latestFrontendRoute(f.db,{worldId:f.world,bindingId:bound.bindingId}).state,"USABLE");
  assert.equal(f.db.prepare("SELECT count(*) n FROM chief_conversations").get()!.n,2);
 }finally{await f.close();}
});
test("Real RPC supervision dispatch links Task; event REWORK creates next round; ACCEPT presents exactly once; restart preserves it",async()=>{
 const file=join(mkdtempSync(join(tmpdir(),"sidera-wiring-")),"test.sqlite"),f=fixture(file);
 try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/worker"});
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"message.send",resourceScope:"node/chief"});
  await f.chief.prepareFrontend("chief");const core={port:await f.rpc.listen(0),token:"chief"};
  const open=await callCore(core,"supervision.open",{requestId:"open",goal:"ACK nonce",acceptanceCriteria:"exact ACK nonce",maxRounds:2}) as any;
  const one=await callCore(core,"task.submit",{requestId:"one",centerNodeId:"worker",body:"wrong ACK",supervisionId:open.supervisionId}) as any;
  await f.runtime.continuations.pump();await f.finish(one.run,"wrong ACK");
  assert.equal(supervisionView(f.db,open.supervisionId).awaitingDecisionRound,1);assert.equal(f.presented.length,0);
  const decision={supervisionId:open.supervisionId,roundIndex:1,decision:"REWORK",reason:"nonce incorrect",instruction:"Reply exact ACK nonce"};
  await callCore(core,"supervision.decide",decision);
  await new Promise<void>(r=>setImmediate(r));await f.runtime.continuations.pump();
  assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()!.n,2);assert.equal(f.presented.length,0);
  assert.equal((await callCore(core,"supervision.decide",decision) as any).replay,true);
  await assert.rejects(callCore(core,"supervision.decide",{...decision,instruction:"Different work"}),/conflict/);
  const two=f.db.prepare("SELECT r.* FROM task_runs r JOIN tasks t USING(task_id) WHERE t.request_id=?").get(`supervision:${open.supervisionId}:2`)!;
  await f.finish(two,"ACK nonce");
  await callCore(core,"supervision.decide",{supervisionId:open.supervisionId,roundIndex:2,decision:"ACCEPT",reason:"Exact nonce matched"});
  assert.equal(f.presented.length,1);assert.match(String((f.presented[0] as any).body),/Exact nonce matched/);assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='HumanPresentationRequested'").get()!.n,1);
  assert.equal(supervisionView(f.db,open.supervisionId).state,"completed");
  await f.close();const restored=openDatabase(file);try{assert.equal(supervisionView(restored,open.supervisionId).state,"completed");assert.equal(restored.prepare("SELECT count(*) n FROM supervision_tasks").get()!.n,2);}finally{restored.close();}
 }finally{if(f.db.isOpen)await f.close();}
});
test("Decision replay compares instruction; unauthorized budget mutation is denied",async()=>{
 const f=fixture();try{
  const core={port:await f.rpc.listen(0),token:"chief"};const open=await callCore(core,"supervision.open",{requestId:"open-budget",goal:"test",acceptanceCriteria:"test",maxRounds:1}) as any;
  assert.throws(()=>decideSupervision(f.db,{supervisionId:open.supervisionId,roundIndex:2,decision:"REWORK",reason:"wrong actor",actor:{kind:"node",nodeId:"worker"}}),{code:"denied"});
  assert.equal(supervisionView(f.db,open.supervisionId).state,"running");
 }finally{await f.close();}
});

test("An observed legacy draft can be corrected from the immutable final decision once without another Task or Run",async()=>{
 const f=fixture();try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/worker"});
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"message.send",resourceScope:"node/chief"});
  await f.chief.prepareFrontend("chief");const core={port:await f.rpc.listen(0),token:"chief"};
  const open=await callCore(core,"supervision.open",{requestId:"correct-open",goal:"Inspect",acceptanceCriteria:"completed",maxRounds:1}) as any;
  const task=await callCore(core,"task.submit",{requestId:"correct-task",centerNodeId:"worker",body:"inspect",supervisionId:open.supervisionId}) as any;
  await f.runtime.continuations.pump();await f.finish(task.run,"In-flight Worker snapshot");
  const present=f.chief.present.bind(f.chief);f.chief.present=async()=>{};
  await callCore(core,"supervision.decide",{supervisionId:open.supervisionId,roundIndex:1,decision:"ACCEPT",reason:"Supervisor confirmed completed"});
  f.chief.present=present;
  // A stored request from the legacy kernel chose the Worker draft.
  const row=f.db.prepare("SELECT event_id,payload FROM events WHERE kind='HumanPresentationRequested'").get()!,old=JSON.parse(String(row.payload));
  f.db.prepare("UPDATE events SET payload=? WHERE event_id=?").run(JSON.stringify({...old,body:"In-flight Worker snapshot"}),row.event_id);
  await present(old.messageId);assert.equal(f.presented.length,1);
  f.db.prepare("UPDATE chief_presentations SET state='uncertain' WHERE message_id=?").run(old.messageId);
  await assert.rejects(callCore(core,"chief.presentation_correct",{supervisionId:open.supervisionId}),/reconcile/);
  f.db.prepare("UPDATE chief_presentations SET state='delivered' WHERE message_id=?").run(old.messageId);
  const correction=await callCore(core,"chief.presentation_correct",{supervisionId:open.supervisionId}) as any;
  assert.notEqual(correction.messageId,old.messageId);assert.equal(f.presented.length,2);
  assert.match(String((f.presented[1] as any).body),/Supervisor confirmed completed/);
  assert.equal((await callCore(core,"chief.presentation_correct",{supervisionId:open.supervisionId}) as any).messageId,correction.messageId);
  await f.chief.recoverRequests();assert.equal(f.presented.length,2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()?.n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM task_runs").get()?.n,1);
  assert.equal(f.db.prepare("SELECT kind FROM messages WHERE message_id=?").get(correction.messageId)?.kind,"human-presentation");
  assert.equal(f.db.prepare("SELECT state FROM messages WHERE message_id=?").get(correction.messageId)?.state,"observed");
 }finally{await f.close();}
});

test("A rejected next worker is returned to the Supervisor; a new authorized choice preserves the review and is not duplicated on recovery",async()=>{
 const f=fixture();try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/worker"});
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"message.send",resourceScope:"node/chief"});
  await f.chief.prepareFrontend("chief");const core={port:await f.rpc.listen(0),token:"chief"};
  const open=await callCore(core,"supervision.open",{requestId:"fallback-open",goal:"Inspect then review",acceptanceCriteria:"two rounds",maxRounds:2}) as any;
  const one=await callCore(core,"task.submit",{requestId:"fallback-one",centerNodeId:"worker",body:"inspect",supervisionId:open.supervisionId}) as any;
  await f.runtime.continuations.pump();await f.finish(one.run,"round one completed");
  const decision=await callCore(core,"supervision.decide",{supervisionId:open.supervisionId,roundIndex:1,decision:"CONTINUE",
   reason:"Need verification",instruction:"Independently verify",nextNodeId:"reviewer"}) as any;
  assert.equal(decision.nextRound.state,"blocked");assert.equal(decision.nextRound.taskCreated,false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()?.n,1);assert.equal(f.presented.length,0);
  const alternative=await callCore(core,"task.submit",{requestId:"fallback-new-choice",centerNodeId:"worker",body:"Verify with disclosed same-worker limit",supervisionId:open.supervisionId}) as any;
  assert.ok(alternative.task.taskId);await f.chief.recoverRequests();
  assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()?.n,2);
  assert.equal(supervisionView(f.db,open.supervisionId).lastDecision?.decision,"CONTINUE");
 }finally{await f.close();}
});

test("An exact owned observation wake can start supervised work without becoming its parent dependency",async()=>{
 const f=fixture();try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/worker"});
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"message.send",resourceScope:"node/chief"});
  await f.chief.prepareFrontend("chief");const core={port:await f.rpc.listen(0),token:"chief"},basis=fixtureBasis(f.db,"chief");
  f.db.prepare("UPDATE responsibilities SET accepted_at=? WHERE responsibility_id=?").run(new Date().toISOString(),basis.responsibilityId);
  const wake=f.runtime.continuations.submit({requestId:"observation",originNodeId:"chief",originSessionId:"chief-session",
   centerNodeId:"chief",workerNodeIds:[],body:"world_observation",basis,authorityCapability:"self.task.resume"});
  f.db.prepare("INSERT INTO runtime_event_tasks VALUES (?,?,?)").run(wake.task.taskId,"fixture-event","chief");
  await f.runtime.continuations.pump();
  const open=await callCore(core,"supervision.open",{requestId:"wake-supervision",responsibilityId:basis.responsibilityId,
   goal:"Inspect actual work",acceptanceCriteria:"Review result",maxRounds:2}) as any;
  const result=await callCore(core,"task.dispatch",{requestId:"owned-root",centerNodeId:"worker",body:"read only",
   supervisionId:open.supervisionId,parentRunId:wake.run.run_id,checkpoint:"observation wake",basis}) as any;
  assert.ok(result.task?.taskId);assert.equal(f.db.prepare("SELECT count(*) n FROM task_dependencies").get()?.n,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()?.n,1);
  assert.equal(f.runtime.continuations.run(wake.run.run_id).state,"running");
 }finally{await f.close();}
});
test("WAIT advances only on the named relevant event; budget prevents an extra Task and presentation",async()=>{
 const f=fixture();try{
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/worker"});
  issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"message.send",resourceScope:"node/chief"});
  await f.chief.prepareFrontend("chief");const core={port:await f.rpc.listen(0),token:"chief"};
  const open=await callCore(core,"supervision.open",{requestId:"wait-open",goal:"wait fixture",acceptanceCriteria:"event fixture",maxRounds:2}) as any;
  const one=await callCore(core,"task.submit",{requestId:"wait-one",centerNodeId:"worker",body:"wait fixture",supervisionId:open.supervisionId}) as any;
  await f.runtime.continuations.pump();await f.finish(one.run,"Needs dependency");
  await callCore(core,"supervision.decide",{supervisionId:open.supervisionId,roundIndex:1,decision:"WAIT",reason:"await worker health",instruction:"Inspect recovered dependency",waitForEvent:"host.health.changed"});
  boundaryEvent(f.db,null,"host.health.changed",{targetNodeId:"unrelated"});await new Promise<void>(r=>setImmediate(r));
  assert.equal(supervisionView(f.db,open.supervisionId).state,"waiting");assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()!.n,1);
  boundaryEvent(f.db,null,"host.health.changed",{targetNodeId:"worker"});await new Promise<void>(r=>setImmediate(r));await f.runtime.continuations.pump();
  assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()!.n,2);
  const two=f.db.prepare("SELECT r.* FROM task_runs r JOIN tasks t USING(task_id) WHERE t.request_id=?").get(`supervision:${open.supervisionId}:2`)!;
  await f.finish(two,"Needs more rounds");await callCore(core,"supervision.decide",{supervisionId:open.supervisionId,roundIndex:2,decision:"CONTINUE",reason:"more investigation",instruction:"One more observation"});
  await new Promise<void>(r=>setImmediate(r));assert.equal(supervisionView(f.db,open.supervisionId).state,"budget_exhausted");
  assert.equal(f.db.prepare("SELECT count(*) n FROM supervision_tasks").get()!.n,2);assert.equal(f.presented.length,0);
 }finally{await f.close();}
});
test("Build identity is captured once and does not change when disk HEAD changes",()=>{
 const root=mkdtempSync(join(tmpdir(),"sidera-build-")),git=(args:string[])=>execFileSync("git",["-C",root,...args],{windowsHide:true,stdio:"ignore"});
 git(["init"]);writeFileSync(join(root,"package.json"),"{}");git(["add","."]);git(["-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-m","one"]);
 const identity=captureBuildIdentity(root,join(root,"state.sqlite"));writeFileSync(join(root,"package.json"),"{\"version\":\"2\"}");git(["add","."]);git(["-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-m","two"]);
 assert.equal(identity.loadedCommit,identity.sourceCommit);assert.notEqual(captureBuildIdentity(root,join(root,"state.sqlite")).sourceCommit,identity.sourceCommit);assert.ok(Object.isFrozen(identity));assert.equal(identity.pid,process.pid);
});

test("Any ordinary Supervisor can choose another reviewer on a subsequent round without a Human Chat",async()=>{
 const f=fixture();try{
  for(const [from,to] of [["worker","reviewer"],["worker","chief"]])issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:from,capability:"task.dispatch",resourceScope:`node/${to}`});
  for(const from of ["reviewer","chief"])issueGrant(f.db,{kind:"human",id:"fixture"},{subjectNodeId:from,capability:"message.send",resourceScope:"node/worker"});
  const core={port:await f.rpc.listen(0),token:"worker"};
  const opened=await callCore(core,"supervision.open",{requestId:"ordinary-open",goal:"review",acceptanceCriteria:"different reviewer agrees",maxRounds:2}) as any;
  const one=await callCore(core,"task.submit",{requestId:"ordinary-first",centerNodeId:"reviewer",body:"first pass",supervisionId:opened.supervisionId}) as any;
  await f.runtime.continuations.pump();await f.finish(one.run,"first report");
  await callCore(core,"supervision.decide",{supervisionId:opened.supervisionId,roundIndex:1,decision:"CONTINUE",reason:"independent review",instruction:"Review first report",nextNodeId:"chief"});
  await new Promise<void>(r=>setImmediate(r));await f.runtime.continuations.pump();
  const next=f.db.prepare("SELECT r.* FROM task_runs r JOIN tasks t USING(task_id) WHERE t.request_id=?").get(`supervision:${opened.supervisionId}:2`)!;
  assert.ok(next);assert.equal(next.session_id,"chief-session");
  await f.finish(next,"review accepted");await callCore(core,"supervision.decide",{supervisionId:opened.supervisionId,roundIndex:2,decision:"ACCEPT",reason:"evidence accepted"});
  assert.equal(supervisionView(f.db,opened.supervisionId).state,"completed");assert.equal(f.presented.length,0,"Internal Supervisor does not invent a Human destination");
 }finally{await f.close();}
});

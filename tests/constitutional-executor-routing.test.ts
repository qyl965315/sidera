import assert from "node:assert/strict";
import {test} from "node:test";
import {openDatabase} from "../core/db.ts";
import {CoreRpcServer} from "../core/rpc.ts";
import {CoreRuntime,mockProfile} from "./fixtures/execution.ts";
import {issueGrant,revokeGrant} from "./fixtures/authority.ts";
import {bindChiefConversation} from "./fixtures/chief.ts";
import {reviewExecutorPolicy,executorPool} from "../core/executors.ts";
import {getTask} from "../core/scheduler.ts";
import {capabilityTruth} from "../core/capability-truth.ts";
import {callCore} from "../hythes/core-client.ts";
import type {Hythe} from "../hythes/types.ts";
import {prepareEffect} from "../core/effect-gate.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";

// Real Core RPC/Authority/Effect/continuation stack; only the external Host is a
// synthetic adapter. The review transcript is explicitly an isolated fixture.
test("canonical RPC reuses admitted standby Executor while default busy and returns exact original Session",async()=>{
 const db=openDatabase(":memory:"),at=new Date().toISOString();
 for(const n of ["reviewer","origin","worker"]){
  db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(n,n,at);
  db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)").run(n+"-default",n,"fixture://"+n,at);
  recordFixtureHostAvailable(db,n+"-default");
 }
 const binding=bindChiefConversation(db,{kind:"human",id:"fixture"},{projectSpaceId:"project",projectRef:"project",chiefNodeId:"reviewer",frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/human-fixture"});
 db.prepare("INSERT INTO sessions VALUES ('worker-extra','worker','fixture','fixture','fixture://worker-extra','standby',?)").run(at);
 recordFixtureHostAvailable(db,'worker-extra');
 const calls:Array<{locator:string;messageId:string}>=[],locates:string[]=[];let crossBoundary=true,profileAvailable=true,receiveSubscriptions=0;
 let closeReceiver:()=>void=()=>{};const receiveLifetime=new Promise<void>(resolve=>{closeReceiver=resolve;});
 const adapter:Hythe & {inspectExactHost:(locator:string)=>Promise<boolean>}={hytheId:"fixture",hostKind:"fixture",capabilities:()=>["message.receive"],effectProfile:()=>profileAvailable?mockProfile:undefined,
  inspectExactHost:async()=>true,
  locate:async locator=>{locates.push(locator);return true;},async *receive(){receiveSubscriptions++;await receiveLifetime;},
  invoke:async(locator,operation,input,_id,boundary)=>{
   const messageId=(input as {messageId:string}).messageId;
   if(!crossBoundary)return {status:"accepted",hostRef:"false-acceptance"};
   return boundary!.cross({product:"fixture",locator,operation},()=>{calls.push({locator,messageId});return {status:"accepted" as const,hostRef:"turn:"+messageId};});
  }};
 const hythes=new Map([["fixture",adapter]]),runtime=new CoreRuntime(db,hythes);
 const rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:token=>{
  if(token==="worker-extra")return {kind:"node",nodeId:"worker",sessionId:"worker-extra"};
  return ["origin","worker","reviewer"].includes(token)?{kind:"node",nodeId:token,sessionId:token+"-default"}:null;
 }});
 try{
  const port=await rpc.listen(0),core={port,token:"origin"};
  const grant=issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"message.send",resourceScope:"node/origin"});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"worker",capability:"task.dispatch",resourceScope:"node/origin"});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"origin",capability:"message.send",resourceScope:"node/worker"});
  await assert.rejects(callCore(core,"task.dispatch",{requestId:"unadmitted",centerNodeId:"worker",targetSessionId:"worker-extra",body:"Must not run"}),/unavailable/);
  assert.equal(calls.length,0);assert.equal(locates.length,0,"Unadmitted context is rejected before Host observation");
  const first=await callCore(core,"task.dispatch",{requestId:"default",centerNodeId:"worker",body:"Hold default context"}) as any;
  assert.equal(first.firstMessage.state,"delivered");assert.equal(first.run.session_id,"worker-default");
  assert.equal(getTask(db,first.task.taskId).task.state,"running","Acceptance does not complete an Agent Task");
  assert.equal(capabilityTruth(db,"worker","worker-default","message.receive").availability,"available");
  assert.equal(executorPool(db,"worker").find(e=>e.runtimeSessionId==="worker-default")?.state,"BUSY");
  // A completed, exact canonical review transcript authorizes only admission of
  // a real registered context; it does not create a Host or grant task.dispatch.
  db.prepare("INSERT INTO tasks VALUES ('review','review','reviewer','reviewer','[]','completed',NULL,?)").run(at);
  db.prepare("INSERT INTO messages VALUES ('review-m','review-request','review','reviewer','reviewer','reviewer-default',1,'task','Review','observed','review-turn',NULL,?)").run(at);
  db.prepare("INSERT INTO task_runs VALUES ('review-r','review','reviewer-default','review-m','completed',0,'',?)").run(at);
  const reason="Default context is busy; admit the exact extra context",marker={bindingId:binding.bindingId,conversationRef:binding.conversationRef,operatorNodeRef:"worker",decision:"open",executorRef:null,reason};
  db.prepare("INSERT INTO messages VALUES ('review-result','result:review-r','review','reviewer','reviewer','reviewer-default',2,'result',?,'observed','result-turn',NULL,?)").run("SIDERA_EXECUTOR_REVIEW_V1\n"+JSON.stringify(marker),at);
  const review=reviewExecutorPolicy(db,{nodeId:"reviewer",sessionId:"reviewer-default"},{requestId:"review-policy",projectRef:"project",operatorNodeRef:"worker",reviewTaskRef:"review",decision:"open",reason});
  profileAvailable=false;
  await assert.rejects(callCore({port,token:"worker"},"executor.admit",{requestId:"admit-no-profile",sessionId:"worker-extra",reviewRef:review.reviewRef}),/Effect profile/);
  assert.equal(executorPool(db,"worker").find(e=>e.runtimeSessionId==="worker-extra")?.state,"UNAVAILABLE");
  profileAvailable=true;
  const admitted=await callCore({port,token:"worker"},"executor.admit",{requestId:"admit",sessionId:"worker-extra",reviewRef:review.reviewRef}) as any;
  assert.equal(admitted.state,"IDLE");assert.equal(db.prepare("SELECT state FROM sessions WHERE session_id='worker-extra'").get()!.state,"standby");
  assert.equal(runtime.receive("worker-extra"),runtime.receive("worker-extra"));assert.equal(receiveSubscriptions,1,"Repeated admission/start never duplicates a Host push subscription");
  revokeGrant(db,{kind:"human",id:"fixture"},{requestId:"withdraw",grantId:grant.grantId});
  await assert.rejects(callCore(core,"task.dispatch",{requestId:"no-authority",centerNodeId:"worker",body:"Must not run"}),/unavailable|denied/);
  assert.equal(calls.length,1,"An admitted Executor confers no cross-Node Authority");
  const restoredGrant=issueGrant(db,{kind:"human",id:"fixture"},{requestId:"restore-dispatch",subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  assert.equal(executorPool(db,"worker").find(e=>e.runtimeSessionId==="worker-extra")?.state,"IDLE",JSON.stringify(executorPool(db,"worker")));
  const second=await callCore(core,"task.dispatch",{requestId:"parallel",centerNodeId:"worker",body:"ACK exact nonce"}) as any;
  assert.equal(second.run.session_id,"worker-extra");assert.equal(second.firstMessage.targetSessionId,"worker-extra");assert.equal(calls[1].locator,"fixture://worker-extra");
  await assert.rejects(runtime.ingest("worker-default",{observedMessageId:second.firstMessage.messageId,hostRef:second.firstMessage.hostRef,outcome:"completed",body:"wrong session"}),/Session|session/);
  const child=await callCore({port,token:"worker-extra"},"task.dispatch",{requestId:"reverse-delegation",centerNodeId:"origin",body:"Return nonce",parentRunId:second.run.run_id,checkpoint:"Waiting for child nonce"}) as any;
  assert.equal(child.run.session_id,"origin-default");
  await runtime.ingest("worker-extra",{observedMessageId:second.firstMessage.messageId,hostRef:second.firstMessage.hostRef,outcome:"completed",body:"Delegated; awaiting child"});
  assert.equal(runtime.continuations.run(second.run.run_id).state,"waiting_dependency");
  await runtime.ingest("origin-default",{observedMessageId:child.firstMessage.messageId,hostRef:child.firstMessage.hostRef,outcome:"completed",body:"Child exact nonce"});
  const continued=db.prepare("SELECT * FROM task_runs WHERE task_id=? AND run_id!=?").get(second.task.taskId,second.run.run_id)!;
  assert.equal(continued.session_id,"worker-extra","Event continuation preserves exact parallel Executor");
  const continuedMessage=getTask(db,second.task.taskId).messages.find(m=>m.messageId===continued.message_id)??getTask(db,child.task.taskId).messages.find(m=>m.messageId===continued.message_id)!;
  assert.equal(continuedMessage.state,"delivered");
  await runtime.ingest("worker-extra",{observedMessageId:continuedMessage.messageId,hostRef:continuedMessage.hostRef!,outcome:"completed",body:"ACK exact nonce"});
  const completed=getTask(db,second.task.taskId),result=completed.messages.find(m=>m.kind==="result")!;
  assert.equal(completed.task.state,"completed");assert.equal(result.body,"ACK exact nonce");assert.equal(result.targetSessionId,"origin-default");assert.equal(result.state,"delivered");
  assert.equal(calls.find(c=>c.messageId===result.messageId)?.locator,"fixture://origin");
  assert.equal(runtime.continuations.run(first.run.run_id).turn_open,1,"Parallel completion never closes the other Executor");
  assert.equal(db.prepare("SELECT count(*) n FROM task_executor_assignments WHERE task_ref=?").get(second.task.taskId)!.n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM nodes").get()!.n,3,"Executor admission never creates a Node");
  const queued=runtime.continuations.submit({requestId:"queued-before-revoke",originNodeId:"origin",originSessionId:"origin-default",centerNodeId:"worker",workerNodeIds:[],body:"Authority can change before final send"});
  revokeGrant(db,{kind:"human",id:"fixture"},{requestId:"withdraw-before-effect",grantId:restoredGrant.grantId});
  await runtime.continuations.pump();
  assert.equal(getTask(db,queued.task.taskId).messages[0].state,"failed");
  assert.equal(capabilityTruth(db,"worker","worker-extra","message.receive").availability,"available","Pure pre-invoke Authority denial cannot overwrite actual technical capability truth");
  assert.equal(calls.length,5);
  issueGrant(db,{kind:"human",id:"fixture"},{requestId:"restore-after-revoke",subjectNodeId:"origin",capability:"task.dispatch",resourceScope:"node/worker"});
  crossBoundary=false;
  assert.equal(executorPool(db,"worker").find(e=>e.runtimeSessionId==="worker-extra")?.state,"IDLE",JSON.stringify(executorPool(db,"worker")));
  const failed=await callCore(core,"task.dispatch",{requestId:"uncrossed-effect",centerNodeId:"worker",body:"False Host acceptance"}) as any;
  assert.equal(failed.firstMessage.state,"failed");assert.equal(calls.length,5,"Adapter acceptance cannot bypass the Effect boundary");
  assert.equal(capabilityTruth(db,"worker","worker-extra","message.receive").availability,"unavailable");
 }finally{await rpc.close();runtime.close();closeReceiver();db.close();}
});

test("Project-bounded RPC dispatch and Task-bounded canonical result retain their context at final Effect gate",async()=>{
 const db=openDatabase(":memory:"),at=new Date().toISOString(),calls:Array<{locator:string;messageId:string}>=[];
 for(const node of ["chief","issuer","target"]){db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
  db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)").run(node+"-session",node,"fixture://"+node,at);
  recordFixtureHostAvailable(db,node+"-session");}
 bindChiefConversation(db,{kind:"human",id:"fixture"},{projectSpaceId:"bounded-project",projectRef:"bounded-project",chiefNodeId:"chief",frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/bounded"});
 const adapter:Hythe & {inspectExactHost:(locator:string)=>Promise<boolean>}={hytheId:"fixture",hostKind:"fixture",capabilities:()=>["message.receive"],effectProfile:()=>mockProfile,inspectExactHost:async()=>true,locate:async()=>true,async *receive(){},
  invoke:async(locator,operation,input,_id,boundary)=>boundary!.cross({product:"fixture",locator,operation},()=>{
   const id=(input as {messageId:string}).messageId;calls.push({locator,messageId:id});return {status:"accepted",hostRef:"turn:"+id};})};
 const hythes=new Map([["fixture",adapter]]),runtime=new CoreRuntime(db,hythes),rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:token=>token==="issuer"?{kind:"node",nodeId:token,sessionId:token+"-session"}:null});
 try{
  const port=await rpc.listen(0),core={port,token:"issuer"};
  const self=db.prepare("SELECT grant_id FROM grants WHERE subject_node_id='target' AND capability='self.*'").get()!;
  revokeGrant(db,{kind:"human",id:"fixture"},{requestId:"narrow-self",grantId:String(self.grant_id)});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"target",capability:"self.host.execute",resourceScope:"node/target/**",projectRef:"bounded-project"});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"issuer",capability:"task.dispatch",resourceScope:"node/target",projectRef:"bounded-project"});
  const returning=issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"target",capability:"message.send",resourceScope:"node/issuer",projectRef:"bounded-project"});
  await assert.rejects(callCore(core,"task.dispatch",{requestId:"outside",centerNodeId:"target",body:"No Project"}),/HUMAN_ROOTED_AUTHORITY/);
  assert.equal(calls.length,0);
  const work=await callCore(core,"task.dispatch",{requestId:"bounded",centerNodeId:"target",projectRef:"bounded-project",body:"Exact bounded work"}) as any;
  assert.equal(work.firstMessage.state,"delivered");assert.equal(calls.length,1);
  const attempt=db.prepare("SELECT attempt_id,action_id FROM action_attempts WHERE source_message_id=?").get(work.firstMessage.messageId)!;
  const context=JSON.parse(String(db.prepare("SELECT context_json FROM effect_permits WHERE attempt_id=?").get(attempt.attempt_id)!.context_json));
  assert.equal(context.taskId,work.task.taskId);assert.equal(context.projectRef,"bounded-project");assert.equal(context.executionTaskId,work.task.taskId);assert.equal(context.executionProjectRef,"bounded-project");
  assert.throws(()=>prepareEffect(db,{actionId:String(attempt.action_id),attemptId:String(attempt.attempt_id),actorSessionId:"issuer-session",capability:"task.dispatch",resource:"node/target",requestId:"borrow-context",taskId:"another-task",payload:{},profile:mockProfile}),/canonical source Message/);
  revokeGrant(db,{kind:"human",id:"fixture"},{requestId:"narrow-return",grantId:returning.grantId});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"target",capability:"message.send",resourceScope:"node/issuer",projectRef:"bounded-project",taskRef:work.task.taskId});
  await runtime.ingest("target-session",{observedMessageId:work.firstMessage.messageId,hostRef:work.firstMessage.hostRef,outcome:"completed",body:"ACK bounded"});
  const result=getTask(db,work.task.taskId).messages.find(m=>m.kind==="result")!;
  assert.equal(result.state,"delivered");assert.equal(result.targetSessionId,"issuer-session");assert.equal(calls.length,2);
  const returnContext=JSON.parse(String(db.prepare("SELECT p.context_json FROM effect_permits p JOIN action_attempts a USING(attempt_id) WHERE a.source_message_id=?").get(result.messageId)!.context_json));
  assert.equal(returnContext.taskId,work.task.taskId);assert.equal(returnContext.projectRef,"bounded-project");
 }finally{await rpc.close();runtime.close();db.close();}
});

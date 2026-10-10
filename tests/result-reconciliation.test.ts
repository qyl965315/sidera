import {test} from "node:test";
import assert from "node:assert/strict";
import {openDatabase} from "../core/db.ts";
import {CoreRuntime} from "./fixtures/execution.ts";
import {issueGrant} from "./fixtures/authority.ts";
import {getTask} from "../core/scheduler.ts";
import type {Hythe} from "../hythes/types.ts";
import {returnGrantPlan,applyReturnGrant} from "../scripts/runtime-return-grant.ts";
import {canUseCapability} from "../core/authority.ts";
import {CodexHythe} from "../hythes/codex.ts";

test("Codex terminal observation selects the exact completed turn and final answer without starting inference",async()=>{
 const host=new CodexHythe({codexExecutable:"fixture",workspace:"fixture",home:"fixture",temp:"fixture",model:"fixture"});
 let foreign=false;host.control=async(locator,operation)=>{assert.equal(operation,"conversation.read");return {thread:{id:foreign?"foreign":locator,
  turns:[{id:"other",status:"completed",items:[{type:"agentMessage",text:"wrong"}]},{id:"exact",status:"completed",items:[{type:"agentMessage",phase:"commentary",text:"progress"},{type:"agentMessage",phase:"final_answer",text:"ACK"}]}]}};};
 assert.deepEqual(await host.completedTurn("conversation","exact","message"),{hostRef:"exact",observedMessageId:"message",body:"ACK",outcome:"completed"});
 assert.equal(await host.completedTurn("conversation","missing","message"),null);
 foreign=true;await assert.rejects(host.completedTurn("conversation","exact","message"),{code:"conflict"});
});

test("Codex Host requests preserve pending responses across bidirectional ID collisions and decline string-ID approvals",async()=>{
 const host=new CodexHythe({codexExecutable:"fixture-unused",workspace:"fixture",home:"fixture",temp:"fixture",model:"fixture"});
 const transport=host as unknown as {start():Promise<void>;write(payload:Record<string,unknown>):void;
  onLine(line:string):void;pending:Map<number,unknown>};
 const sent:Array<{id?:number|string;method?:string;result?:{decision?:string};error?:{code:number}}> = [];
 transport.start=async()=>{};
 transport.write=payload=>{sent.push(payload as typeof sent[number]);};
 // Exercise real request/response bookkeeping without launching an app-server.
 const read=host.control("exact-thread","conversation.read",{});
 await new Promise<void>(resolve=>setImmediate(resolve));
 const id=sent[0]!.id as number;
 try{
  for(const method of ["item/commandExecution/requestApproval","item/fileChange/requestApproval","unsupported/host/request"]){
   transport.onLine(JSON.stringify({id,method,params:{threadId:"exact-thread",turnId:"host-turn"}}));
   assert.equal(transport.pending.has(id),true,"a Host request must not resolve or delete our pending response");
   const response=sent.at(-1)!;
   assert.equal(response.id,id);
   if(method.endsWith("requestApproval"))assert.deepEqual(response.result,{decision:"decline"});
   else assert.equal(response.error?.code,-32601);
  }
  for(const method of ["item/commandExecution/requestApproval","item/fileChange/requestApproval","unsupported/host/request"]){
   transport.onLine(JSON.stringify({id:"host-string-id",method,params:{threadId:"exact-thread"}}));
   const response=sent.at(-1)!;
   assert.equal(response.id,"host-string-id");
   if(method.endsWith("requestApproval"))assert.deepEqual(response.result,{decision:"decline"});
   else assert.equal(response.error?.code,-32601);
  }
 }finally{
  // Settle even on an assertion failure, so no request timeout is left running.
  transport.onLine(JSON.stringify({id,result:{thread:{id:"exact-thread",turns:[]}}}));
  assert.deepEqual(await read,{thread:{id:"exact-thread",turns:[]}});
 }
 assert.equal(transport.pending.size,0);
});

test("Codex concurrent Executor streams retain each exact thread's pushed and buffered result",async()=>{
 for(const buffered of [false,true]){
  const host=new CodexHythe({codexExecutable:"fixture",workspace:"fixture",home:"fixture",temp:"fixture",model:"fixture"});
  const transport=host as unknown as {start():Promise<void>;onLine(line:string):void;messageByTurn:Map<string,string>};
  // Synthetic app-server notifications exercise the actual receive/dispatch path.
  transport.start=async()=>{};
  transport.messageByTurn.set("turn-a","message-a");
  transport.messageByTurn.set("turn-b","message-b");
  const inject=()=>{
   for(const thread of ["b","a"])transport.onLine(JSON.stringify({method:"turn/completed",
    params:{threadId:`thread-${thread}`,turn:{id:`turn-${thread}`,status:"completed",
     items:[{type:"agentMessage",phase:"final_answer",text:`answer-${thread}`}]}}}));
  };
  if(buffered)inject();
  const a=host.receive("thread-a")[Symbol.asyncIterator](),b=host.receive("thread-b")[Symbol.asyncIterator]();
  const results=Promise.all([a.next(),b.next()]);
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(!buffered)inject();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const observed=await Promise.race([results,new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),300);})]);
   assert.ok(observed,"each Executor must receive its own completion without another stream discarding it");
   assert.deepEqual(observed.map(r=>r.value),[
    {hostRef:"turn-a",observedMessageId:"message-a",body:"answer-a",outcome:"completed"},
    {hostRef:"turn-b",observedMessageId:"message-b",body:"answer-b",outcome:"completed"}]);
   await a.return?.();await b.return?.();
  }finally{if(timer)clearTimeout(timer);await host.close();}
 }
});

test("Confirmed provider completion can repair denied result routing once; an unknown Effect cannot",async()=>{
 const db=openDatabase(":memory:"),at=new Date().toISOString();
 for(const node of ["chief","worker"]){db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
  db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','codex-app-server',?,'active',?)").run(`${node}-session`,node,`${node}-exact`,at);}
 const calls:Array<{locator:string;input:any}>=[];let reads=0,foreign=false;
 const host:Hythe={hytheId:"fixture",hostKind:"codex-app-server",capabilities:()=>["message.receive"],locate:async()=>true,async *receive(){},
  invoke:async(locator,_cap,input)=>{calls.push({locator,input});return {status:"accepted",hostRef:`turn-${calls.length}`};},
  completedTurn:async(locator,hostRef,messageId)=>{reads++;assert.equal(locator,"worker-exact");
   return {hostRef:foreign?"foreign":hostRef,observedMessageId:messageId,body:"ACK actual provider result",outcome:"completed"};}};
 const runtime=new CoreRuntime(db,new Map([["fixture",host]]));
 const grant=(subjectNodeId:string,capability:string,resourceScope:string)=>issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId,capability,resourceScope});
 try{
  grant("chief","task.dispatch","node/worker");
  const task=await runtime.dispatch({requestId:"original",originNodeId:"chief",originSessionId:"chief-session",centerNodeId:"worker",workerNodeIds:[],body:"original"});
  const run=getTask(db,task.task.taskId).runs[0]! as {run_id:string};
  await assert.rejects(runtime.ingest("worker-session",{hostRef:task.firstMessage.hostRef!,observedMessageId:task.firstMessage.messageId,body:"ACK actual provider result",outcome:"completed"}),{code:"denied"});
  assert.equal(getTask(db,task.task.taskId).task.state,"uncertain");
  await assert.rejects(runtime.continuations.reconcileCompletedResult(String(run.run_id)),{code:"denied"});
  assert.equal(calls.length,1);assert.equal(getTask(db,task.task.taskId).messages.length,1);
  foreign=true;await assert.rejects(runtime.continuations.reconcileCompletedResult(String(run.run_id)),{code:"conflict"});foreign=false;
  const human=String(db.prepare("SELECT human_id FROM world_humans ORDER BY human_id LIMIT 1").get()!.human_id);
  const plan=returnGrantPlan(db,String(run.run_id),human);
  assert.throws(()=>applyReturnGrant(db,plan,"yes"),/review not confirmed/);
  applyReturnGrant(db,plan,"ADMIT");
  await runtime.continuations.reconcileCompletedResult(String(run.run_id));
  assert.equal(getTask(db,task.task.taskId).task.state,"completed");assert.equal(calls.length,2);
  assert.equal(calls[1]!.locator,"chief-exact");assert.equal(calls[1]!.input.body,"ACK actual provider result");
  const readsBefore=reads;await runtime.continuations.reconcileCompletedResult(String(run.run_id));
  assert.equal(reads,readsBefore);assert.equal(calls.length,2);
  assert.equal(canUseCapability(db,{subjectNodeId:"worker",sessionId:"worker-session",capability:"message.send",resource:"node/chief",requestId:"second",requireExplicitGrant:true}),false);
  const other=await runtime.dispatch({requestId:"unknown",originNodeId:"chief",originSessionId:"chief-session",centerNodeId:"worker",workerNodeIds:[],body:"unknown"});
  const unknown=getTask(db,other.task.taskId).runs[0]! as {run_id:string};
  db.prepare("UPDATE task_runs SET state='uncertain',turn_open=0 WHERE run_id=?").run(unknown.run_id);
  db.prepare("UPDATE effect_attempt_state SET state='uncertain' WHERE attempt_id IN (SELECT attempt_id FROM action_attempts WHERE source_message_id=?)").run(other.firstMessage.messageId);
  await assert.rejects(runtime.continuations.reconcileCompletedResult(String(unknown.run_id)),{code:"unavailable"});
  assert.equal(reads,readsBefore);assert.equal(calls.filter(c=>c.input.body==="original").length,1);
 }finally{runtime.close();db.close();}
});

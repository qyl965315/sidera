import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../core/db.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { issueGrant, revokeGrant } from "./fixtures/authority.ts";
import { bindChiefConversation, handoffChiefConversation, ChiefDispatch, type ChiefFrontend } from "./fixtures/chief.ts";
import { ExternalMcpClientHythe } from "../hythes/external-mcp-client.ts";
import { buildEdge, startGatewayHttp } from "../hythes/mcp-gateway.ts";
import type { Hythe, HostMessage } from "../hythes/types.ts";
import { callCore } from "../hythes/core-client.ts";
import { createWorld, scopeNewNode } from "../core/worlds.ts";
import { verifyChiefIngress, signChiefIngress } from "../core/chief-ingress.ts";

async function fixture(options:{twoProjects?:boolean;providerSession?:boolean;uncertain?:boolean}={}) {
  const dir=mkdtempSync(join(tmpdir(),"sidera-chief-pull-"));
  let db=openDatabase(join(dir,"test.sqlite"));const at=new Date().toISOString();
  for(const node of ["chief","codex","codex2"]){
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,'active',?)").run(`${node}-session`,node,
      node==="chief"?"external":"fixture",node==="chief"?"external-mcp-client":"fixture",
      node==="chief"?"gateway-edge://chatgpt":`fixture://${node}/pinned`,at);
  }
  const binding=bindChiefConversation(db,{kind:"human",id:"synthetic-owner"},{projectSpaceId:"p1",projectRef:"fixture:p1",
    chiefNodeId:"chief",frontendKind:"chatgpt",conversationRef:"https://chatgpt.com/c/synthetic-one"});
  const second=options.twoProjects?bindChiefConversation(db,{kind:"human",id:"synthetic-owner"},{projectSpaceId:"p2",projectRef:"fixture:p2",
    chiefNodeId:"chief",frontendKind:"chatgpt",conversationRef:"https://chatgpt.com/c/synthetic-two"}):undefined;
  const calls:unknown[]=[];
  const external=new ExternalMcpClientHythe("external",{edgeId:"chatgpt",locatorRef:"gateway-edge://chatgpt",gatewayEndpoint:"http://127.0.0.1:1/mcp"});
  const originCalls={locate:0,invoke:0};
  const locateExternal=external.locate.bind(external),invokeExternal=external.invoke.bind(external);
  external.locate=async ref=>{originCalls.locate++;return locateExternal(ref);};
  external.invoke=async()=>{originCalls.invoke++;return invokeExternal();};
  const completed=new Map<string,HostMessage[]>();
  const worker:Hythe={hytheId:"fixture",hostKind:"fixture",capabilities:()=>["message.receive"],canStartTurn:()=>true,locate:async()=>true,
    invoke:async(locator,capability,input)=>{calls.push({locator,capability,input});return options.uncertain?{status:"uncertain",reason:"Synthetic lost Host response after final Effect Gate"}:{status:"accepted",hostRef:`synthetic-turn-${calls.length}`};},
    async *receive(locator){for(const event of completed.get(locator)?.splice(0)??[])yield event;}};
  const hythes=new Map<string,Hythe>([["external",external],["fixture",worker]]);
  let runtime=new CoreRuntime(db,hythes);
  const frontend:ChiefFrontend={inspect:async()=>{throw Error("No frontend inspect");},deliver:async()=>{throw Error("No frontend push");}};
  let chief=new ChiefDispatch(db,hythes,frontend);
  for(const worker of ["codex","codex2"])for(const [from,to,cap] of [["chief",worker,"task.dispatch"],[worker,"chief","message.send"]])
    issueGrant(db,{kind:"human",id:"synthetic-owner"},{subjectNodeId:from!,capability:cap!,resourceScope:`node/${to}`});
  const auth={authenticate:(token:string)=>token==="synthetic-core-token"?{kind:"node" as const,nodeId:"chief",sessionId:"chief-session"}:null};
  let rpc=new CoreRpcServer(db,runtime,hythes,auth,undefined,dir,chief);
  let port=await rpc.listen(0);
  const config={version:1 as const,corePort:port,gatewayPort:0,host:"127.0.0.1" as const,edges:[]};
  const scope={id:"chatgpt" as const,boundNodeId:"chief",coreToken:"synthetic-core-token",token:"synthetic-edge-token",chiefConversationRef:binding.conversationRef,
    chiefProviderSession:options.providerSession?{sessionId:"approved-provider-session",subjectId:"approved-provider-subject"}:undefined};
  const edge=buildEdge(config,scope);
  const edges=[edge];
  if(second)edges.push(buildEdge(config,{...scope,id:"grok-chat",token:"second-edge-token",chiefConversationRef:second.conversationRef,
    chiefProviderSession:options.providerSession?{sessionId:"second-provider-session",subjectId:"approved-provider-subject"}:undefined}));
  edges.push(buildEdge(config,{...scope,id:"gemini-chat",token:"unscoped-edge-token",chiefConversationRef:undefined,chiefProviderSession:undefined}));
  let listener=await startGatewayHttp(edges,{port:0});
  const clients:Client[]=[];
  const connect=async(token="synthetic-edge-token")=>{
    const client=new Client({name:"synthetic-chat-host",version:"1"});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    return async(operation:string,args:Record<string,unknown>={},meta:Record<string,unknown>|undefined=options.providerSession?{"openai/session":token==="second-edge-token"?"second-provider-session":"approved-provider-session","openai/subject":"approved-provider-subject"}:undefined)=>{
      const response=await client.callTool({name:"sidera_invoke",arguments:{operation,arguments:args},_meta:meta});
      const raw=(response.content as Array<{text:string}>)[0]!.text;
      let envelope;try{envelope=JSON.parse(raw);}catch{envelope={reason:raw};}
      return {response,value:envelope.result??envelope};
    };
  };
  let invoke=await connect();
  const finish=async(submitted:any,body="SYNTHETIC exact Codex result")=>{
    await runtime.continuations.pump();
    const run=runtime.continuations.run(submitted.run.run_id);
    const message=db.prepare("SELECT * FROM messages WHERE message_id=?").get(run.message_id)!;
    const locator=String(db.prepare("SELECT locator_ref FROM sessions WHERE session_id=?").get(run.session_id)!.locator_ref);
    completed.set(locator,[{hostRef:String(message.host_ref),observedMessageId:run.message_id,body,outcome:"completed"}]);
    await runtime.receive(run.session_id);
  };
  const stop=async()=>{for(const client of clients.splice(0))await client.close();await listener.close();await rpc.close();chief.close();runtime.close();db.close();};
  return {get db(){return db;},get runtime(){return runtime;},get chief(){return chief;},binding,second,calls,originCalls,worker,edge,
    get invoke(){return invoke;},connect,finish,get port(){return port;},get listener(){return listener;},
    async restartScheduler(){
      await stop();db=openDatabase(join(dir,"test.sqlite"));runtime=new CoreRuntime(db,hythes);chief=new ChiefDispatch(db,hythes,frontend);
      rpc=new CoreRpcServer(db,runtime,hythes,auth,undefined,dir,chief);port=await rpc.listen(0);
      for(const e of edges)e.core.port=port;
      listener=await startGatewayHttp(edges,{port:0});invoke=await connect();runtime.continuations.recover();await runtime.continuations.pump();
    },
    async close(){await stop();rmSync(dir,{recursive:true,force:true});}};
}

test("P0 v2 authenticated real loopback MCP dispatches an inbound-only Chief and pulls its exact result",{timeout:20000},async t=>{
  const f=await fixture();
  try{
    const requestId=randomUUID(),args={requestId,centerNodeId:"codex",body:"Bounded synthetic host task"};
    const submitted=(await f.invoke("task.dispatch",args)).value;
    assert.ok(submitted.task?.taskId,`Authenticated pull root must create a Task: ${JSON.stringify(submitted)}`);
    await f.runtime.continuations.pump();
    assert.equal(f.calls.length,1);
    const status=(await f.invoke("chief.dispatch.status",{targetNodeId:"codex2"})).value;
    assert.equal(status.state,"READY");
    assert.equal(status.separation.pullReturn.state,"PULL_READABLE");
    assert.equal(status.separation.pushReturn.state,"PUSH_UNAVAILABLE");
    assert.equal(status.separation.exactConversationPresence.state,"UNVERIFIED");
    assert.equal(status.separation.humanResultObservation.state,"NOT_OBSERVED");
    const run=f.runtime.continuations.run(submitted.run.run_id);
    const message=f.db.prepare("SELECT * FROM messages WHERE message_id=?").get(run.message_id)!;
    await f.finish(submitted);
    const read=(await f.invoke("chief.result_get",{taskId:submitted.task.taskId})).value;
    assert.equal(read.results.length,1);
    assert.equal(read.results[0].originalBindingId,f.binding.bindingId);
    assert.equal(read.results[0].workerBody,"SYNTHETIC exact Codex result");
    assert.equal(read.readMarksHumanObserved,false);
    assert.equal(read.transport.providerConversationProof,"NOT_OBSERVED");
    assert.equal(read.transport.providerSession,"UNVERIFIED");
    assert.equal((await f.invoke("task.dispatch",args)).value.task.taskId,submitted.task.taskId);
    assert.equal(f.calls.length,1);
    assert.deepEqual(f.originCalls,{locate:0,invoke:0});
    // Simulate the existing 47f9372 receipt shape, preserving the same Task and
    // result. Upgrading scope validation may not reinterpret it as new work.
    const legacy=JSON.parse(String(f.db.prepare("SELECT input_json FROM chief_actions WHERE request_id=?").get(requestId)!.input_json));
    delete legacy.originBindingId;delete legacy.bindingId;delete legacy.projectRef;
    f.db.prepare("UPDATE chief_actions SET input_json=? WHERE request_id=?").run(JSON.stringify(legacy),requestId);
    await f.restartScheduler();
    const persisted=(await f.invoke("chief.result_get",{taskId:submitted.task.taskId})).value;
    assert.equal(persisted.results[0].messageId,read.results[0].messageId);
    assert.equal((await f.invoke("task.dispatch",args)).value.task.taskId,submitted.task.taskId);
    assert.equal(f.calls.length,1);
    const attempts=f.db.prepare("SELECT a.attempt_id,a.action_id,e.state FROM action_attempts a JOIN effect_attempt_state e USING(attempt_id) WHERE a.source_message_id=?").all(run.message_id);
    assert.ok(attempts.length>0);assert.ok(attempts.every(a=>a.state==="completed"));
    assert.deepEqual(f.originCalls,{locate:0,invoke:0});
    t.diagnostic(JSON.stringify({evidenceClass:"SYNTHETIC",transport:"real-loopback-streamable-http-MCP",taskId:submitted.task.taskId,
      requestId,runId:run.run_id,messageId:run.message_id,hostReceipt:message.host_ref,resultMessageId:read.results[0].messageId,
      originBindingId:f.binding.bindingId,attempts,fullP0:"HOLD",remoteCurrentConnector:"NOT_OBSERVED",humanObserved:"NOT_OBSERVED"}));
  }finally{await f.close();}
});

test("P0 v2 concurrent Project Chiefs select exact original bindings and cannot cross-read or borrow scope",{timeout:20000},async()=>{
  const f=await fixture({twoProjects:true,providerSession:true});
  try{
    const other=await f.connect("second-edge-token"),unscoped=await f.connect("unscoped-edge-token");
    const a={requestId:randomUUID(),centerNodeId:"codex",body:"Project one",bindingId:f.binding.bindingId};
    const b={requestId:randomUUID(),centerNodeId:"codex2",body:"Project two",projectRef:f.second!.projectRef};
    const [one,two]=await Promise.all([f.invoke("task.dispatch",a),other("task.dispatch",b)]);
    assert.ok(one.value.task?.taskId,JSON.stringify(one.value));assert.ok(two.value.task?.taskId,JSON.stringify(two.value));
    assert.equal(one.value.chiefBinding.bindingId,f.binding.bindingId);assert.equal(two.value.chiefBinding.bindingId,f.second!.bindingId);
    await f.finish(one.value,"private result one");await f.finish(two.value,"private result two");
    assert.equal((await f.invoke("chief.result_get",{taskId:one.value.task.taskId})).value.results[0].workerBody,"private result one");
    assert.equal((await f.invoke("chief.result_get",{})).value.transport.providerSession,"APPROVED_CORRELATION");
    assert.equal((await other("chief.result_get",{taskId:one.value.task.taskId})).value.results.length,0);
    for(const operation of ["task.get","work.inspect"]){
      assert.equal((await other(operation,{taskId:one.value.task.taskId})).response.isError,true);
    }
    for(const operation of ["world.inspect","history.list","omega.inspect"])
      assert.equal((await other(operation,{})).response.isError,true);
    for(const args of [{bindingId:f.second!.bindingId},{projectRef:f.second!.projectRef},{conversationRef:f.second!.conversationRef},{_meta:{"openai/session":"approved-provider-session"}}]){
      const read=await f.invoke("chief.result_get",args);assert.equal(read.response.isError,true,JSON.stringify(args));
      assert.ok(!JSON.stringify(read).includes("private result two"));
    }
    const wrong=await f.invoke("task.dispatch",{...a,requestId:randomUUID(),bindingId:f.second!.bindingId});assert.equal(wrong.response.isError,true);
    assert.equal((await unscoped("chief.result_get",{})).response.isError,true);
    assert.equal((await unscoped("task.dispatch",{requestId:randomUUID(),centerNodeId:"codex",body:"must not mint"})).response.isError,true);
    const priorCount=f.db.prepare("SELECT count(*) n FROM tasks").get()!.n;
    for(const meta of [{},{"openai/session":"wrong","openai/subject":"approved-provider-subject"},{"openai/session":"approved-provider-session","openai/subject":"wrong"}]){
      const read=await f.invoke("chief.result_get",{},meta);assert.equal(read.response.isError,true);assert.ok(!JSON.stringify(read).includes("private result one"));
      assert.equal((await f.invoke("task.dispatch",{...a,requestId:randomUUID()},meta)).response.isError,true);
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n,priorCount);
    assert.equal(f.calls.length,2);
    const foreignWorld=createWorld(f.db,"foreign synthetic World","P0 v2 synthetic scope test");
    scopeNewNode(f.db,foreignWorld,"foreign-worker");
    f.db.prepare("INSERT INTO nodes VALUES ('foreign-worker','foreign-worker','active',?)").run(new Date().toISOString());
    const foreignTask=randomUUID();
    f.db.prepare("INSERT INTO tasks VALUES (?,?,'foreign-worker','foreign-worker','[]','completed',NULL,?)").run(foreignTask,"foreign-request",new Date().toISOString());
    const foreignRead=await f.invoke("chief.result_get",{taskId:foreignTask});
    assert.equal(foreignRead.response.isError,true);assert.match(JSON.stringify(foreignRead.value),/Cross-World/);
    const foreign=await f.invoke("task.dispatch",{requestId:randomUUID(),centerNodeId:"foreign-worker",body:"must not cross World"});
    assert.equal(foreign.response.isError,true);assert.match(JSON.stringify(foreign.value),/Cross-World/);
    await assert.rejects(callCore({port:f.port,token:"synthetic-core-token"},"chief.result_get",{conversationRef:f.binding.conversationRef}),/denied/);
    const missing=await fetch(`http://127.0.0.1:${f.listener.port}/mcp`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
    assert.equal(missing.status,401);
  }finally{await f.close();}
});

test("P0 v2 Human handoff preserves original inbox and revoked authority mints no Task",{timeout:20000},async()=>{
  const f=await fixture();
  try{
    const args={requestId:randomUUID(),centerNodeId:"codex",body:"original before handoff"};
    const submitted=(await f.invoke("task.dispatch",args)).value;await f.finish(submitted);
    const replacement=handoffChiefConversation(f.db,{kind:"human",id:"synthetic-owner"},{requestId:randomUUID(),expectedBindingId:f.binding.bindingId,
      conversationRef:"https://chatgpt.com/c/synthetic-replacement"});
    assert.equal((await f.invoke("chief.result_get",{})).response.isError,true,"old deployment scope cannot follow a handoff");
    f.edge.core.chiefConversationRef=replacement.conversationRef;
    f.edge.core.chiefIngressScope={...f.edge.core.chiefIngressScope!,conversationRef:replacement.conversationRef,bindingId:replacement.bindingId};
    assert.deepEqual((await f.invoke("chief.result_get",{taskId:submitted.task.taskId})).value.results,[]);
    assert.equal((await f.invoke("task.get",{taskId:submitted.task.taskId})).response.isError,true);
    assert.equal((await f.invoke("task.dispatch",args)).response.isError,true,"replacement may not replay original request result");
    assert.equal(f.db.prepare("SELECT binding_id FROM chief_task_routes WHERE task_id=?").get(submitted.task.taskId)!.binding_id,f.binding.bindingId);
    for(const row of f.db.prepare("SELECT grant_id FROM grants WHERE subject_node_id='chief' AND capability='task.dispatch'").all())
      revokeGrant(f.db,{kind:"human",id:"synthetic-owner"},{requestId:randomUUID(),grantId:String(row.grant_id)});
    const status=(await f.invoke("chief.dispatch.status",{targetNodeId:"codex"})).value;
    assert.equal(status.state,"BLOCKED");assert.ok(status.reasons.includes("NO_AVAILABLE_AUTHORIZED_NODE"));
    assert.equal((await f.invoke("task.dispatch",{...args,requestId:randomUUID()})).response.isError,true);
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n,1);
    assert.equal(f.calls.length,1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='HumanObserved'").get()!.n,0);
  }finally{await f.close();}
});

test("P0 v2 Core rejects unsigned/altered/expired ingress; Human config alone is not an inbound call",{timeout:20000},async()=>{
  const f=await fixture();
  try{
    const ingress={transport:"authenticated-mcp-pull" as const,nodeId:"chief",edgeId:"chatgpt",conversationRef:f.binding.conversationRef,
      providerSession:"UNVERIFIED" as const,observedAt:Date.now()};
    const request={id:"synthetic-id",method:"chief.result_get",params:{},chiefIngress:ingress};
    assert.throws(()=>verifyChiefIngress("synthetic-core-token",request,"chief"),/Untrusted/);
    const signed={...request,chiefIngressProof:signChiefIngress("synthetic-core-token",request,ingress)};
    assert.equal(verifyChiefIngress("synthetic-core-token",signed,"chief")?.conversationRef,ingress.conversationRef);
    assert.throws(()=>verifyChiefIngress("synthetic-core-token",{...signed,params:{bindingId:randomUUID()}},"chief"),/Untrusted/);
    assert.throws(()=>verifyChiefIngress("synthetic-core-token",{...signed,chiefIngress:{...ingress,observedAt:0}},"chief"),/Invalid/);
    assert.throws(()=>verifyChiefIngress("synthetic-core-token",signed,"another-node"),/Invalid/);
    await assert.rejects(callCore(f.edge.core,"task.submit",{requestId:randomUUID(),centerNodeId:"codex",body:"configuration is not ingress"}),/scope/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n,0);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test("P0 v2 transactional recheck rejects a binding handoff during awaited target discovery",{timeout:20000},async()=>{
  const f=await fixture();
  try{
    let changed=false;
    f.worker.locate=async()=>{
      if(!changed){changed=true;handoffChiefConversation(f.db,{kind:"human",id:"synthetic-owner"},{requestId:randomUUID(),expectedBindingId:f.binding.bindingId,
        conversationRef:"https://chatgpt.com/c/synthetic-racing-handoff"});}
      return true;
    };
    let executed=false;
    await assert.rejects(f.chief.action({nodeId:"chief",sessionId:"chief-session",chiefIngress:{transport:"authenticated-mcp-pull",nodeId:"chief",edgeId:"chatgpt",
      conversationRef:f.binding.conversationRef,providerSession:"UNVERIFIED",observedAt:Date.now()}},
      {requestId:randomUUID(),targetNodeId:"codex",bindingId:f.binding.bindingId,capability:"task.dispatch",payload:{}},
      ()=>{executed=true;return {};}),/binding|scope/);
    assert.equal(executed,false);assert.equal(f.calls.length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n,0);
  }finally{await f.close();}
});

test("P0 v2 ambiguous omission fails closed; exact binding concurrent duplicates create only one task",{timeout:20000},async()=>{
  const f=await fixture({twoProjects:true});
  try{
    const args={requestId:randomUUID(),centerNodeId:"codex",body:"ambiguous root"};
    assert.throws(()=>f.chief.binding("chief"),/explicit Project/);
    const unscoped=await f.connect("unscoped-edge-token");
    assert.equal((await unscoped("task.dispatch",args)).response.isError,true);
    const blocked=(await unscoped("chief.dispatch.status",{})).value;
    assert.equal(blocked.state,"BLOCKED");assert.ok(blocked.reasons.includes("CHIEF_INGRESS_SCOPE_UNAVAILABLE"));
    assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get()!.n,0);
    const exact={...args,requestId:randomUUID(),bindingId:f.binding.bindingId};
    const [first,duplicate]=await Promise.all([f.invoke("task.dispatch",exact),f.invoke("task.dispatch",exact)]);
    assert.ok(first.value.task?.taskId,JSON.stringify(first.value));assert.equal(duplicate.value.task.taskId,first.value.task.taskId);
    await f.finish(first.value);
    assert.equal(f.calls.length,1);
    assert.equal((await f.invoke("chief.result_get",{bindingId:f.binding.bindingId})).value.results.length,1);
    const second=await f.connect("second-edge-token");
    assert.equal((await second("chief.result_get",{bindingId:f.second!.bindingId})).value.results.length,0);
  }finally{await f.close();}
});

test("P0 v2 uncertain Host effect remains pinned and is never invoked again after scheduler restart",{timeout:20000},async()=>{
  const f=await fixture({uncertain:true});
  try{
    const args={requestId:randomUUID(),centerNodeId:"codex",body:"lose response once"};
    const submitted=(await f.invoke("task.dispatch",args)).value;assert.ok(submitted.task?.taskId,JSON.stringify(submitted));
    await f.runtime.continuations.pump();assert.equal(f.calls.length,1);
    assert.equal(f.runtime.continuations.run(submitted.run.run_id).state,"uncertain");
    assert.equal((await f.invoke("task.dispatch",args)).value.task.taskId,submitted.task.taskId);
    assert.equal((await f.invoke("chief.result_get",{})).value.results.length,0);
    await f.restartScheduler();assert.equal(f.calls.length,1);
    assert.equal(f.runtime.continuations.run(submitted.run.run_id).state,"uncertain");
    assert.equal(f.db.prepare("SELECT binding_id FROM chief_task_routes WHERE task_id=?").get(submitted.task.taskId)!.binding_id,f.binding.bindingId);
    assert.equal((await f.invoke("chief.result_get",{})).value.results.length,0);
    assert.equal((await f.invoke("task.dispatch",args)).value.task.taskId,submitted.task.taskId);
    assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

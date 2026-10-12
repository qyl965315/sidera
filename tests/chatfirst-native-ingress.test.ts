import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../core/db.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { startLocalService, type RuntimeSpec } from "../core/service.ts";
import { ExternalMcpClientHythe } from "../hythes/external-mcp-client.ts";
import { startGptHythe } from "../hythes/gpt-mcp.ts";
import { callCore } from "../hythes/core-client.ts";
import type { Hythe } from "../hythes/types.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { bindChiefConversation, ChiefDispatch } from "./fixtures/chief.ts";
import { grantSelf, issueGrant } from "./fixtures/authority.ts";

function clean(root:string) {
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));
  assert.ok(root.includes("sidera-native-ingress-"));
  rmSync(root,{recursive:true,force:true});
}
function portOf(server:Server):number {return (server.address() as {port:number}).port;}
async function connect(port:number,token:string) {
  const client=new Client({name:"synthetic-native-chief",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    {requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  return {client,async call(name:string,args:Record<string,unknown>={},meta?:Record<string,unknown>){
    const response=await client.callTool({name,arguments:args,_meta:meta});
    const raw=(response.content as Array<{text:string}>)[0]!.text;
    let value:any;try{value=JSON.parse(raw);}catch{value={reason:raw};}
    return {response,value};
  }};
}

// Real local HTTP + Core RPC, synthetic grants and Host completion only.
// No cloud connector, production profile or real Operator is exercised.
test("native authenticated MCP dispatches and pulls an exact original-Chat result without metadata-derived authority",{timeout:20_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"sidera-native-ingress-")),db=openDatabase(join(root,"test.sqlite"));
  const at=new Date().toISOString();
  for(const node of ["chief","worker"]){
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,'active',?)").run(`${node}-session`,node,
      node==="chief"?"external":"fixture",node==="chief"?"external-mcp-client":"fixture",`fixture://${node}`,at);
  }
  const binding=bindChiefConversation(db,{kind:"human",id:"synthetic-owner"},{projectSpaceId:"native-one",projectRef:"fixture:native-one",
    chiefNodeId:"chief",frontendKind:"chatgpt",conversationRef:"https://chatgpt.com/c/synthetic-native-one"});
  const other=bindChiefConversation(db,{kind:"human",id:"synthetic-owner"},{projectSpaceId:"native-two",projectRef:"fixture:native-two",
    chiefNodeId:"chief",frontendKind:"chatgpt",conversationRef:"https://chatgpt.com/c/synthetic-native-two"});
  for(const [from,to,cap] of [["chief","worker","task.dispatch"],["worker","chief","message.send"]])
    issueGrant(db,{kind:"human",id:"synthetic-owner"},{subjectNodeId:from!,capability:cap!,resourceScope:`node/${to}`});
  let calls=0;
  const worker:Hythe={hytheId:"fixture",hostKind:"fixture",capabilities:()=>["message.receive"],canStartTurn:()=>true,
    locate:async()=>true,async *receive(){},invoke:async()=>({status:"accepted",hostRef:`synthetic-native-turn-${++calls}`})};
  const hythes=new Map<string,Hythe>([["fixture",worker],["external",new ExternalMcpClientHythe("external",{edgeId:"chatgpt",locatorRef:"fixture://chief"})]]);
  const runtime=new CoreRuntime(db,hythes),chief=new ChiefDispatch(db,hythes,{inspect:async()=>({ready:false,reason:"No synthetic push"}),deliver:async()=>{throw Error("No synthetic push");}});
  const rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:token=>token==="synthetic-native-core"
    ?{kind:"node",nodeId:"chief",sessionId:"chief-session"}:null},undefined,root,chief);
  const core={port:await rpc.listen(0),token:"synthetic-native-core",chiefConversationRef:binding.conversationRef,
    chiefIngressScope:{nodeId:"chief",edgeId:"native-mcp",conversationRef:binding.conversationRef,bindingId:binding.bindingId}};
  const server=await startGptHythe({core,httpToken:"synthetic-native-edge",port:0});
  const {client,call}=await connect(portOf(server),"synthetic-native-edge");
  try {
    const args={requestId:randomUUID(),centerNodeId:"worker",body:"Bounded synthetic native task"};
    const submitted=(await call("task_dispatch",args)).value;
    assert.ok(submitted.task?.taskId,JSON.stringify(submitted));
    assert.equal(submitted.chiefBinding.bindingId,binding.bindingId);
    await runtime.continuations.pump();
    const run=runtime.continuations.run(submitted.run.run_id);
    const message=db.prepare("SELECT host_ref FROM messages WHERE message_id=?").get(run.message_id)!;
    await runtime.ingest("worker-session",{hostRef:String(message.host_ref),observedMessageId:run.message_id,body:"SYNTHETIC native result",outcome:"completed"});
    const read=(await call("chief_result_get",{taskId:submitted.task.taskId})).value;
    assert.equal(read.results[0].originalBindingId,binding.bindingId);
    assert.equal(read.results[0].workerBody,"SYNTHETIC native result");
    assert.equal(read.transport.mode,"authenticated-mcp-pull");
    assert.equal(read.transport.providerSession,"UNVERIFIED");
    assert.equal(read.transport.providerConversationProof,"NOT_OBSERVED");
    assert.equal(read.readMarksHumanObserved,false);
    assert.equal((await call("chief_result_get",{bindingId:other.bindingId})).response.isError,true);
    const crossProject=await call("task_dispatch",{...args,requestId:randomUUID(),projectRef:other.projectRef});
    assert.equal(crossProject.response.isError,true);assert.match(crossProject.value.reason,/denied/);
    assert.equal((await call("task_dispatch",args)).value.task.taskId,submitted.task.taskId);
    assert.equal(calls,1,"repeated exact request and result pull do not repeat a Host effect");
    await assert.rejects(callCore(core,"chief.result_get",{}),/scope/,
      "configured scope without the authenticated HTTP callback cannot attest ingress");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks").get()!.n,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='HumanObserved'").get()!.n,0);
  } finally {
    await client.close();await new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()));
    await rpc.close();chief.close();runtime.close();db.close();clean(root);
  }
});

async function freePorts(count:number):Promise<number[]> {
  const servers=Array.from({length:count},()=>createServer());
  try {
    return await Promise.all(servers.map(async server=>{
      await new Promise<void>((ok,fail)=>{server.once("error",fail);server.listen(0,"127.0.0.1",ok);});
      return (server.address() as {port:number}).port;
    }));
  } finally {await Promise.all(servers.map(server=>new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()))));}
}

test("native service cold start and restart preserve explicit multi-Project scopes; missing scope fails closed",{timeout:30_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"sidera-native-ingress-")),data=join(root,".sidera-dev","sol","data");
  mkdirSync(data,{recursive:true});
  const db=openDatabase(join(data,"sidera.sqlite")),at=new Date().toISOString();
  db.prepare("INSERT INTO nodes VALUES ('chief','Chief','active',?)").run(at);
  db.prepare("INSERT INTO sessions VALUES ('chief-session','chief','external','external-mcp-client','fixture://chief','active',?)").run(at);
  grantSelf(db,"chief");
  const bindings=["one","two"].map(id=>bindChiefConversation(db,{kind:"human",id:"synthetic-owner"},
    {projectSpaceId:`native-${id}`,projectRef:`fixture:native-${id}`,chiefNodeId:"chief",frontendKind:"chatgpt",
      conversationRef:`https://chatgpt.com/c/synthetic-native-${id}`}));
  db.close();
  const [corePort,firstPort,secondPort,unscopedPort]=await freePorts(4);
  const spec:RuntimeSpec={version:1,corePort:corePort!,mcpPort:firstPort!,httpToken:"synthetic-human-token",chiefNodeId:"chief",
    nodes:[{nodeId:"chief",displayName:"Chief",sessionId:"chief-session",locatorRef:"fixture://chief",hostKind:"external-mcp-client",
      hytheId:"external",options:{edgeId:"chatgpt"},coreToken:"synthetic-native-core"}],frontend:{routes:[]},
    frontends:[{nodeId:"chief",port:firstPort!,httpToken:"synthetic-edge-one",chiefConversationRef:bindings[0]!.conversationRef,
      chiefBindingId:bindings[0]!.bindingId,chiefProviderSession:{sessionId:"synthetic-provider-one",subjectId:"synthetic-subject"}},
      {nodeId:"chief",port:secondPort!,httpToken:"synthetic-edge-two",chiefConversationRef:bindings[1]!.conversationRef,chiefBindingId:bindings[1]!.bindingId},
      {nodeId:"chief",port:unscopedPort!,httpToken:"synthetic-edge-unscoped"}]};
  writeFileSync(join(data,"runtime-spec.json"),JSON.stringify(spec));
  try {
    for(let boot=0;boot<2;boot++){
      const service=await startLocalService(root),clients:Client[]=[];
      try {
        const first=await connect(firstPort!,"synthetic-edge-one");clients.push(first.client);
        const second=await connect(secondPort!,"synthetic-edge-two");clients.push(second.client);
        const unscoped=await connect(unscopedPort!,"synthetic-edge-unscoped");clients.push(unscoped.client);
        const approved={"openai/session":"synthetic-provider-one","openai/subject":"synthetic-subject"};
        const firstRead=(await first.call("chief_result_get",{},approved)).value;
        assert.equal(firstRead.binding.bindingId,bindings[0]!.bindingId);
        assert.equal(firstRead.transport.providerSession,"APPROVED_CORRELATION");
        assert.equal(firstRead.transport.providerConversationProof,"NOT_OBSERVED");
        assert.equal((await first.call("chief_result_get")).response.isError,true);
        assert.equal((await first.call("chief_result_get",{},{...approved,"openai/session":"different"})).response.isError,true);
        assert.equal((await first.call("chief_result_get",{bindingId:bindings[1]!.bindingId},approved)).response.isError,true);
        assert.equal((await second.call("chief_result_get")).value.binding.bindingId,bindings[1]!.bindingId);
        const missing=await unscoped.call("chief_result_get",{bindingId:bindings[0]!.bindingId},approved);
        assert.equal(missing.response.isError,true);assert.match(missing.value.reason,/scope/);
        const blocked=await unscoped.call("task_dispatch",{requestId:randomUUID(),centerNodeId:"chief",body:"Must not dispatch"},approved);
        assert.equal(blocked.response.isError,true);assert.match(blocked.value.reason,/scope/);
        const ready=await (await fetch(`http://127.0.0.1:${firstPort}/readyz`)).json() as {ready:boolean};
        assert.equal(ready.ready,true,"multi-Project dispatch readiness cannot crash the local service");
      } finally {await Promise.all(clients.map(client=>client.close()));await service.close();}
    }
    const after=openDatabase(join(data,"sidera.sqlite"));
    try {assert.equal(after.prepare("SELECT COUNT(*) n FROM tasks").get()!.n,0);}
    finally {after.close();}
  } finally {clean(root);}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { probeHostHealth } from "../core/host-health.ts";
import { executorPool } from "../core/executors.ts";
import { recoverCodexPin } from "../core/codex-pin.ts";
import type { Hythe } from "../hythes/types.ts";
import { buildEdge, startGatewayHttp, type GatewayWorkspaceConfig } from "../hythes/mcp-gateway.ts";
import { observeGatewayIngress, readGatewayIngress } from "../hythes/gateway-ingress.ts";

test("Exact Host recovery clears sticky health while retaining an uncertain Run and its pinned context",async()=>{
 const db=openDatabase(":memory:"),at=new Date().toISOString();let connected=false,invocations=0;
 try{
  for(const id of ["owner","operator"]){
   db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id,id,at);
   db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run("s-"+id,id,"exact-"+id,at);
  }
  db.prepare("INSERT INTO tasks VALUES ('task','original','owner','operator','[]','uncertain',NULL,?)").run(at);
  db.prepare("INSERT INTO messages VALUES ('message','task:task','task','owner','operator','s-operator',1,'task','original body','uncertain','original-turn',NULL,?)").run(at);
  db.prepare("INSERT INTO task_runs VALUES ('run','task','s-operator','message','uncertain',0,'',?)").run(at);
  db.prepare("INSERT INTO session_health VALUES ('s-operator','unavailable','old',?)").run(at);
  const hythe:Hythe & {inspectExactHost:(ref:string)=>Promise<boolean>}={hytheId:"mock",hostKind:"mock",capabilities:()=>["message.receive"],canStartTurn:()=>connected,
   inspectExactHost:async ref=>{assert.equal(ref,"exact-operator");connected=true;return true;},
   locate:async ref=>{assert.equal(ref,"exact-operator");connected=true;return true;},async *receive(){},
   invoke:async()=>{invocations++;return {status:"accepted",hostRef:"forbidden"};}};
  assert.equal(executorPool(db,"operator")[0]!.state,"UNAVAILABLE");
  const result=await probeHostHealth(db,new Map([["mock",hythe]]),"s-operator","test-exact-reprobe");
  assert.equal(result.state,"available");assert.equal(invocations,0);
  assert.equal(executorPool(db,"operator")[0]!.state,"BUSY");
  assert.deepEqual({...db.prepare("SELECT state,turn_open,session_id FROM task_runs WHERE run_id='run'").get()},
   {state:"uncertain",turn_open:0,session_id:"s-operator"});
  assert.equal(db.prepare("SELECT count(*) n FROM messages").get()!.n,1);
  assert.equal(db.prepare("SELECT kind FROM events ORDER BY rowid DESC LIMIT 1").get()!.kind,"host.health.observed");
 }finally{db.close();}
});

test("Executable repair accepts one verified owning-product successor and refuses ambiguity or unrelated pins",()=>{
 const local=mkdtempSync(join(tmpdir(),"sidera-codex-pin-")),bin=join(local,"OpenAI","Codex","bin");
 const candidate=join(bin,"aaaaaaaaaaaaaaaa","codex.exe"),missing=join(bin,"bbbbbbbbbbbbbbbb","codex.exe");
 mkdirSync(join(bin,"aaaaaaaaaaaaaaaa"),{recursive:true});writeFileSync(candidate,"test executable");
 const verify=()=>({publisher:"test signature fixture",sha256:"fixture hash",version:"codex-cli 1.0.0"});
 assert.equal(recoverCodexPin(missing,{platform:"win32",localAppData:local,verify}).executable,candidate);
 assert.equal(recoverCodexPin(missing,{platform:"win32",localAppData:local,verify:()=>null}).executable,undefined);
 assert.equal(recoverCodexPin(join(local,"elsewhere","codex.exe"),{platform:"win32",localAppData:local,verify}).executable,undefined);
 assert.equal(recoverCodexPin(candidate,{platform:"win32",localAppData:local,verify}).executable,undefined);
 mkdirSync(join(bin,"cccccccccccccccc"));writeFileSync(join(bin,"cccccccccccccccc","codex.exe"),"another executable");
 assert.equal(recoverCodexPin(missing,{platform:"win32",localAppData:local,verify}).executable,undefined);
});

test("Gateway ingress observes the actual listener and expires by configuration and time without manufacturing Presence",async()=>{
 const project=mkdtempSync(join(tmpdir(),"sidera-ingress-")),data=join(project,".sidera-dev","sol","data");mkdirSync(data,{recursive:true});
 const config:GatewayWorkspaceConfig={version:1,corePort:1,gatewayPort:0,host:"127.0.0.1",edges:[]};
 config.edges=[{id:"codex",boundNodeId:"operator",coreToken:"fixture",token:"fixture"}];
 const server=await startGatewayHttp(config.edges.map(e=>buildEdge(config,{...e,coreToken:e.coreToken!})),{port:0,host:"127.0.0.1"});
 try{
  config.gatewayPort=server.port!;
  writeFileSync(join(data,"gateway.json"),JSON.stringify(config));
  const observation=await observeGatewayIngress(config);assert.equal(observation.localReady,true);assert.equal(observation.remoteReady,false);
  writeFileSync(join(data,"gateway-ingress.json"),JSON.stringify(observation));
  const current=readGatewayIngress(project,"operator")!;
  assert.equal(current.transportReady,true);assert.equal(current.exactPresenceVerified,false);assert.equal(current.returnRouteVerified,false);
  assert.equal(readGatewayIngress(project,"different-node")!.transportReady,false);
  assert.equal(readGatewayIngress(project,"operator",Date.parse(observation.at)+90_001)!.transportReady,false);
  config.gatewayPort++;writeFileSync(join(data,"gateway.json"),JSON.stringify(config));assert.equal(readGatewayIngress(project,"operator"),null);
 }finally{await server.close();}
});

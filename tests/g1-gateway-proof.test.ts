import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildEdge,startGatewayHttp,type GatewayWorkspaceConfig} from "../hythes/mcp-gateway.ts";
import {recordGatewayAuthenticatedIngress,observeGatewayIngress,readGatewayIngress} from "../hythes/gateway-ingress.ts";

test("G1 authenticated edge ingress is recorded at exact Gateway scope, never promoted to Chat Presence",async()=>{
 const project=mkdtempSync(join(tmpdir(),"sidera-g1-auth-proof-"));
 const config:GatewayWorkspaceConfig={version:1,corePort:1,gatewayPort:0,host:"127.0.0.1",
   edges:[{id:"codex",boundNodeId:"operator",coreToken:"synthetic-core-principal",token:"synthetic-edge-secret"}]};
 const edge=buildEdge(config,{...config.edges[0]!,coreToken:config.edges[0]!.coreToken!});
 const seen:Array<{edgeId:string;instanceId:string;at:string}>=[];
 const listener=await startGatewayHttp([edge],{port:0,host:"127.0.0.1",
  onAuthenticatedIngress:(edgeId,instanceId,at)=>{
   seen.push({edgeId,instanceId,at});
   recordGatewayAuthenticatedIngress(edgeId,instanceId,at);
  }});
 try{
  config.gatewayPort=listener.port!;
  const base="http://127.0.0.1:"+listener.port;
  const denied=await fetch(base+"/mcp",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});
  assert.equal(denied.status,401);
  assert.equal(seen.length,0,"Unauthenticated traffic is never an ingress proof");
  const admitted=await fetch(base+"/mcp",{method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer synthetic-edge-secret",
      accept:"application/json, text/event-stream"},
    body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})});
  await admitted.arrayBuffer();
  assert.equal(seen.length,1,"Authenticated arrival only, regardless of MCP tool outcome");
  assert.equal(seen[0]!.edgeId,"codex");
  const observed=await observeGatewayIngress(config);
  const data=join(project,".sidera-dev","sol","data");
  mkdirSync(data,{recursive:true});
  writeFileSync(join(data,"gateway.json"),JSON.stringify(config));
  writeFileSync(join(data,"gateway-ingress.json"),JSON.stringify(observed));
  const status=readGatewayIngress(project,"operator")!;
  assert.equal(status.transportReady,true);
  assert.equal(status.authenticatedIngressObserved,true);
  assert.equal(status.exactPresenceVerified,false);
  assert.equal(status.returnRouteVerified,false);
  assert.equal(status.chatgptDispatchVerified,false);
  assert.doesNotMatch(JSON.stringify(status),/synthetic-edge-secret|synthetic-core-principal/);
  const future=readGatewayIngress(project,"operator",Date.now()+95_000)!;
  assert.equal(future.transportReady,false);
  assert.equal(future.authenticatedIngressObserved,false);
  assert.equal(readGatewayIngress(project,"unknown-node")!.authenticatedIngressObserved,false);
 }finally{
  await listener.close();
  rmSync(project,{recursive:true,force:true});
 }
});

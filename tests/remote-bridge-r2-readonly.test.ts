import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {canonicalMcpServer,canonicalToolNames} from "../hythes/canonical-mcp.ts";
import {registeredToolOperations} from "../hythes/tool-catalog.ts";
import {relativeBridgePath,authorizeRead} from "../hythes/remote-bridge-readonly-mcp.ts";
import {r2BridgeReadConfig,callR2BridgeRead,R2_BRIDGE_PORT} from "../hythes/remote-bridge-r2-readonly-mcp.ts";

const id="ba3cb7ac-b601-4706-920d-d540960c3b4f";
test("R2 new operations are separately registered without modifying original R0 ones",()=>{
 const names=canonicalToolNames();
 for(const name of ["remote_bridge_list","remote_bridge_read_text",
  "remote_bridge_r2_list","remote_bridge_r2_info","remote_bridge_r2_read_text","remote_bridge_r2_read_many"])
  assert.ok(names.includes(name),name);
 const operations=registeredToolOperations(canonicalMcpServer({port:0,token:"schema-only"}));
 for(const op of ["remote.bridge.r2.list","remote.bridge.r2.info","remote.bridge.r2.read.text","remote.bridge.r2.read.many"])
  assert.ok(operations.has(op),op);
 assert.equal(operations.has("remote.bridge.r2.write.text"),false);
 assert.equal(R2_BRIDGE_PORT,47312);
});
test("R2 credential and Chief identity must be explicitly configured",()=>{
 assert.throws(()=>r2BridgeReadConfig({}),/BRIDGE_R2_READ_CONFIG_UNAVAILABLE/);
 assert.throws(()=>r2BridgeReadConfig({SIDERA_BRIDGE_R2_READONLY_NODE_ID:"not-a-uuid",
  SIDERA_BRIDGE_R2_READONLY_CREDENTIAL_FILE:"C:\\token.secret"}),/BRIDGE_R2_READ_CONFIG_UNAVAILABLE/);
 assert.throws(()=>r2BridgeReadConfig({SIDERA_BRIDGE_R2_READONLY_NODE_ID:id,
  SIDERA_BRIDGE_R2_READONLY_CREDENTIAL_FILE:"relative-token.secret"}),/BRIDGE_R2_READ_CONFIG_UNAVAILABLE/);
 assert.deepEqual(r2BridgeReadConfig({SIDERA_BRIDGE_R2_READONLY_NODE_ID:id,
  SIDERA_BRIDGE_R2_READONLY_CREDENTIAL_FILE:"C:\\token.secret"}),
  {allowedNodeId:id,credentialFile:"C:\\token.secret"});
});
test("unsafe paths cannot be forwarded to local bridge",()=>{
 for(const path of ["../outside","/absolute","C:\\Windows\\secret","a\\b",
  ".git/../../outside","a//b","a/%2e%2e","a:name","a?b","a|b"])
  assert.throws(()=>relativeBridgePath(path),/BRIDGE_RELATIVE_PATH_REQUIRED/,path);
 assert.equal(relativeBridgePath(".",true),".");
 assert.equal(relativeBridgePath("src/lib/paths.js"),"src/lib/paths.js");
});
test("R2 fails Chief authorization before any core call for missing or mismatched binding",async()=>{
 const cfg={allowedNodeId:id,credentialFile:"C:\\dummy.secret"};
 await assert.rejects(authorizeRead({port:1,token:"schema-only"},cfg),/BRIDGE_EXACT_CHIEF_BINDING_REQUIRED/);
 await assert.rejects(authorizeRead({port:1,token:"schema-only",chiefIngressScope:{
    nodeId:"other-node",edgeId:"chatgpt",conversationRef:"https://chatgpt.com/c/exact",bindingId:"b1"
 }},cfg),/BRIDGE_EXACT_CHIEF_BINDING_REQUIRED/);
 await assert.rejects(authorizeRead({port:1,token:"schema-only",chiefIngressScope:{
    nodeId:id,edgeId:"chatgpt",conversationRef:"https://chatgpt.com/c/exact"
 }},cfg),/BRIDGE_EXACT_CHIEF_BINDING_REQUIRED/);
});
test("R2 adapter pins HTTP port and exact read operation; rejects arbitrary effects",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"srb-r2-gateway-test-"));
 const file=join(dir,"token.secret");
 const literal="a".repeat(96);
 writeFileSync(file,literal+"\n");
 const cfg={allowedNodeId:id,credentialFile:file};
 const original=globalThis.fetch;
 let calls=0;
 try{
  globalThis.fetch=(async(input:RequestInfo|URL, init?:RequestInit)=>{
   calls++;
   assert.equal(String(input),"http://127.0.0.1:47312/mcp");
   assert.equal((init?.headers as Record<string,string>)?.Authorization,"Bearer "+literal);
   const body=JSON.parse(String(init?.body));
   assert.equal(body.method,"tools/call");
   assert.equal(body.params.name,"fs.info");
   assert.deepEqual(body.params.arguments,{path:"README.md"});
   return new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{isError:false,
    structuredContent:{status:"ok",operation:"fs.info",result:{kind:"file",size:128}}}}),{status:200});
  }) as typeof fetch;
  const result=await callR2BridgeRead(cfg,"fs.info",{path:"README.md"});
  assert.equal(result.status,"ok");
  assert.equal(result.operation,"fs.info");
  assert.equal(result.readOnly,true);
  assert.equal(calls,1);
  await assert.rejects(callR2BridgeRead(cfg,"fs.write_text" as "fs.info",
    {path:"outside.txt",content:"forbidden"}),/BRIDGE_R2_NOT_A_READ_OPERATION/);
  assert.equal(calls,1);
 }finally{
  globalThis.fetch=original;
  rmSync(dir,{recursive:true,force:true});
 }
});
test("R2 response validation fails closed on errors, oversized results, and missing bearer",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"srb-r2-gateway-denials-"));
 const file=join(dir,"token.secret");writeFileSync(file,"b".repeat(96)+"\n");
 const cfg={allowedNodeId:id,credentialFile:file};
 const original=globalThis.fetch;
 try{
  globalThis.fetch=(async()=>new Response(JSON.stringify({result:{isError:true,
   structuredContent:{status:"error",operation:"fs.info",error:{code:"PATH_SENSITIVE"}}}}),{status:200})) as typeof fetch;
  await assert.rejects(callR2BridgeRead(cfg,"fs.info",{path:"foo"}),/BRIDGE_R2_READ_BLOCKED/);
  globalThis.fetch=(async()=>new Response(JSON.stringify({result:{isError:false,structuredContent:{
   status:"ok",operation:"fs.info",result:{data:"z".repeat(90000)}}}}),{status:200})) as typeof fetch;
  await assert.rejects(callR2BridgeRead(cfg,"fs.info",{path:"foo"}),/BRIDGE_R2_OUTPUT_LIMIT/);
  await assert.rejects(callR2BridgeRead({...cfg,credentialFile:join(dir,"missing")},"fs.info",{path:"foo"}),/BRIDGE_R2_BEARER_UNAVAILABLE/);
 }finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true})}
});

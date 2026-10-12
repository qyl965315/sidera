import {test} from "node:test";
import assert from "node:assert/strict";
import {buildOperationRegistry} from "../hythes/mcp-gateway.ts";
import {bridgeReadConfig,relativeBridgePath,BRIDGE_PORT} from "../hythes/remote-bridge-readonly-mcp.ts";

test("Remote Bridge read-only operations are derived from canonical registry, with no duplicate scheduler",()=>{
 const registry=buildOperationRegistry({port:0,token:"schema-only"});
 for(const op of ["remote.bridge.list","remote.bridge.read.text"]){
  const item=registry.get(op);
  assert.ok(item,op+" registered");
  assert.equal(item?.annotations?.readOnlyHint,true);
  assert.equal(item?.annotations?.destructiveHint,false);
 }
 assert.equal(registry.has("remote.bridge.write.text"),false);
 assert.equal(registry.has("remote.bridge.process.start"),false);
 assert.equal(BRIDGE_PORT,47311);
});
test("Bridge paths cannot escape via traversal, absolute paths, drives, UNC, ADS or control chars",()=>{
 assert.equal(relativeBridgePath("README.txt"),"README.txt");
 assert.equal(relativeBridgePath("notes/alpha.txt"),"notes/alpha.txt");
 assert.equal(relativeBridgePath(".",true),".");
 for(const item of ["../file","foo/../file","/Windows/system32","D:/Windows/win.ini",
   "\\\\server\\share","abc:zone","./README.txt","foo//bar","foo\\bar",
   "hello%2e%2e","file?x=1","foo|whoami","secret\n.txt"]){
   assert.throws(()=>relativeBridgePath(item),/BRIDGE_RELATIVE_PATH_REQUIRED/,item);
 }
});
test("Bridge read callback has no implicit credential or Node fallback",async()=>{
 const registry=buildOperationRegistry({port:0,token:"no-authenticated-session"});
 const v=await registry.get("remote.bridge.read.text")!.invoke({path:"README.txt"}) as {isError?:boolean;content:Array<{text?:string}>};
 assert.equal(v.isError,true);
 const payload=JSON.parse(v.content[0]?.text??"{}");
 assert.ok(/BRIDGE_READ_CONFIG_UNAVAILABLE/.test(payload.code??""));
 assert.throws(()=>bridgeReadConfig({SIDERA_BRIDGE_READONLY_NODE_ID:"unknown",
  SIDERA_BRIDGE_READONLY_CREDENTIAL_FILE:"D:/secret"}),/CONFIG_UNAVAILABLE/);
});

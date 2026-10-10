import {test} from "node:test";
import assert from "node:assert/strict";
import {createConnection} from "node:net";
import {openDatabase} from "../core/db.ts";
import {SideraError} from "../core/types.ts";
import {CoreRuntime} from "../core/runtime.ts";
import {CoreRpcServer} from "../core/rpc.ts";
import {problemView,rpcProblem,SideraProblem,PROBLEM_REGISTRY} from "../core/problem.ts";

test("G1 stable Problem codes are versioned and never imply that a timed-out Effect is replayable",()=>{
 for(const [code,info] of Object.entries(PROBLEM_REGISTRY)){
  assert.equal(info.httpStatus>0,true,code);
  const result=problemView(code as keyof typeof PROBLEM_REGISTRY);
  assert.equal(result.version,"sidera-problem/1");
  assert.equal(result.category,info.category);
  assert.equal(result.effectReplayPolicy,"NEVER_WITHOUT_NO_EFFECT_PROOF");
  assert.ok(result.humanAction.length>0);
  assert.ok(!JSON.stringify(result).includes("secret-credential"));
 }
});
test("G1 legacy denial, not-found and conflict use neutral codes, not fabricated causes",()=>{
 for(const [base,code] of [["denied","SID-CORE-9001"],["not_found","SID-CORE-9002"],
  ["conflict","SID-CORE-9003"],["unavailable","SID-CORE-9004"],["uncertain","SID-CORE-9005"]] as const){
  const result=rpcProblem(new SideraError(base,"secret-credential and private D/E"));
  assert.equal(result.code,code);
  assert.equal(result.category,base);
  assert.doesNotMatch(JSON.stringify(result),/secret-credential|private D\/E/);
 }
 const specific=rpcProblem(new SideraProblem("SID-OBS-2002"));
 assert.equal(specific.code,"SID-OBS-2002");
 assert.equal(specific.retryObservationAllowed,true);
 assert.equal(rpcProblem(new Error("raw-secret-should-not-leak")).code,"SID-CORE-9000");
});
test("G1 RPC preserves legacy error code but includes a redacted machine-readable Problem",async()=>{
 const db=openDatabase(":memory:"),hythes=new Map(),runtime=new CoreRuntime(db,hythes,undefined,{observationOnly:true});
 const rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:()=>null});
 const port=await rpc.listen(0);
 try {
  const reply=await new Promise<Record<string,any>>((resolve,reject)=>{
   const client=createConnection({host:"127.0.0.1",port});
   let buffer="";
   client.on("connect",()=>client.write(JSON.stringify({
    id:"fixture-secret-request",token:"secret-credential",method:"runtime.status",params:{},
   })+"\n"));
   client.on("data",b=>{
    buffer+=b.toString("utf8");
    const index=buffer.indexOf("\n");
    if(index>=0){try{resolve(JSON.parse(buffer.slice(0,index)));}
    catch(e){reject(e);}client.destroy();}
   });
   client.on("error",reject);
   client.setTimeout(3000,()=>{client.destroy();reject(new Error("RPC test timeout"));});
  });
  assert.equal(reply.error.code,"denied");
  assert.equal(reply.error.problem.category,"denied");
  assert.equal(reply.error.problem.code,"SID-CORE-9001");
  assert.equal(reply.error.problem.effectReplayPolicy,"NEVER_WITHOUT_NO_EFFECT_PROOF");
  assert.doesNotMatch(JSON.stringify(reply.error.problem),/secret-credential|fixture-secret-request/);
 }finally{await rpc.close();runtime.close();db.close();}
});

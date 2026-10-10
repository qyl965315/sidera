import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../core/db.ts";
import { issueGrant, revokeGrant, setAuthorityConstraint } from "./fixtures/authority.ts";
import { issueGrant as rawGrant, canUseCapability, reserveCapability, settleReservation, effectiveHumanRoot } from "../core/authority.ts";
import { recordWorld } from "../core/worlds.ts";
import { humanProof } from "./fixtures/human.ts";
import { CoreRuntime } from "../core/runtime.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { callCore } from "../hythes/core-client.ts";
import type { GrantRecord } from "../core/types.ts";

function fixture(){
  const db=openDatabase(":memory:"),now=new Date().toISOString();
  for(const id of ["a","b","c"]){
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id,id,now);
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run(`s-${id}`,id,`loc-${id}`,now);
    db.prepare("INSERT INTO model_bindings VALUES (?,?,?,'model-a','{}',?,NULL,NULL)").run(`m-${id}`,id,"fixture",now);
  }
  return db;
}
const act=(subjectNodeId:string,requestId=randomUUID())=>({subjectNodeId,sessionId:`s-${subjectNodeId}`,capability:"file.write",resource:"node/c/files/a",requestId,riskLevel:1});

test("CA-21/22 derived Grants transitively narrow every boundary and share ancestor budget",()=>{
  const db=fixture();try{
    const root=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"a",capability:"file.*",resourceScope:"node/c/**",limit:2,delegable:true,riskCeiling:2,
      modelScope:["model-a","model-b"],expiresAt:new Date(Date.now()+60000).toISOString()});
    const child=issueGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/files/**",delegable:true,parentGrantId:root.grantId,modelScope:["model-a"]});
    const leaf=issueGrant(db,{kind:"node",nodeId:"b"},{subjectNodeId:"c",capability:"file.write",resourceScope:"node/c/files/a",parentGrantId:child.grantId,limit:1});
    assert.equal(leaf.parentGrantId,child.grantId);assert.equal(effectiveHumanRoot(db,leaf),true);
    for(const change of [{capability:"process.run"},{resourceScope:"node/a/**"},{modelScope:["model-c"]},{limit:3},{expiresAt:null},{riskCeiling:3}])
      assert.throws(()=>issueGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/files/a",parentGrantId:root.grantId,...change}),{code:"denied"});
    assert.throws(()=>issueGrant(db,{kind:"node",nodeId:"c"},{subjectNodeId:"a",capability:"file.write",resourceScope:"node/c/files/a",parentGrantId:leaf.grantId}),{code:"denied"});
    const first=reserveCapability(db,act("c"));settleReservation(db,first.reservationId!,"consumed");
    assert.equal(canUseCapability(db,act("c")),false);
    reserveCapability(db,act("b"));assert.equal(canUseCapability(db,act("a")),false);
    assert.equal(db.prepare("SELECT count(*) n FROM grant_uses").get()!.n,2);
  }finally{db.close();}
});

test("CA-23 ancestor revocation and expiry invalidate descendants and existing reservations",t=>{
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const db=fixture();try{
    const root=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"a",capability:"file.write",resourceScope:"node/c/**",delegable:true,expiresAt:new Date(Date.now()+10000).toISOString()});
    const child=issueGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/**",parentGrantId:root.grantId});
    const request=act("b");reserveCapability(db,request);
    t.mock.timers.tick(11000);assert.equal(canUseCapability(db,act("b")),false);assert.throws(()=>reserveCapability(db,request),{code:"denied"});
    const other=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"a",capability:"file.write",resourceScope:"node/c/**",delegable:true});
    issueGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"c",capability:"file.write",resourceScope:"node/c/**",parentGrantId:other.grantId});
    const request2=act("c");reserveCapability(db,request2);
    revokeGrant(db,{kind:"human",id:"owner"},{requestId:"revoke",grantId:other.grantId});
    assert.throws(()=>reserveCapability(db,request2),{code:"denied"});assert.equal(canUseCapability(db,act("c")),false);
    assert.ok(child.parentGrantId);
  }finally{db.close();}
});

test("CA-24/25/46 request carries no Authority, exact Human object does, executor uses its own Grant",()=>{
  const db=fixture();try{
    assert.throws(()=>rawGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/**"}),{code:"denied"});
    const input={subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/**"};
    const proof=humanProof(db,recordWorld(db,"nodes","b"),"owner",{type:"authority.grant",objectRef:"b",scope:input.resourceScope,targetRevision:null,args:input,causalRefs:["fixture:structured-object"]});
    assert.throws(()=>rawGrant(db,{kind:"human",...proof},{...input,delegable:true}),{code:"denied"});
    const own=rawGrant(db,{kind:"human",...proof},input);
    assert.equal(reserveCapability(db,act("b")).grantId,own.grantId);assert.equal(canUseCapability(db,act("a")),false);
    assert.equal(Number(db.prepare("SELECT count(*) n FROM shared_history WHERE kind='Grant'").get()!.n)>=1,true);
  }finally{db.close();}
});

test("Derived Grants have no universal max depth; explicit lower boundary and ModelBinding remain enforced",()=>{
  const db=fixture();try{
    let grant=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"a",capability:"file.write",resourceScope:"node/c/**",delegable:true,modelScope:["model-a"]});
    for(let i=0;i<24;i++)grant=issueGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"a",capability:"file.write",resourceScope:"node/c/**",delegable:true,parentGrantId:grant.grantId});
    assert.equal(canUseCapability(db,act("a")),true);
    assert.throws(()=>reserveCapability(db,{...act("a"),modelId:"model-b"}),{code:"denied"});
    db.prepare("UPDATE model_bindings SET valid_until=? WHERE node_id='a'").run(new Date().toISOString());
    db.prepare("INSERT INTO model_bindings VALUES ('new-model','a','fixture','model-b','{}',?,NULL,'m-a')").run(new Date().toISOString());
    assert.equal(canUseCapability(db,act("a")),false);
    const bounded=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/**",delegable:true,maxDelegationDepth:0});
    assert.throws(()=>issueGrant(db,{kind:"node",nodeId:"b"},{subjectNodeId:"c",capability:"file.write",resourceScope:"node/c/**",parentGrantId:bounded.grantId}),{code:"denied"});
  }finally{db.close();}
});

test("A subject constraint cannot be laundered through an otherwise valid Derived Grant",()=>{
  const db=fixture();try{
    const root=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"a",capability:"file.*",resourceScope:"node/c/**",delegable:true});
    issueGrant(db,{kind:"node",nodeId:"a"},{subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/**",parentGrantId:root.grantId});
    const action=act("b");reserveCapability(db,action);
    setAuthorityConstraint(db,{kind:"human",id:"owner"},{constraintId:"production",subjectNodeId:"a",resourceScope:"node/c/files/**",reason:"Human restricted production domain",active:true});
    assert.equal(canUseCapability(db,act("b")),false);assert.throws(()=>reserveCapability(db,action),{code:"denied"});
  }finally{db.close();}
});

test("Actual grant.delegate RPC preserves extended boundaries and rejects explicit-null widening",async()=>{
  const db=fixture(),runtime=new CoreRuntime(db,new Map()),rpc=new CoreRpcServer(db,runtime,new Map(),{authenticate:token=>token==="fixture"?{kind:"node",nodeId:"a",sessionId:"s-a"}:null});
  try{
    const parent=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"a",capability:"file.*",resourceScope:"node/c/**",limit:4,delegable:true,
      projectRef:"project-exact",modelScope:["model-a","model-b"],maxDelegationDepth:2,expiresAt:new Date(Date.now()+60000).toISOString()});
    const port=await rpc.listen(),request={requestId:randomUUID(),parentGrantId:parent.grantId,subjectNodeId:"b",capability:"file.write",resourceScope:"node/c/files/**",limit:2,
      worldId:recordWorld(db,"nodes","a"),projectRef:"project-exact",modelScope:["model-a"],maxDelegationDepth:1,
      validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),productScope:"*",effectScope:"admission",disclosureScope:"UNKNOWN",riskCeiling:1};
    const result=await callCore({port,token:"fixture"},"grant.delegate",request) as GrantRecord;
    assert.equal(result.parentGrantId,parent.grantId);assert.equal(result.projectRef,request.projectRef);assert.equal(result.worldId,request.worldId);
    assert.deepEqual(result.modelScope,["model-a"]);assert.equal(result.maxDelegationDepth,1);assert.equal(result.validFrom,request.validFrom);assert.equal(result.limit,2);
    await assert.rejects(callCore({port,token:"fixture"},"grant.delegate",{...request,requestId:randomUUID(),modelScope:null}),/denied/);
    await assert.rejects(callCore({port,token:"fixture"},"grant.delegate",{...request,requestId:randomUUID(),expiresAt:null}),/denied/);
  }finally{await rpc.close();runtime.close();db.close();}
});

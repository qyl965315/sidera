import assert from "node:assert/strict";
import {test} from "node:test";
import {openDatabase} from "../core/db.ts";
import {SemanticStore} from "./fixtures/human.ts";
import {createWorld} from "../core/worlds.ts";
import {capabilityTruth,recordCapabilityCheck} from "../core/capability-truth.ts";
import {canUseCapability} from "../core/authority.ts";
import {constitutionalRpc,isConstitutionalMethod} from "../core/constitutional-rpc.ts";
import {canonicalToolNames} from "../hythes/canonical-mcp.ts";
import {currentOmega,readHistory} from "../core/history.ts";
import {discoverNode} from "../core/control-plane.ts";

function fixture(){const db=openDatabase(":memory:"),world=createWorld(db,"C","fixture"),store=new SemanticStore(db,world),node=store.registerNode("Operator");
 db.prepare("INSERT INTO sessions VALUES ('ctx',?,'fixture','fixture','exact','active','now')").run(node);return {db,world,node,caller:{kind:"node" as const,nodeId:node,sessionId:"ctx"}};}

test("C19-20/40-42 technical truth has two states; freshness and Authority remain independent",()=>{
 const f=fixture();try{
  const initial=capabilityTruth(f.db,f.node,"ctx","workspace.write");assert.equal(initial.availability,"unavailable");assert.equal(initial.freshness,"UNKNOWN");assert.equal(initial.verifyTaskSuggested,true);
  recordCapabilityCheck(f.db,{nodeRef:f.node,sessionRef:"ctx",operation:"workspace.write",available:true,sourceRef:"fixture:actual-operation",expiresAt:new Date(Date.now()+5000).toISOString()});
  const available=capabilityTruth(f.db,f.node,"ctx","workspace.write");assert.equal(available.availability,"available");assert.equal(available.freshness,"CURRENT");
  assert.equal(canUseCapability(f.db,{subjectNodeId:f.node,sessionId:"ctx",capability:"workspace.write",resource:"production/repo",requestId:"check"}),false);
  assert.equal(capabilityTruth(f.db,f.node,"ctx","workspace.write",false,Date.now()+6000).freshness,"STALE");
  assert.equal(capabilityTruth(f.db,f.node,"ctx","workspace.write",false,Date.now()+6000).availability,"unavailable");
  recordCapabilityCheck(f.db,{nodeRef:f.node,sessionRef:"ctx",operation:"workspace.write",available:false,sourceRef:"fixture:failed-real-operation"});
  assert.equal(capabilityTruth(f.db,f.node,"ctx","workspace.write").availability,"unavailable");
  const declared=discoverNode(f.db,new Map([["fixture",{hytheId:"fixture",hostKind:"fixture",manifest:()=>({version:1 as const,hytheId:"fixture",hostKind:"fixture",operations:[{operation:"shell.execute",backendOperation:"shell.execute",supported:true,routeClass:"native" as const,effect:"write" as const,retry:"reconcile" as const,backend:"fixture"}],transportCapabilities:[]})} as never]]),f.node);
  assert.equal(declared.capabilities[0].availability,"unavailable","Inventory alone must not assert operational truth");assert.equal(declared.capabilities[0].declaredSupported,true);
 }finally{f.db.close();}
});

test("Canonical MCP exposes typed constitutional operations but no generic state/sovereignty mutation",()=>{
 const names=canonicalToolNames();for(const name of ["history_list","omega_inspect","claim_publish","rules_propose","task_rules_adopt","consequence_apply","executor_list","executor_assign","chief_conversation_role"])
  assert.ok(names.includes(name),name);
 for(const method of ["omega.apply","history.append","world.rules.mutate","subjectivity.read_other","basic.rewrite"])assert.equal(isConstitutionalMethod(method),false,method);
 const f=fixture();try{const before=JSON.stringify(currentOmega(f.db));
  const record=constitutionalRpc(f.db,f.caller,"claim.publish",{requestId:"claim",claim:"The nonexistent task completed and all outputs are correct"}) as {id:string};
  assert.equal(readHistory(f.db,{worldRef:f.world}).find(r=>r.id===record.id)?.kind,"Claim");assert.equal(JSON.stringify(currentOmega(f.db)),before);
  assert.throws(()=>constitutionalRpc(f.db,f.caller,"omega.inspect",{worldId:"another"}),{code:"denied"});
  const view=constitutionalRpc(f.db,f.caller,"console.inspect",{}) as {kind:string;isNode:boolean;hasSovereignty:boolean};
  assert.equal(view.kind,"Console");assert.equal(view.isNode,false);assert.equal(view.hasSovereignty,false);
 }finally{f.db.close();}
});

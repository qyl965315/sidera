import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { bindChiefConversation, ChiefDispatch } from "./fixtures/chief.ts";
import { HumanBoundary, type HumanRoute } from "../hythes/human-boundary.ts";
import { ChatGptNativeRoute } from "../hythes/chatgpt-native.ts";
import { hostManifest } from "../hythes/manifest.ts";
import { boundaryEvent, observeBoundary } from "../core/boundary.ts";
import { uncertainEffects, reconcileEffect } from "../core/effects.ts";
import { humanProof } from "./fixtures/human.ts";
import { recordWorld } from "../core/worlds.ts";
import { providerAdmissionProfile } from "../hythes/effect-control.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";

function fixture(file=":memory:") {
 const db=openDatabase(file);
 db.prepare("INSERT OR IGNORE INTO nodes VALUES ('chief','Chief','active',?)").run(new Date().toISOString());
 const binding=bindChiefConversation(db,{kind:"human"},{projectSpaceId:"project",projectRef:"fixture",chiefNodeId:"chief",frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/existing"});
 return {db,binding};
}
function route(id:string,routeClass:"native"|"protocol"|"ui-fallback",invoke:HumanRoute["invoke"]):HumanRoute {
 return {id,routeClass,invoke,effectProfile:()=>providerAdmissionProfile("fixture","fixture admission"),manifest:hostManifest({hytheId:id,hostKind:"fixture"},{operations:["conversation.locate","conversation.read","conversation.send","conversation.observe"],routeClass,createsSession:false})};
}
const boundaryFixture:EffectBoundary={cross:(_target,send)=>send()};
test("A/B/H: logical binding survives route replacement/auth loss; runtime cannot create Human Chat",async()=>{
 const {db,binding}=fixture();
 try {
  const broken=new HumanBoundary(db,[route("isolated-ui","ui-fallback",async()=>({status:"rejected",beforeEffect:true,reason:"login_required"}))]);
  assert.equal((await broken.inspect(binding)).ready,false);
  assert.equal(db.prepare("SELECT lifecycle FROM nodes").get()?.lifecycle,"active");
  assert.equal(db.prepare("SELECT state FROM chief_conversations").get()?.state,"active");
  const native=new HumanBoundary(db,[route("native","native",async()=>({status:"host_confirmed",data:{located:true}}))]);
  assert.equal((await native.inspect(binding)).ready,true);
  assert.equal(db.prepare("SELECT binding_id FROM chief_conversations").get()?.binding_id,binding.bindingId);
  assert.equal(db.prepare("SELECT count(*) n FROM chief_conversations").get()?.n,1);
  const backend=new ChatGptNativeRoute("unused","unused");
  const denied=await backend.invoke("conversation.create",binding);
  assert.equal(denied.status,"rejected");assert.equal(denied.beforeEffect,true);
 }finally{db.close();}
});
test("C/D/J: safe equivalent reads fail over; exact errors and last-known timestamp survive restart",async()=>{
 const file=join(mkdtempSync(join(tmpdir(),"sidera-boundary-")),"world.sqlite");let {db,binding}=fixture(file);
 const candidates=[{id:"a",routeClass:"native" as const,logicalLocator:binding.conversationRef,invoke:async()=>{throw Error("MCP SSE 429");}},
  {id:"b",routeClass:"protocol" as const,logicalLocator:binding.conversationRef,invoke:async()=>({status:"host_confirmed",task:{state:"running"}})}];
 const live=await observeBoundary(db,"chief",binding.conversationRef,"conversation.read",candidates);
 assert.equal(live.selectedRoute,"b");assert.equal(live.observation,"live");assert.equal(live.rawRouteErrors[0]?.error,"MCP SSE 429");
 db.close();db=openDatabase(file);
 try {
  candidates[1]!.invoke=async()=>{throw Error("404 Session terminated");};
  const stale=await observeBoundary(db,"chief",binding.conversationRef,"conversation.read",candidates);
  assert.equal(stale.observation,"last-known");assert.equal(stale.lastKnownAt,live.at);
  assert.deepEqual(stale.lastKnown,live.data);assert.equal(stale.rawRouteErrors[1]?.error,"404 Session terminated");
  assert.equal(db.prepare("SELECT count(*) n FROM tasks").get()?.n,0);
 }finally{db.close();}
});
test("E: uncertain presentation blocks alternate write route even if another route is healthy",async()=>{
 const {db,binding}=fixture();let writes=0,fallback=0;
 try {
  const boundary=new HumanBoundary(db,[route("native","native",async operation=>{if(operation!=="conversation.send")return {status:"host_confirmed",data:{located:true,conversationRef:binding.conversationRef}};writes++;return {status:"uncertain",reason:"Host may have accepted"};}),
   route("ui","ui-fallback",async()=>{fallback++;return {status:"accepted",hostRef:"unexpected"};})]);
  assert.equal((await boundary.verifyPresence(binding)).prepared,true);
  const result=await boundary.deliver(binding,{messageId:"effect-1",body:"reviewed"},boundaryFixture);
  assert.equal(result.status,"uncertain");assert.equal(writes,1);assert.equal(fallback,0);
 }finally{db.close();}
});
test("I/J: Effect query derives canonical unresolved intent; reconciliation retains provenance and never permits automatic retry",()=>{
 const file=join(mkdtempSync(join(tmpdir(),"sidera-effects-")),"world.sqlite");let {db}=fixture(file);
 const source=boundaryEvent(db,"chief","host.control.started",{requestId:"unique",resource:"node/chief",locatorRef:"exact",
  fingerprint:JSON.stringify({operation:"conversation.send"})});
 const effectId=`control:${source}`;const evidence=boundaryEvent(db,null,"maintenance.inspected",{effectId,observation:"Completion unprovable"});
 try {
  assert.equal(uncertainEffects(db)[0]?.state,"OPEN_UNCERTAIN");
  assert.throws(()=>reconcileEffect(db,{kind:"node",nodeId:"chief"},{effectId,state:"OBSERVED_COMPLETED",reason:"guess",evidenceEventIds:[evidence],expectedRevision:0}),{code:"denied"});
  const result=reconcileEffect(db,{kind:"node",nodeId:"chief"},{effectId,state:"OPEN_UNCERTAIN",reason:"Observed closed turn; external effect unknown",evidenceEventIds:[evidence],expectedRevision:0});
  assert.equal(result.effect?.safeToRetry,false);
  db.close();db=openDatabase(file);
  const view=uncertainEffects(db)[0]!;assert.equal(view.state,"OPEN_UNCERTAIN");assert.equal(view.reconciliation.length,1);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE event_id=?").get(source));
  assert.throws(()=>reconcileEffect(db,{kind:"node",nodeId:"chief"},{effectId,state:"HUMAN_ADJUDICATED",reason:"pretend",evidenceEventIds:[evidence],expectedRevision:1}),{code:"denied"});
  const adjudication={effectId,state:"HUMAN_ADJUDICATED" as const,reason:"Keep as reviewed historical uncertainty",evidenceEventIds:[evidence],expectedRevision:1};
  const effect=uncertainEffects(db).find(e=>e.effectId===effectId)!;
  const proof=humanProof(db,recordWorld(db,"nodes",effect.actorNodeId!),"test",{type:"effect.adjudicate",objectRef:effectId,scope:effect.resource,targetRevision:null,args:adjudication,causalRefs:[evidence]});
  const resolved=reconcileEffect(db,{kind:"human",...proof},adjudication);
  assert.equal(resolved.effect?.state,"HUMAN_ADJUDICATED");assert.equal(resolved.effect?.safeToRetry,false);
 }finally{db.close();}
});
test("HumanObserved requires actual message identity; preview or acceptance alone never proves presentation",async()=>{
 const {db,binding}=fixture();let actual=false;
 const marker=`SIDERA_PRESENTATION:${binding.bindingId}:message-1`;
 try {
  const boundary=new HumanBoundary(db,[route("native","native",async operation=>operation==="conversation.send"?{status:"accepted",hostRef:"host-turn"}:
   {status:"host_confirmed",data:{located:true,conversationRef:binding.conversationRef,preview:marker,turns:[{items:actual?[{id:"actual-message",type:"userMessage",content:[{text:marker+"\nreviewed"}]}]:[]}]}})]);
  assert.equal((await boundary.verifyPresence(binding)).prepared,true);
  assert.equal((await boundary.deliver(binding,{messageId:"message-1",body:"reviewed"},boundaryFixture)).humanObserved,"unknown");
  actual=true;assert.equal(await boundary.observePresentation(binding,"message-1"),true);
  await boundary.observePresentation(binding,"message-1");
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='HumanObserved'").get()?.n,1);
 }finally{db.close();}
});

test("Human presentation passes the exact final boundary and rejects an ungoverned send",async()=>{
 const {db,binding}=fixture();let sent=0;
 try{
  const frontend=new HumanBoundary(db,[route("native","native",async(operation,selected,_input,boundary)=>{
   if(operation!=="conversation.send")return {status:"host_confirmed",data:{located:true,conversationRef:selected.conversationRef}};
   return boundary!.cross({product:selected.frontendKind,locator:selected.conversationRef,operation},()=>{sent++;return {status:"accepted",hostRef:"fixture"};});
  })]);
  assert.equal((await frontend.verifyPresence(binding)).prepared,true);assert.equal(frontend.effectProfile(binding)?.externalIdentityRequired,true);
  await assert.rejects(frontend.deliver(binding,{messageId:"no-permit",body:"fixture"}),/Final Core Effect boundary/);assert.equal(sent,0);
  await frontend.deliver(binding,{messageId:"permit",body:"fixture"}, {cross:(target,send)=>{
   assert.deepEqual(target,{product:"chatgpt-web",locator:binding.conversationRef,operation:"conversation.send"});return send();
  }});assert.equal(sent,1);
 }finally{db.close();}
});

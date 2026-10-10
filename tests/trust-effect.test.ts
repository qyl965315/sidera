import assert from "node:assert/strict";
import { test,type TestContext } from "node:test";
import { randomUUID,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase,withTransaction } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { admitHumanAct,openHumanIngress,recordInterpretation,explicitHumanStatement,canonical,type HumanProposal } from "../core/human-admission.ts";
import { issueGrant as rawGrant,reserveCapability,canUseCapability,settleReservation } from "../core/authority.ts";
import { issueGrant,revokeGrant,setAuthorityConstraint } from "./fixtures/authority.ts";
import { humanProof,intentProof } from "./fixtures/human.ts";
import { prepareEffect,effectBoundary,effectKnowledge,recoverEffects,observeEffect,reconciliationProducer,bindFrontendAccount,
  executionReality,recordExecutionProgress,setEffectPolicy,bindPresenceIdentity,type EffectRequest,type EffectControlProfile } from "../core/effect-gate.ts";
import { mockProfile } from "./fixtures/execution.ts";
import { controlHost } from "../core/host-control.ts";
import { getTask } from "../core/scheduler.ts";
import { Continuations } from "./fixtures/execution.ts";
import type { Hythe } from "../hythes/types.ts";
import { reconcileResourceLoss,recordConfirmedResourceLoss } from "../core/reconciliation.ts";
import { createHostResource } from "../core/session-effects.ts";
import { bindChiefConversation } from "./fixtures/chief.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";
import { HostLifecycle, type PhysicalHostExit } from "../hythes/lifecycle.ts";

function fixture(t:TestContext,disk=false) {
  const file=disk?join(mkdtempSync(join(tmpdir(),"sidera-mtwo-")),"state.sqlite"):":memory:";
  let db=openDatabase(file),store:SemanticStore;
  t.after(()=>{if(db.isOpen)db.close();});
  const world=createWorld(db,"M2 synthetic World","fixture only");store=new SemanticStore(db,world);
  const human=store.createHuman("Human","fixture principal"),actor=store.registerNode("Actor"),target=store.registerNode("Target");
  for(const id of [actor,target]){
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(`${id}-session`,id,`mock://${id}`);
    recordFixtureHostAvailable(db,`${id}-session`);
  }
  const session=`${actor}-session`,targetSession=`${target}-session`;
  const intent=store.createIntent(human,"fixture empty intent");
  let count=0;
  const f={db,store,world,human,actor,target,session,targetSession,intent,file,
    reopen(){db.close();db=openDatabase(file);store=new SemanticStore(db,world);this.db=db;this.store=store;recoverEffects(db);},
    grant(extra:Record<string,unknown>={}) {return issueGrant(db,{kind:"human",id:human},{subjectNodeId:actor,capability:"business.write",resourceScope:`node/${target}`,productScope:"mock",...extra});},
    request(actionId=store.logicalAction(actor,target,"business.write",`fixture:causal:${randomUUID()}`)):EffectRequest {
      return {actionId,attemptId:store.attempt(actionId,targetSession),actorSessionId:session,capability:"business.write",
        resource:`node/${target}`,requestId:randomUUID(),payload:{text:"same semantic text"},profile:mockProfile};
    },
    send(request:EffectRequest,permit=prepareEffect(db,request)) {return effectBoundary(db,permit,request).cross({product:"mock",locator:`mock://${target}`,operation:"business.write"},()=>++count);},
    count(){return count;},
    proposal(content="new goal",parentRevisionId:string|null=null):HumanProposal {return {type:"intent.revise",objectRef:intent,scope:`intent/${intent}`,targetRevision:parentRevisionId,
      args:{intentId:intent,parentRevisionId,content,sourceRef:"fixture:human"},causalRefs:["fixture:primary surface"]};},
  };return f;
}

async function witnessedLossProof(db:ReturnType<typeof openDatabase>,sessionId:string) {
 const lifecycle=new HostLifecycle();let physicalExit:PhysicalHostExit|undefined;
 lifecycle.subscribe(event=>{physicalExit=event.physicalExit;});
 const child=spawn(process.execPath,["-e","process.exit(25)"],{windowsHide:true});
 lifecycle.watchChildExit(child,"trust fixture child exited");await once(child,"exit");
 if(!physicalExit)throw Error("physical child exit was not witnessed");
 return recordConfirmedResourceLoss(db,{sessionId,physicalExit});
}

test("Frontend final gate requires its own admitted account; Runtime account is not a substitute",t=>{
 const f=fixture(t);const binding=bindChiefConversation(f.db,{kind:"human",id:f.human},{projectSpaceId:"fixture",projectRef:"fixture",chiefNodeId:f.actor,frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/exact"});
 const identity=f.store.addExternalIdentity(f.human,"chatgpt-web","fixture-account","fixture authenticated Host");
 const runtime={worldId:f.world,sessionId:f.session,identityId:identity};
 bindPresenceIdentity(f.db,humanProof(f.db,f.world,f.human,{type:"identity.bind_presence",objectRef:f.session,scope:`identity/${identity}`,targetRevision:null,args:runtime,causalRefs:["fixture Host"]}),runtime);
 f.grant({capability:"self.frontend.receive",resourceScope:`node/${f.actor}/frontend/${binding.bindingId}`,productScope:"chatgpt-web"});
 const actionId=f.store.logicalAction(f.actor,f.actor,"conversation.send","fixture presentation");
 const request:EffectRequest={actionId,attemptId:f.store.attempt(actionId,f.session),actorSessionId:f.session,capability:"self.frontend.receive",resource:`node/${f.actor}/frontend/${binding.bindingId}`,requestId:"presentation",payload:{body:"fixture"},profile:{...mockProfile,externalIdentityRequired:true},frontendBindingId:binding.bindingId};
 assert.throws(()=>prepareEffect(f.db,request),/ExternalIdentity UNKNOWN/);
 const input={worldId:f.world,bindingId:binding.bindingId,identityId:identity};
 assert.throws(()=>bindFrontendAccount(f.db,{id:f.human,actId:"unadmitted"},input),/Exact admitted Human act/);
 const proof=humanProof(f.db,f.world,f.human,{type:"presence.frontend.bind",objectRef:binding.bindingId,scope:`frontend/${binding.bindingId}`,targetRevision:null,args:input,causalRefs:["fixture authenticated frontend"]});
 bindFrontendAccount(f.db,proof,input);
 const permit=prepareEffect(f.db,request);let sent=0;
 f.db.prepare("UPDATE chief_conversations SET state='retired' WHERE binding_id=?").run(binding.bindingId);
 assert.throws(()=>effectBoundary(f.db,permit,request).cross({product:"chatgpt-web",locator:binding.conversationRef,operation:"conversation.send"},()=>sent++),/active or task-pinned frontend binding/);
 assert.equal(sent,0);
});

test("M2-T01 schema-valid Node InterpretationClaim cannot establish Human state",t=>{
  const f=fixture(t),proposal=f.proposal();
  const claim=recordInterpretation(f.db,{worldId:f.world,nodeId:f.actor,proposal});
  assert.throws(()=>admitHumanAct(f.db,{worldId:f.world,humanId:f.human,proposal}),{code:"denied"});
  assert.throws(()=>f.store.reviseIntent(f.intent,null,"new goal","fixture:human",{id:f.human,actId:claim}),{code:"denied"});
  assert.equal(f.db.prepare("SELECT count(*) n FROM intent_revisions").get()!.n,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n,0);
});
test("M2-T02 confidence=1 and confirmed=true cannot replace Human origin",t=>{
  const f=fixture(t),proposal=f.proposal();
  recordInterpretation(f.db,{worldId:f.world,nodeId:f.actor,proposal,confidence:1,confirmed:true});
  assert.throws(()=>admitHumanAct(f.db,{worldId:f.world,humanId:f.human,proposal}),{code:"denied"});
  assert.throws(()=>rawGrant(f.db,{kind:"human",id:f.human},{subjectNodeId:f.actor,capability:"*",resourceScope:"*"}),{code:"denied"});
  assert.equal(f.db.prepare("SELECT count(*) n FROM grants").get()!.n,0);
});
test("M2-T03 attributable Primary Surface clarification admits and atomically applies exact Human act",t=>{
  const f=fixture(t),source=openHumanIngress(f.db,{worldId:f.world,humanId:f.human,presenceRef:"primary:human-chat",sourceRef:"authenticated:human-test"});
  const ambiguous=source.capture("human-1","Maybe change something, or leave it.");
  assert.throws(()=>admitHumanAct(f.db,{worldId:f.world,humanId:f.human,utteranceId:ambiguous,proposal:f.proposal()}),{code:"denied"});
  const utteranceId=source.capture("human-2",explicitHumanStatement(f.proposal()),ambiguous);
  const proof=admitHumanAct(f.db,{worldId:f.world,humanId:f.human,utteranceId,proposal:f.proposal()});
  const revision=f.store.reviseIntent(f.intent,null,"new goal","fixture:human",proof);
  assert.equal(f.store.currentIntent(f.intent).candidates[0]!.revision_id,revision);
  const evidence=f.db.prepare("SELECT * FROM human_semantic_acts WHERE act_id=?").get(proof.actId)!;
  assert.equal(evidence.world_id,f.world);assert.equal(evidence.human_id,f.human);assert.equal(evidence.source_id,source.sourceId);
  assert.ok(JSON.parse(String(evidence.causal_refs_json)).includes(ambiguous));
  assert.throws(()=>f.store.reviseIntent(f.intent,null,"new goal","fixture:human",proof),/UNIQUE/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM intent_revisions").get()!.n,1);
});
test("M2-T04 foreign World, altered object and obsolete Intent evidence are rejected",t=>{
  const f=fixture(t),proposal=f.proposal(),source=openHumanIngress(f.db,{worldId:f.world,humanId:f.human,presenceRef:"primary",sourceRef:"fixture"});
  const utteranceId=source.capture("one",explicitHumanStatement(proposal));
  assert.throws(()=>admitHumanAct(f.db,{worldId:createWorld(f.db,"Other","fixture"),humanId:f.human,utteranceId,proposal}),{code:"denied"});
  assert.throws(()=>admitHumanAct(f.db,{worldId:f.world,humanId:f.human,utteranceId,proposal:{...proposal,objectRef:"other"}}),{code:"denied"});
  const p=admitHumanAct(f.db,{worldId:f.world,humanId:f.human,utteranceId,proposal});
  const r=f.store.reviseIntent(f.intent,null,"new goal","fixture:human",p);
  const p2=intentProof(f.store,f.intent,r,"next","fixture:next");f.store.reviseIntent(f.intent,r,"next","fixture:next",p2);
  const obsolete=f.proposal("old parent",r),old=source.capture("obsolete",explicitHumanStatement(obsolete));
  assert.throws(()=>admitHumanAct(f.db,{worldId:f.world,humanId:f.human,utteranceId:old,proposal:obsolete}),{code:"denied"});
});
test("M2-T05 Node cannot mint Authority; self prefix alone is also denied",t=>{
  const f=fixture(t);
  assert.throws(()=>rawGrant(f.db,{kind:"node",nodeId:f.actor},{subjectNodeId:f.actor,capability:"*",resourceScope:"*"}),{code:"denied"});
  assert.throws(()=>reserveCapability(f.db,{subjectNodeId:f.actor,sessionId:f.session,capability:"self.modify",resource:`node/${f.actor}`,requestId:"self"}),{code:"denied"});
});
test("M2-T06 legacy delegation and Human-looking issuer remain historical, ineffective under v1",t=>{
  const f=fixture(t),root=f.grant({delegable:true});
  f.db.prepare("INSERT INTO grants(grant_id,subject_node_id,capability,resource_scope,issuer,delegable,parent_grant_id) VALUES ('legacy',?,'business.write',?,'node:old',0,?)")
    .run(f.target,`node/${f.actor}`,root.grantId);
  f.db.prepare("INSERT INTO grants(grant_id,subject_node_id,capability,resource_scope,issuer,delegable) VALUES ('unproven',?,'self.*',?,'human:old',0)").run(f.target,`node/${f.target}`);
  assert.equal(canUseCapability(f.db,{subjectNodeId:f.target,sessionId:f.targetSession,capability:"business.write",resource:`node/${f.actor}`,requestId:"legacy"}),false);
  assert.equal(canUseCapability(f.db,{subjectNodeId:f.target,sessionId:f.targetSession,capability:"self.modify",resource:`node/${f.target}`,requestId:"unproven"}),false);
  assert.throws(()=>rawGrant(f.db,{kind:"node",nodeId:f.actor},{subjectNodeId:f.target,capability:"business.write",resourceScope:`node/${f.actor}`,parentGrantId:root.grantId}),{code:"denied"});
  assert.equal(f.db.prepare("SELECT count(*) n FROM grants").get()!.n,3);
  assert.equal(f.db.prepare("SELECT delegation_enabled FROM trust_policy WHERE world_id=?").get(f.world)!.delegation_enabled,0);
});
test("M2-T07 standing grant binds World, Node, Product, capability, effect and resource scope",t=>{
  const f=fixture(t),grant=f.grant();
  for(const change of [{capability:"different.write"},{resource:`node/${f.actor}`},{actorSessionId:f.targetSession},{finalProduct:"other-product"},{requestedControl:"post_admission_revocable" as const}])
    assert.throws(()=>prepareEffect(f.db,{...f.request(),...change}));
  const otherWorld=createWorld(f.db,"Other","fixture"),other=new SemanticStore(f.db,otherWorld).registerNode("Other");
  assert.throws(()=>reserveCapability(f.db,{subjectNodeId:f.actor,sessionId:f.session,capability:"business.write",resource:`node/${other}`,requestId:"cross-world"}));
  f.send(f.request());assert.equal(f.count(),1);
  const chain=f.db.prepare(`SELECT a.human_id,x.act_id FROM grant_provenance p JOIN human_semantic_acts a ON a.act_id=p.human_act_id
    JOIN human_act_applications x USING(act_id) WHERE grant_id=?`).get(grant.grantId)!;
  assert.equal(chain.human_id,f.human);assert.ok(chain.act_id);
});
test("M2-T08 paused worker cannot send after admitted Human revocation",async t=>{
  const f=fixture(t),grant=f.grant(),request=f.request(),permit=prepareEffect(f.db,request);
  let resume!:()=>void;const pause=new Promise<void>(resolve=>{resume=resolve;});
  const worker=pause.then(()=>f.send(request,permit));
  revokeGrant(f.db,{kind:"human",id:f.human},{requestId:"revoke",grantId:grant.grantId});resume();
  await assert.rejects(worker,{code:"denied"});assert.equal(f.count(),0);assert.equal(effectKnowledge(f.db,request.attemptId),"prepared");
});
test("M2-T09 TTL-valid permit is invalid after Authority or policy epoch advance",t=>{
  const f=fixture(t);f.grant();const request=f.request(),permit=prepareEffect(f.db,request);
  const before=f.db.prepare("SELECT authority_epoch,expires_at FROM effect_permits WHERE permit_id=?").get(permit)!;
  setAuthorityConstraint(f.db,{kind:"human",id:f.human},{constraintId:"constraint",subjectNodeId:f.actor,resourceScope:`node/${f.target}`,reason:"Human revoked scope",active:true});
  assert.ok(Number(before.expires_at)>Date.now());assert.ok(Number(f.db.prepare("SELECT epoch FROM authority_epochs WHERE world_id=?").get(f.world)!.epoch)>Number(before.authority_epoch));
  assert.throws(()=>f.send(request,permit),{code:"denied"});assert.equal(f.count(),0);
  assert.throws(()=>setAuthorityConstraint(f.db,{kind:"human",id:f.human},{constraintId:"constraint",subjectNodeId:f.target,resourceScope:`node/${f.target}`,reason:"wrong subject",active:false}),{code:"denied"});
  const g=fixture(t);g.grant();const next=g.request(),token=prepareEffect(g.db,next);
  const input={worldId:g.world,product:"mock",capability:"business.write",requiresHuman:false};
  setEffectPolicy(g.db,humanProof(g.db,g.world,g.human,{type:"authority.effect_policy",objectRef:"mock",scope:"business.write",targetRevision:null,args:input,causalRefs:["fixture:policy revision"]}),input);
  assert.throws(()=>g.send(next,token),{code:"denied"});assert.equal(g.count(),0);
});
test("M2-T10 changed Presence cannot reuse an exact old permit",t=>{
  const f=fixture(t);f.grant();const request=f.request(),permit=prepareEffect(f.db,request);
  f.db.prepare("UPDATE sessions SET locator_ref='replacement' WHERE session_id=?").run(f.targetSession);
  assert.throws(()=>f.send(request,permit),{code:"denied"});assert.equal(f.count(),0);
});
test("M2-T11 current Human-gate policy cannot be bypassed by missing flags or guessed evidence",t=>{
  const f=fixture(t);f.grant();const input={worldId:f.world,product:"mock",capability:"business.write",requiresHuman:true};
  const proof=humanProof(f.db,f.world,f.human,{type:"authority.effect_policy",objectRef:"mock",scope:"business.write",targetRevision:null,args:input,causalRefs:["fixture:policy"]});
  setEffectPolicy(f.db,proof,input);
  assert.throws(()=>prepareEffect(f.db,{...f.request(),requiresHuman:false}),{code:"denied"});
  assert.throws(()=>prepareEffect(f.db,{...f.request(),humanGateActId:proof.actId}),{code:"denied"});assert.equal(f.count(),0);
  const request=f.request(),args={actionId:request.actionId,capability:request.capability,resource:request.resource,product:"mock",payloadDigest:createHash("sha256").update(canonical(request.payload)).digest("hex")};
  request.humanGateActId=humanProof(f.db,f.world,f.human,{type:"effect.authorize",objectRef:request.actionId,scope:request.resource,targetRevision:null,args,causalRefs:["fixture:exact effect consent"]}).actId;
  f.send(request);assert.equal(f.count(),1);
});
test("M2-T12 later generation fences paused old worker at actual send",t=>{
  const f=fixture(t);f.grant();const old=f.request(),p1=prepareEffect(f.db,old),fresh=f.request(old.actionId),p2=prepareEffect(f.db,fresh);
  assert.throws(()=>f.send(old,p1),{code:"denied"});f.send(fresh,p2);assert.equal(f.count(),1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM effect_attempt_state WHERE action_id=? AND eligible=1").get(old.actionId)!.n,1);
  assert.equal(f.db.prepare("SELECT generation FROM action_attempts WHERE attempt_id=?").get(fresh.attemptId)!.generation,2);
});
test("M2-T13 permit replay and altered identity fail after fencing or one-shot consumption",t=>{
  const f=fixture(t);f.grant();const request=f.request(),permit=prepareEffect(f.db,request);
  f.send(request,permit);assert.throws(()=>f.send(request,permit),{code:"denied"});
  const next=f.request(request.actionId);assert.throws(()=>prepareEffect(f.db,next),{code:"uncertain"});
  assert.throws(()=>f.send(next,permit),{code:"denied"});assert.equal(f.count(),1);
});
test("M2-T14 identical text under different LogicalAction identities is never silently merged",t=>{
  const f=fixture(t);f.grant();const a=f.request(),b=f.request();
  assert.deepEqual(a.payload,b.payload);assert.notEqual(a.actionId,b.actionId);f.send(a);f.send(b);
  assert.equal(f.count(),2);assert.equal(f.db.prepare("SELECT count(*) n FROM logical_actions").get()!.n,2);
});
test("M2-T15 crashes before allocation commit or before may-have transition prove no crossing",t=>{
  const f=fixture(t,true);f.grant();
  assert.throws(()=>withTransaction(f.db,"test_cut",()=>{f.request();throw new Error("crash before allocation commit");}));
  assert.equal(f.db.prepare("SELECT count(*) n FROM action_attempts").get()!.n,0);
  const allocated=f.request(),prepared=f.request();prepareEffect(f.db,prepared);
  f.reopen();assert.equal(effectKnowledge(f.db,allocated.attemptId),"confirmed_no_effect");assert.equal(effectKnowledge(f.db,prepared.attemptId),"confirmed_no_effect");
  assert.equal(f.count(),0);f.send(f.request(prepared.actionId));assert.equal(f.count(),1);
});
test("M2-T16 crash immediately before provider invocation retains durable may-have and forbids retry",t=>{
  const f=fixture(t,true);f.grant();const request=f.request(),permit=prepareEffect(f.db,request);
  assert.throws(()=>withTransaction(f.db,"enclosing_transaction",()=>f.send(request,permit)),/enclosing transaction/);assert.equal(f.count(),0);
  assert.throws(()=>effectBoundary(f.db,permit,request).cross({product:"mock",locator:`mock://${f.target}`,operation:"business.write"},()=>{throw new Error("cut before provider invocation");}));
  assert.equal(effectKnowledge(f.db,request.attemptId),"may_have_effect");f.reopen();
  assert.equal(effectKnowledge(f.db,request.attemptId),"uncertain");assert.throws(()=>prepareEffect(f.db,f.request(request.actionId)),{code:"uncertain"});assert.equal(f.count(),0);
});
test("M2-T17 provider accepts but ACK is lost; restart reconciles original attempt without resend",t=>{
  const f=fixture(t,true);f.grant();const request=f.request();f.send(request);
  f.reopen();assert.equal(effectKnowledge(f.db,request.attemptId),"uncertain");assert.equal(f.count(),1);
  assert.throws(()=>prepareEffect(f.db,f.request(request.actionId)),{code:"uncertain"});assert.equal(f.count(),1);
});
test("M2-T18 empty query, timeout, no ACK or login failure never proves no-effect",t=>{
  const f=fixture(t);f.grant();const request=f.request();f.send(request);observeEffect(f.db,request.attemptId,"uncertain","ACK lost");
  const reconcile=reconciliationProducer(f.db,mockProfile.id,()=>null);
  for(const evidence of [[],"timeout","no ACK","login failure",{pastEffectExcluded:true,futureEffectExcluded:true}])assert.throws(()=>reconcile(request.attemptId,evidence),{code:"uncertain"});
  assert.equal(effectKnowledge(f.db,request.attemptId),"uncertain");assert.equal(f.count(),1);
});
test("M2-T19 provider-specific verified receipt excludes both past and future old effects",t=>{
  const f=fixture(t);f.grant();const request=f.request(),permit=prepareEffect(f.db,request);
  // Admission is recorded but the mock cancels before any business effect.
  effectBoundary(f.db,permit,request).cross({product:"mock",locator:`mock://${f.target}`,operation:"business.write"},()=>undefined);
  observeEffect(f.db,request.attemptId,"uncertain","lost acknowledgement");
  const authenticatedReceipt=Object.freeze({attemptId:request.attemptId,terminal:"rejected-and-fenced"});
  const reconcile=reconciliationProducer(f.db,mockProfile.id,(attempt,evidence)=>evidence===authenticatedReceipt?{
    sourceRef:"mock-provider:verified-terminal-receipt",pastEffectExcluded:true,futureEffectExcluded:true,providerAttemptRef:String(attempt.attempt_id)}:null);
  assert.throws(()=>reconcile(request.attemptId,{...authenticatedReceipt}),{code:"uncertain"});
  assert.equal(reconcile(request.attemptId,authenticatedReceipt).retryEligible,true);
  assert.equal(effectKnowledge(f.db,request.attemptId),"confirmed_no_effect");
  f.send(f.request(request.actionId));assert.equal(f.count(),1);
});
test("M2-T20 scheduled Run and prepared Attempt do not establish authoritative running",t=>{
  const f=fixture(t);f.grant({capability:"task.dispatch"});
  const scheduler=new Continuations(f.db,new Map());
  const work=scheduler.submit({requestId:"scheduled",originNodeId:f.actor,originSessionId:f.session,centerNodeId:f.target,workerNodeIds:[],body:"queued"});
  assert.equal(work.state,"unknown");assert.equal(work.run.state,"unknown");assert.equal(work.run.schedulingState,"running");
  assert.equal(executionReality(f.db,work.run.run_id).authoritativeRunning,false);
  assert.equal(getTask(f.db,work.task.taskId).task.state,"unknown");
  assert.equal(f.db.prepare("SELECT state FROM task_runs WHERE run_id=?").get(work.run.run_id)!.state,"running");
});
test("M2-T21 fresh exact eligible executor supports executing; expired evidence and restart do not",async t=>{
  const f=fixture(t,true);f.grant({capability:"task.dispatch"});
  const mock:Hythe={hytheId:"mock",hostKind:"mock",capabilities:()=>[],locate:async()=>true,
    invoke:async()=>({status:"accepted",hostRef:"exact-turn"}),receive:async function*(){}};
  const scheduler=new Continuations(f.db,new Map([["mock",mock]]));
  const work=scheduler.submit({requestId:"fresh",originNodeId:f.actor,originSessionId:f.session,centerNodeId:f.target,workerNodeIds:[],body:"mock task"});
  await scheduler.pump();assert.equal(executionReality(f.db,work.run.run_id).authoritativeRunning,true);
  assert.equal(getTask(f.db,work.task.taskId).task.state,"running");
  const attempt=String(f.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=?").get(work.run.message_id)!.attempt_id);
  f.db.prepare("UPDATE execution_evidence SET fresh_until=0").run();assert.equal(executionReality(f.db,work.run.run_id).authoritativeRunning,false);
  recordExecutionProgress(f.db,work.run.run_id,attempt,"fixture:live-correlated-progress");assert.equal(executionReality(f.db,work.run.run_id).state,"executing");
  f.reopen();assert.equal(executionReality(f.db,work.run.run_id).state,"unknown");
});
test("M2-T22 autonomous noncancelable provider cannot promise hard post-admission revocation",t=>{
  const f=fixture(t);f.grant({effectScope:"post_admission_revocable"});
  const request={...f.request(),requestedControl:"post_admission_revocable" as const,profile:{...mockProfile,control:"ProviderAutonomousNonCancelable" as const}};
  assert.throws(()=>prepareEffect(f.db,request),/PROVIDER_CONTROL_LIMIT/);assert.equal(f.count(),0);
  assert.equal(f.db.prepare("SELECT executable FROM feasibility_assessments WHERE action_id=?").get(request.actionId)!.executable,"false");
  assert.equal(f.db.prepare("SELECT count(*) n FROM effect_permits").get()!.n,0);
});

test("M2 integration: real controlHost gate sits after adapter async preparation",async t=>{
  const f=fixture(t),grant=f.grant({capability:"host.business.write",resourceScope:`node/${f.target}/session/${f.targetSession}`});
  let ready!:()=>void,resume!:()=>void,count=0;const paused=new Promise<void>(r=>{ready=r;}),release=new Promise<void>(r=>{resume=r;});
  const h:Hythe={hytheId:"mock",hostKind:"mock",effectProfile:()=>mockProfile,capabilities:()=>[],controls:()=>["business.write"],locate:async()=>true,
    invoke:async()=>({status:"rejected",reason:"unused"}),receive:async function*(){},
    control:async(locator,operation,_input,boundary)=>{ready();await release;return boundary!.cross({product:"mock",locator,operation},()=>{count++;return {status:"accepted",hostRef:"mock-admission"};});}};
  const work=controlHost(f.db,new Map([["mock",h]]),{nodeId:f.actor,sessionId:f.session},{requestId:"race",targetSessionId:f.targetSession,operation:"business.write",input:{}});
  await paused;revokeGrant(f.db,{kind:"human",id:f.human},{requestId:"revoke",grantId:grant.grantId});resume();
  await assert.rejects(work);assert.equal(count,0);
  assert.equal(f.db.prepare("SELECT state FROM effect_attempt_state").get()!.state,"confirmed_no_effect");
});
test("M2 integration: final ExternalIdentity is required and account loss invalidates prepared permit",t=>{
  const f=fixture(t);f.grant();const request={...f.request(),profile:{...mockProfile,externalIdentityRequired:true}};
  assert.throws(()=>prepareEffect(f.db,request),/ExternalIdentity UNKNOWN/);
  const identityId=f.store.addExternalIdentity(f.human,"mock","human-owned-account","fixture authenticated Host");
  const input={worldId:f.world,sessionId:f.targetSession,identityId};
  const proof=humanProof(f.db,f.world,f.human,{type:"identity.bind_presence",objectRef:f.targetSession,scope:`identity/${identityId}`,targetRevision:null,args:input,causalRefs:["fixture:account binding"]});
  bindPresenceIdentity(f.db,proof,input);const permit=prepareEffect(f.db,request);
  f.store.setIdentityState(identityId,"unavailable");assert.throws(()=>f.send(request,permit),/ExternalIdentity unavailable/);assert.equal(f.count(),0);
});

test("M2 integration: one reserved budget cannot fund different Attempts or be reused after settlement",t=>{
  for(const status of ["reserved","consumed","released"] as const) {
    const f=fixture(t);const grant=f.grant({limit:1}),first=f.request();
    prepareEffect(f.db,first);
    const use=f.db.prepare("SELECT reservation_id FROM grant_uses WHERE grant_id=?").get(grant.grantId)!;
    if(status!=="reserved")settleReservation(f.db,String(use.reservation_id),status);
    const next={...f.request(),requestId:first.requestId};
    assert.throws(()=>prepareEffect(f.db,next),{code:"denied"});assert.equal(f.count(),0);
    assert.throws(()=>f.db.prepare("UPDATE grants SET use_limit=100 WHERE grant_id=?").run(grant.grantId),/new admitted Human act/);
  }
});

test("M2 integration: selecting a Node supplies no Host execution authority",t=>{
  const f=fixture(t);f.grant();const request={...f.request(),targetExecutes:true};
  assert.throws(()=>prepareEffect(f.db,request),{code:"denied"});assert.equal(f.count(),0);
  issueGrant(f.db,{kind:"human",id:f.human},{subjectNodeId:f.target,capability:"self.host.execute",resourceScope:`node/${f.target}/session/${f.targetSession}`,productScope:"mock"});
  f.send(request);assert.equal(f.count(),1);
  const permission=f.db.prepare("SELECT context_json FROM effect_permits WHERE attempt_id=?").get(request.attemptId)!;
  assert.equal(JSON.parse(String(permission.context_json)).provenance.executor.nodeId,f.target);
});

test("M2 integration: resource loss fences a paused permit permanently, even after health recovery",async t=>{
  const f=fixture(t);f.grant();const request=f.request(),permit=prepareEffect(f.db,request);
  const proof=await witnessedLossProof(f.db,f.targetSession);
  reconcileResourceLoss(f.db,{eventId:"fixture-loss",sessionId:f.targetSession,reason:"connection lost",source:"fixture:executor",proof});
  assert.equal(effectKnowledge(f.db,request.attemptId),"confirmed_no_effect");
  f.db.prepare("DELETE FROM session_health WHERE session_id=?").run(f.targetSession);
  recordFixtureHostAvailable(f.db,f.targetSession); // New exact Host evidence cannot revive the old fenced permit.
  assert.throws(()=>f.send(request,permit),{code:"denied"});assert.equal(f.count(),0);
  f.send(f.request(request.actionId));assert.equal(f.count(),1);
});

test("A new exact self resume restores observed health only after account and Authority checks; old permits stay fenced",async t=>{
  const f=fixture(t);f.grant({capability:"self.*",resourceScope:`node/${f.actor}/**`});
  const actionId=f.store.logicalAction(f.actor,f.actor,"conversation.send","fixture original send");
  const original:EffectRequest={actionId,attemptId:f.store.attempt(actionId,f.session),actorSessionId:f.session,capability:"self.host.conversation.send",
    resource:`node/${f.actor}/session/${f.session}`,requestId:"original send",payload:{},profile:mockProfile};
  const oldPermit=prepareEffect(f.db,original);
  const proof=await witnessedLossProof(f.db,f.session);
  reconcileResourceLoss(f.db,{eventId:"resume-loss",sessionId:f.session,reason:"native connection lost",source:"fixture",proof});
  assert.throws(()=>prepareEffect(f.db,{...f.request(),hostResourceRecovery:true}),/exact self Session resume/);
  let resumes=0,materialized=false;
  const profile={...mockProfile,externalIdentityRequired:true};
  const host:Hythe={hytheId:"mock",hostKind:"mock",capabilities:()=>[],controls:()=>["conversation.resume"],effectProfile:()=>profile,
    locate:async()=>materialized,receive:async function*(){},invoke:async()=>({status:"rejected",reason:"unused"}),
    control:async(locator,operation,_input,boundary)=>{
      assert.equal(locator,`mock://${f.actor}`);assert.equal(operation,"conversation.resume");
      return boundary!.cross({product:"mock",locator,operation},()=>{resumes++;materialized=true;return {status:"host_confirmed"};});
    }};
  const resume=(requestId:string)=>controlHost(f.db,new Map([["mock",host]]),{nodeId:f.actor,sessionId:f.session},
    {requestId,targetSessionId:f.session,operation:"conversation.resume",input:{}});
  await assert.rejects(resume("missing-account"),/ExternalIdentity UNKNOWN/);assert.equal(resumes,0);
  assert.equal(f.db.prepare("SELECT state FROM session_health WHERE session_id=?").get(f.session)!.state,"unavailable");
  const identity=f.store.addExternalIdentity(f.human,"mock","account","fixture account"),input={worldId:f.world,sessionId:f.session,identityId:identity};
  bindPresenceIdentity(f.db,humanProof(f.db,f.world,f.human,{type:"identity.bind_presence",objectRef:f.session,scope:`identity/${identity}`,targetRevision:null,args:input,causalRefs:["fixture"]}),input);
  const result=await resume("reviewed-resume");assert.equal(result.status,"host_confirmed");assert.equal(result.agentTurnCompleted,null);assert.equal(resumes,1);
  assert.equal(f.db.prepare("SELECT state FROM session_health WHERE session_id=?").get(f.session)!.state,"available");
  assert.equal(effectKnowledge(f.db,original.attemptId),"confirmed_no_effect");
  assert.throws(()=>effectBoundary(f.db,oldPermit,original).cross({product:"mock",locator:`mock://${f.actor}`,operation:"conversation.send"},()=>resumes++),{code:"denied"});
  assert.equal(resumes,1);assert.deepEqual(await resume("reviewed-resume"),result);assert.equal(resumes,1);
});

test("M2 integration: a legacy Session creation helper cannot perform effects outside a declared boundary",async t=>{
  const f=fixture(t);let creations=0;
  const host:Hythe={hytheId:"mock",hostKind:"mock",capabilities:()=>[],locate:async()=>true,receive:async function*(){},invoke:async()=>({status:"rejected",reason:"unused"})};
  await assert.rejects(createHostResource(f.db,host,{nodeId:f.actor,sessionId:f.session,requestId:"create"},async()=>{creations++;return "new";}),/verified final-send profile/);
  assert.equal(creations,0);assert.equal(f.db.prepare("SELECT count(*) n FROM effect_permits").get()!.n,0);
});

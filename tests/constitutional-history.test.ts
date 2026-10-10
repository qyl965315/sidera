import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { appendHistory, currentOmega, definiteValue, projectHistory, readHistory, resolveHistoryConflict, conflictResolutionObject, conflictResolutionMarker, type StateDelta } from "../core/history.ts";
import { BASIC_RULES_VERSION } from "../core/constitution.ts";
import { applyConsequence, consequenceReviewMarker, consequenceReviewObject, deriveResponsibility } from "../core/consequences.ts";
import { adoptRules, bindRuleReview, proposeRules } from "../core/rules.ts";
import { canUseCapability, reserveCapability } from "../core/authority.ts";
import { constitutionalRpc } from "../core/constitutional-rpc.ts";
import { grantSelf, issueGrant } from "./fixtures/authority.ts";
import { humanProof } from "./fixtures/human.ts";
import { canonical, openHumanIngress } from "../core/human-admission.ts";
import { recordWorld } from "../core/worlds.ts";
import { IdentityStore } from "../core/identity.ts";
import { registerNodeOntology } from "../core/ontology.ts";

const at="2026-10-07T00:00:00.000Z";
function fixture() {
  const db=openDatabase(":memory:");
  for(const id of ["author","subject","reviewer"]){
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id,id,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)").run(`session-${id}`,id,`exact-${id}`,at);
    grantSelf(db,id);
  }
  return {db,world:recordWorld(db,"nodes","author")};
}
function delta(target:string,baseRevision:string|null,value:unknown):StateDelta {
  return {target,baseRevision,nextValue:value,source:"recognized-fixture-interface",causalParents:[],rulesVersions:{Basic:BASIC_RULES_VERSION},effectiveAt:at,recordedAt:at};
}

test("CH-7/8/9/10/11 Claim contradicts Omega without changing it; History is ordered immutable and public",()=>{
  const f=fixture();try{
    const observed=appendHistory(f.db,{id:"fact-interface",kind:"Effect",source:"fixture:actual-result",worldRef:f.world,nodeRef:"subject",payload:{interface:"fixture"},deltaOmega:[delta("fixture/color",null,"blue")]});
    const claim=constitutionalRpc(f.db,{kind:"node",nodeId:"author",sessionId:"session-author"},"claim.publish",{requestId:"lie",claim:"The color is red.",parentRecords:[observed.id]}) as {id:string};
    assert.equal(definiteValue(currentOmega(f.db).find(e=>e.target==="fixture/color")),"blue");
    const publicClaim=readHistory(f.db).find(r=>r.id===claim.id)!;
    assert.equal(publicClaim.kind,"Claim");assert.equal(publicClaim.deltaOmega,undefined);
    assert.deepEqual(publicClaim.payload,{claim:"The color is red.",contextRef:null,intentRef:null});
    const history=readHistory(f.db);assert.ok(history.every((r,i)=>i===0||history[i-1]!.sequence<r.sequence));
    assert.throws(()=>appendHistory(f.db,{kind:"Claim",source:"node:author",payload:{claim:"false fact"},deltaOmega:[delta("fixture/color",observed.id,"red")]}),/cannot change Omega/);
    assert.throws(()=>f.db.prepare("UPDATE shared_history SET payload_json='{}' WHERE id=?").run(claim.id),/immutable/);
    assert.throws(()=>f.db.prepare("DELETE FROM shared_history WHERE id=?").run(claim.id),/retained/);
    assert.throws(()=>appendHistory(f.db,{kind:"Claim",source:"node:author",payload:{access_token:"private-value"}}),/Credential/);
    assert.throws(()=>f.db.prepare("UPDATE nodes SET display_name=? WHERE node_id='author'").run("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),/Credential/);
  }finally{f.db.close();}
});

test("CH-12/13/14 Omega is deterministic reconstruction from History; deleting a cache has no effect",()=>{
  const f=fixture();try{
    const one=appendHistory(f.db,{kind:"Effect",source:"fixture:interface",nodeRef:"subject",payload:{},deltaOmega:[delta("fixture/quota",null,5)]});
    appendHistory(f.db,{kind:"HumanDecision",source:"fixture:admitted-human",worldRef:f.world,payload:{decisionRef:"admitted-fixture"},deltaOmega:[delta("fixture/quota",one.id,7)]});
    const before=currentOmega(f.db);f.db.exec("CREATE TABLE disposable_omega_cache(value_json TEXT); INSERT INTO disposable_omega_cache VALUES ('stale'); DROP TABLE disposable_omega_cache");
    assert.deepEqual(currentOmega(f.db),before);
    assert.deepEqual([...projectHistory(readHistory(f.db)).values()],before);
    assert.ok(currentOmega(f.db,f.world).some(e=>e.target==="fixture/quota"));
    assert.throws(()=>projectHistory(readHistory(f.db).reverse()),/monotonic canonical order/);
  }finally{f.db.close();}
});

test("CH-15/16/17/18 same-base equivalence aliases compose; incompatible branches remain local until exact resolution",()=>{
  const db=openDatabase(":memory:");try{
    const effect=(id:string,d:StateDelta)=>appendHistory(db,{id,kind:"Effect",source:"fixture:interface",payload:{},deltaOmega:[d]});
    effect("A",delta("X",null,10));effect("B",delta("X",null,10));
    assert.equal(currentOmega(db).find(e=>e.target==="X")!.state,"CURRENT");
    effect("C",delta("X","B",11)); // B is a compatible alias of A, not a competing state.
    assert.equal(definiteValue(currentOmega(db).find(e=>e.target==="X")),11);
    effect("D",delta("X","A",12));effect("Y",delta("Y",null,"still usable"));
    const conflict=currentOmega(db).find(e=>e.target==="X")!;
    assert.equal(conflict.state,"UNRESOLVED");assert.equal(conflict.value,undefined);
    assert.deepEqual(conflict.candidates.map(c=>c.recordId),["C","D"]);
    assert.throws(()=>definiteValue(conflict),/UNRESOLVED/);
    assert.equal(definiteValue(currentOmega(db).find(e=>e.target==="Y")),"still usable");
    assert.throws(()=>effect("bad-resolution",{...delta("X",conflict.revision,11),resolves:["C"]}),/every current conflicting/);
    effect("resolved",{...delta("X",conflict.revision,11),resolves:["C","D"]});
    assert.equal(definiteValue(currentOmega(db).find(e=>e.target==="X")),11);
    assert.ok(readHistory(db).some(r=>r.id==="C"));assert.ok(readHistory(db).some(r=>r.id==="D"));
    effect("removed",{target:"X",baseRevision:"resolved",remove:true,source:"fixture",causalParents:[],rulesVersions:{Basic:BASIC_RULES_VERSION},effectiveAt:at,recordedAt:at});
    assert.equal(currentOmega(db).find(e=>e.target==="X")!.state,"REMOVED");
  }finally{db.close();}
});

test("CH-35/36/37 responsibility query preserves parent acts and rule versions across a real Node fork",()=>{
  const f=fixture();try{
    const claim=appendHistory(f.db,{kind:"Claim",source:"node:subject",nodeRef:"subject",projectRef:"project",rulesVersions:{Project:"historical-project-v1"},payload:{claim:"an incorrect plan"}});
    const before=deriveResponsibility(f.db,{worldRef:f.world,nodeRef:"subject"});
    assert.ok(before.records.some(r=>r.recordId===claim.id));
    issueGrant(f.db,{kind:"human",id:"fixture-owner"},{subjectNodeId:"subject",capability:"node.fork",resourceScope:"node/subject/fork"});
    const head=String(f.db.prepare("SELECT active_self_head FROM node_identity WHERE node_id='subject'").get()!.active_self_head);
    const child=new IdentityStore(f.db).forkNode({nodeId:"subject",sessionId:"session-subject"},"fork","Child",head);
    const after=deriveResponsibility(f.db,{worldRef:f.world,nodeRef:"subject"});
    assert.ok(after.records.some(r=>r.recordId===claim.id&&r.rulesVersions.Project==="historical-project-v1"));
    const fork=readHistory(f.db).find(r=>r.kind==="Fork")!;
    assert.equal((fork.payload as {parentNodeRef:string}).parentNodeRef,"subject");
    assert.equal((fork.payload as {childNodeRef:string}).childNodeRef,child.nodeId);
    const childTrace=deriveResponsibility(f.db,{worldRef:f.world,nodeRef:child.nodeId});
    assert.ok(childTrace.records.some(r=>r.recordId===fork.id));
    assert.equal(childTrace.records.some(r=>r.recordId===claim.id),false,"Fork lineage does not universally copy parent consequences");
    assert.equal(f.db.prepare("SELECT count(*) n FROM grants WHERE subject_node_id=?").get(child.nodeId)!.n,0);
  }finally{f.db.close();}
});

function reviewTask(f:ReturnType<typeof fixture>,body:string,objectHash:string) {
  const taskId=randomUUID(),runId=randomUUID(),messageId=randomUUID();
  f.db.prepare("INSERT INTO tasks VALUES (?,?,'author','reviewer','[]','running',NULL,?)").run(taskId,taskId,at);
  const seq=Number(f.db.prepare("SELECT coalesce(max(sequence),0)+1 n FROM messages WHERE target_session_id='session-reviewer'").get()!.n);
  f.db.prepare("INSERT INTO messages VALUES (?,?,?,'author','reviewer','session-reviewer',?,'task',?,'observed','fixture-turn',NULL,?)").run(messageId,`request:${taskId}`,taskId,seq,body,at);
  f.db.prepare("INSERT INTO task_runs VALUES (?,?,'session-reviewer',?,'running',1,'',?)").run(runId,taskId,messageId,at);
  const complete=()=>{
    const resultSeq=Number(f.db.prepare("SELECT coalesce(max(sequence),0)+1 n FROM messages WHERE target_session_id='session-author'").get()!.n);
    f.db.prepare("INSERT INTO messages VALUES (?,?,?,'reviewer','author','session-author',?,'result',?,'queued',NULL,NULL,?)").run(randomUUID(),`result:${runId}`,taskId,resultSeq,canonical({objectHash,decision:"approve"}),at);
    f.db.prepare("UPDATE task_runs SET state='completed',turn_open=0 WHERE run_id=?").run(runId);
    f.db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(taskId);
  };return {taskId,runId,complete};
}
function adoptHuman(f:ReturnType<typeof fixture>,proposalId:string,level:string,scope:string,reviewTaskId?:string){
  const input={proposalId,...(reviewTaskId?{reviewTaskId}:{})};
  const proof=humanProof(f.db,f.world,"owner",{type:"rules.adopt",objectRef:proposalId,scope:`rules/${level}/${scope}`,targetRevision:null,args:input,causalRefs:[proposalId]});
  return adoptRules(f.db,{kind:"human",...proof},input);
}

test("CH-38/39 a named adopted Project consequence needs its exact completed review and changes real Authority",()=>{
  const f=fixture();try{
    const worldProposal=proposeRules(f.db,"author",{requestId:"world",worldId:f.world,level:"World",scopeRef:f.world,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{}});
    const world=adoptHuman(f,worldProposal.proposalId,"World",f.world);
    const projectProposal=proposeRules(f.db,"author",{requestId:"project",worldId:f.world,level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:world.versionId,boundary:{},
      policy:{consequences:{restrictedFiles:{mode:"deny",resourceScope:"node/subject/work/**",operations:["file.write"]}}}});
    const approval=reviewTask(f,`SIDERA_MACHINE_REVIEW_V1\n${canonical({proposalId:projectProposal.proposalId,objectHash:projectProposal.objectHash})}`,projectProposal.objectHash);
    bindRuleReview(f.db,"author",{proposalId:projectProposal.proposalId,reviewTaskId:approval.taskId});approval.complete();
    const project=adoptHuman(f,projectProposal.proposalId,"Project","project",approval.taskId);
    issueGrant(f.db,{kind:"human",id:"owner"},{subjectNodeId:"subject",capability:"file.write",resourceScope:"node/subject/**"});
    const action={subjectNodeId:"subject",sessionId:"session-subject",capability:"file.write",resource:"node/subject/work/file",requestId:"file",projectRef:"project"};
    assert.equal(canUseCapability(f.db,action),true);
    const origin=appendHistory(f.db,{kind:"Claim",source:"node:subject",nodeRef:"subject",worldRef:f.world,projectRef:"project",payload:{claim:"incorrect work claim"},rulesVersions:{Project:project.versionId}});
    const object={requestId:"consequence",projectRef:"project",ruleVersionId:project.versionId,ruleName:"restrictedFiles",subjectNodeRef:"subject",sourceRecords:[origin.id]};
    assert.throws(()=>applyConsequence(f.db,"author",{...object,reviewTaskId:approval.taskId}),/exact object/);
    const review=reviewTask(f,consequenceReviewMarker(object),consequenceReviewObject(object).objectHash);
    assert.throws(()=>applyConsequence(f.db,"author",{...object,reviewTaskId:review.taskId}),/completed Task/);
    review.complete();const applied=applyConsequence(f.db,"author",{...object,reviewTaskId:review.taskId});
    assert.equal(applied.kind,"Consequence");assert.deepEqual(applied.parentRecords,[origin.id]);
    assert.equal(canUseCapability(f.db,action),false);assert.throws(()=>reserveCapability(f.db,action),/Project consequence/);
    assert.equal(canUseCapability(f.db,{...action,projectRef:"another-project",requestId:"unrelated"}),true);
    assert.equal(applyConsequence(f.db,"author",{...object,reviewTaskId:review.taskId}).id,applied.id);
    assert.throws(()=>applyConsequence(f.db,"author",{...object,subjectNodeRef:"author",reviewTaskId:review.taskId}),/request reused/);
    const unrelated=reviewTask(f,"do something unrelated",consequenceReviewObject({...object,requestId:"wrong-marker"}).objectHash);unrelated.complete();
    assert.throws(()=>applyConsequence(f.db,"author",{...object,requestId:"wrong-marker",reviewTaskId:unrelated.taskId}),/exact structured application marker/);
  }finally{f.db.close();}
});

test("Typed Human conversation history preserves references without copying message content or making Console a Node",()=>{
  const f=fixture();try{
    registerNodeOntology(f.db,"author",{kind:"Communicator"});
    f.db.prepare("INSERT INTO communicator_conversations VALUES ('exact-conversation','author','fixture')").run();
    const owner=humanProof(f.db,f.world,"owner",{type:"fixture",objectRef:"fixture",scope:"fixture",targetRevision:null,args:{},causalRefs:[]});
    assert.ok(owner);
    const inbound=openHumanIngress(f.db,{worldId:f.world,humanId:"owner",presenceRef:"fixture:authenticated",sourceRef:"exact-conversation"});
    const utterance=inbound.capture("exact-message","PRIVATE_HUMAN_BODY");
    const record=readHistory(f.db).find(r=>r.id===`human-utterance:${utterance}`)!;
    assert.equal(record.kind,"Communication");assert.equal(record.conversationRef,"exact-conversation");
    assert.equal(record.communicatorRef,"author");assert.equal((record.payload as {form:string}).form,"Conversation");
    assert.doesNotMatch(JSON.stringify(record),/PRIVATE_HUMAN_BODY/);
  }finally{f.db.close();}
});

test("A conflict resolution is an exact completed canonical Task; stale, partial, unrelated and invented choices are rejected",()=>{
  const f=fixture();try{
    for(const [id,value] of [["candidate-a","A"],["candidate-b","B"]] as const)
      appendHistory(f.db,{id,kind:"Effect",source:"fixture:actual-interface",worldRef:f.world,payload:{},deltaOmega:[delta("fixture/conflict",null,value)]});
    const entry=currentOmega(f.db,f.world).find(e=>e.target==="fixture/conflict")!;
    const input={requestId:"resolution",target:entry.target,expectedRevision:entry.revision,candidateRecordIds:entry.candidates.map(c=>c.recordId),selectedRecordId:"candidate-a"};
    const review=reviewTask(f,conflictResolutionMarker(input),conflictResolutionObject(input).objectHash);
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,reviewTaskId:review.taskId}),/completed Task/);
    review.complete();
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,candidateRecordIds:["candidate-a"],reviewTaskId:review.taskId}),/distinct candidate records/);
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,expectedRevision:"obsolete",reviewTaskId:review.taskId}),/exact current UNRESOLVED/);
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,selectedRecordId:"invented-value",reviewTaskId:review.taskId}),/select one/);
    const wrong=reviewTask(f,"unrelated task",conflictResolutionObject(input).objectHash);wrong.complete();
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,reviewTaskId:wrong.taskId}),/exact structured conflict marker/);
    const actor={kind:"node" as const,nodeId:"author",sessionId:"session-author"},args={...input,reviewTaskId:review.taskId};
    assert.throws(()=>constitutionalRpc(f.db,actor,"conflict.resolve",args),/Grant|grant|denied|authority/i);
    issueGrant(f.db,{kind:"human",id:"owner"},{subjectNodeId:"author",capability:"state.conflict.resolve",resourceScope:`state/${entry.target}`,limit:1});
    const prepared=constitutionalRpc(f.db,actor,"conflict.review_object",input) as {taskCommand:string};
    assert.equal(prepared.taskCommand,conflictResolutionMarker(input));
    const resolved=constitutionalRpc(f.db,actor,"conflict.resolve",args) as ReturnType<typeof resolveHistoryConflict>;
    assert.equal(definiteValue(currentOmega(f.db,f.world).find(e=>e.target===entry.target)),"A");
    assert.equal(resolved.taskRef,review.taskId);assert.deepEqual(resolved.deltaOmega![0]!.resolves,["candidate-a","candidate-b"]);
    assert.ok(resolved.parentRecords.some(id=>id.startsWith("message:")));
    assert.equal((constitutionalRpc(f.db,actor,"conflict.resolve",args) as {id:string}).id,resolved.id);
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,selectedRecordId:"candidate-b",reviewTaskId:review.taskId}),/request reused/);
    assert.equal(readHistory(f.db).filter(r=>["candidate-a","candidate-b"].includes(r.id)).length,2);
  }finally{f.db.close();}
});

test("Operational deletion records a durable tombstone; generic resolution cannot override a real operational index",()=>{
  const f=fixture();try{
    f.db.prepare("DELETE FROM node_ontology WHERE node_ref='subject'").run();
    const target="node_ontology/subject",removed=currentOmega(f.db,f.world).find(e=>e.target===target)!;
    assert.equal(removed.state,"REMOVED");
    const tombstone=readHistory(f.db).find(r=>r.id===removed.revision)!;
    assert.equal(tombstone.deltaOmega![0]!.remove,true);assert.equal((tombstone.payload as {operation:string}).operation,"DELETE");
    const original=readHistory(f.db).find(r=>r.deltaOmega?.some(d=>d.target===target&&!d.remove))!;
    appendHistory(f.db,{id:"stale-index-claim",kind:"Effect",source:"fixture:concurrent-history",worldRef:f.world,payload:{},deltaOmega:[delta(target,original.id,original.deltaOmega![0]!.nextValue)]});
    const entry=currentOmega(f.db,f.world).find(e=>e.target===target)!;
    const input={requestId:"index-resolve",target,expectedRevision:entry.revision,candidateRecordIds:entry.candidates.map(c=>c.recordId),selectedRecordId:"stale-index-claim"};
    const review=reviewTask(f,conflictResolutionMarker(input),conflictResolutionObject(input).objectHash);review.complete();
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...input,reviewTaskId:review.taskId}),/owning adapter.*reconciliation/);
    assert.equal(f.db.prepare("SELECT 1 FROM node_ontology WHERE node_ref='subject'").get(),undefined);
    assert.equal(currentOmega(f.db,f.world).find(e=>e.target===target)!.state,"UNRESOLVED");
  }finally{f.db.close();}
});

test("Machine conflict resolution cannot adopt new World policy or restore an obsolete Human-adopted version",()=>{
  const f=fixture();try{
    const first=proposeRules(f.db,"author",{requestId:"world-v1",worldId:f.world,level:"World",scopeRef:f.world,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{revision:1}});
    const one=adoptHuman(f,first.proposalId,"World",f.world);
    const original=readHistory(f.db).find(r=>r.kind==="RuleChange"&&(r.payload as {versionId:string}).versionId===one.versionId)!;
    const next=proposeRules(f.db,"author",{requestId:"world-v2",worldId:f.world,level:"World",scopeRef:f.world,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{revision:2}});
    const two=adoptHuman(f,next.proposalId,"World",f.world);
    const current=readHistory(f.db).find(r=>r.kind==="RuleChange"&&(r.payload as {versionId:string}).versionId===two.versionId)!;
    const target=`rules/${f.world}/World/${f.world}`;
    appendHistory(f.db,{id:"concurrent-old",kind:"RuleChange",source:"fixture:concurrent-history",worldRef:f.world,payload:{},
      deltaOmega:[delta(target,original.id,original.deltaOmega![0]!.nextValue)]});
    const conflict=currentOmega(f.db,f.world).find(e=>e.target===target)!;
    const oldInput={requestId:"reject-old",target,expectedRevision:conflict.revision,candidateRecordIds:conflict.candidates.map(c=>c.recordId),selectedRecordId:"concurrent-old"};
    const oldReview=reviewTask(f,conflictResolutionMarker(oldInput),conflictResolutionObject(oldInput).objectHash);oldReview.complete();
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...oldInput,reviewTaskId:oldReview.taskId}),/latest exact already-adopted/);
    const input={...oldInput,requestId:"select-adopted",selectedRecordId:current.id};
    const review=reviewTask(f,conflictResolutionMarker(input),conflictResolutionObject(input).objectHash);review.complete();
    resolveHistoryConflict(f.db,"author",{...input,reviewTaskId:review.taskId});
    assert.equal((definiteValue(currentOmega(f.db,f.world).find(e=>e.target===target)) as {versionId:string}).versionId,two.versionId);
    const resolved=currentOmega(f.db,f.world).find(e=>e.target===target)!;
    const newPolicy={...(current.deltaOmega![0]!.nextValue as object),policy:{revision:999}};
    appendHistory(f.db,{id:"invented-policy",kind:"RuleChange",source:"fixture:conflict",worldRef:f.world,payload:{},deltaOmega:[delta(target,original.id,newPolicy)]});
    const again=currentOmega(f.db,f.world).find(e=>e.target===target)!;
    assert.equal(again.state,"UNRESOLVED");assert.ok(again.candidates.some(c=>c.recordId===resolved.revision));
    const invented={requestId:"reject-policy",target,expectedRevision:again.revision,candidateRecordIds:again.candidates.map(c=>c.recordId),selectedRecordId:"invented-policy"};
    const bad=reviewTask(f,conflictResolutionMarker(invented),conflictResolutionObject(invented).objectHash);bad.complete();
    assert.throws(()=>resolveHistoryConflict(f.db,"author",{...invented,reviewTaskId:bad.taskId}),/latest exact already-adopted/);
  }finally{f.db.close();}
});

test("Conflict recovery checks the parent policy that adopted a Rule, rather than its child review policy",()=>{
 const f=fixture();try{
  const reviewPolicy={reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:true,allowSelfReview:false,reviewerCount:1};
  const wp=proposeRules(f.db,"author",{requestId:"policy-world",worldId:f.world,level:"World",scopeRef:f.world,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{reviewPolicy}});
  const world=adoptHuman(f,wp.proposalId,"World",f.world);
  const adoptProject=(requestId:string)=>{
   const p=proposeRules(f.db,"author",{requestId,worldId:f.world,level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:world.versionId,boundary:{},
    policy:{reviewPolicy:{reviewers:"Human",reviewerSelection:"Human",humanInvolvement:"required",independentRequired:false,allowSelfReview:true,reviewerCount:0}}});
   const approval=reviewTask(f,"SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:p.proposalId,objectHash:p.objectHash}),p.objectHash);
   bindRuleReview(f.db,"author",{proposalId:p.proposalId,reviewTaskId:approval.taskId});approval.complete();
   const adopted=adoptRules(f.db,{kind:"node",nodeId:"author"},{proposalId:p.proposalId,reviewTaskId:approval.taskId});
   assert.equal(adopted.humanActId,null);
   return readHistory(f.db).find(r=>r.kind==="RuleChange"&&(r.payload as {versionId:string}).versionId===adopted.versionId)!;
  };
  const first=adoptProject("policy-project-one"),current=adoptProject("policy-project-two"),target="rules/"+f.world+"/Project/project";
  appendHistory(f.db,{id:"old-project-candidate",kind:"RuleChange",source:"fixture:concurrent-history",worldRef:f.world,payload:{},deltaOmega:[delta(target,first.id,first.deltaOmega![0]!.nextValue)]});
  const conflict=currentOmega(f.db,f.world).find(e=>e.target===target)!;
  const input={requestId:"recover-project",target,expectedRevision:conflict.revision,candidateRecordIds:conflict.candidates.map(c=>c.recordId),selectedRecordId:current.id};
  const review=reviewTask(f,conflictResolutionMarker(input),conflictResolutionObject(input).objectHash);review.complete();
  resolveHistoryConflict(f.db,"author",{...input,reviewTaskId:review.taskId});
  assert.equal(currentOmega(f.db,f.world).find(e=>e.target===target)!.state,"CURRENT");
 }finally{f.db.close();}
});

test("CR-World conflict recovery retains the exact procedure that adopted a Machine World version",()=>{
 const f=fixture();try{
  const worldReviewPolicy={reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:true,allowSelfReview:false,reviewerCount:1};
  const first=proposeRules(f.db,"author",{requestId:"root-policy-one",worldId:f.world,level:"World",scopeRef:f.world,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{worldReviewPolicy}});
  const one=adoptHuman(f,first.proposalId,"World",f.world);
  const prior=readHistory(f.db).find(r=>r.kind==="RuleChange"&&(r.payload as {versionId:string}).versionId===one.versionId)!;
  const second=proposeRules(f.db,"author",{requestId:"root-policy-two",worldId:f.world,level:"World",scopeRef:f.world,parentVersionId:BASIC_RULES_VERSION,boundary:{},
   policy:{worldReviewPolicy:{reviewers:"Human",reviewerSelection:"Human",humanInvolvement:"required",independentRequired:false,allowSelfReview:true,reviewerCount:0}}});
  const approval=reviewTask(f,"SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:second.proposalId,objectHash:second.objectHash}),second.objectHash);
  bindRuleReview(f.db,"author",{proposalId:second.proposalId,reviewTaskId:approval.taskId});approval.complete();
  const two=adoptRules(f.db,{kind:"node",nodeId:"author"},{proposalId:second.proposalId,reviewTaskId:approval.taskId});
  assert.equal(two.humanActId,null);assert.equal(two.governanceVersionId,one.versionId);
  const current=readHistory(f.db).find(r=>r.kind==="RuleChange"&&(r.payload as {versionId:string}).versionId===two.versionId)!;
  const target="rules/"+f.world+"/World/"+f.world;
  appendHistory(f.db,{id:"stale-world-candidate",kind:"RuleChange",source:"fixture:concurrent-history",worldRef:f.world,payload:{},deltaOmega:[delta(target,prior.id,prior.deltaOmega![0]!.nextValue)]});
  const conflict=currentOmega(f.db,f.world).find(e=>e.target===target)!;
  const input={requestId:"recover-machine-world",target,expectedRevision:conflict.revision,candidateRecordIds:conflict.candidates.map(c=>c.recordId),selectedRecordId:current.id};
  const review=reviewTask(f,conflictResolutionMarker(input),conflictResolutionObject(input).objectHash);review.complete();
  resolveHistoryConflict(f.db,"author",{...input,reviewTaskId:review.taskId});
  assert.equal(currentOmega(f.db,f.world).find(e=>e.target===target)!.state,"CURRENT");
 }finally{f.db.close();}
});

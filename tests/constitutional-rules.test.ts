import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../core/db.ts";
import { BASIC_RULES_VERSION, R1_BOOTSTRAP_GOVERNANCE, normalizeReviewPolicy } from "../core/constitution.ts";
import { canonical } from "../core/human-admission.ts";
import { adoptRules, proposeRules, bindRuleReview, currentRules, assertRuleBoundary, reviewPolicyFor, getRuleProposal, migrateRules, type RuleProposalInput } from "../core/rules.ts";
import { issueRuleGrant, canUseCapability, reserveCapability, settleReservation } from "../core/authority.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { compatibilityWorld } from "../core/worlds.ts";
import { humanProof } from "./fixtures/human.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSetup } from "../core/local-setup.ts";
import { SemanticStore } from "../core/semantics.ts";
import { registerNodeOntology } from "../core/ontology.ts";
import { constitutionalRpc } from "../core/constitutional-rpc.ts";
import { DesktopManagement } from "../core/desktop-management.ts";

function fixture(){const db=openDatabase(":memory:"),at=new Date().toISOString();
  for(const id of ["issuer","reviewer","operator","operator2"]){db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id,id,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run(`s-${id}`,id,`loc-${id}`,at);}
  db.prepare("INSERT INTO chief_conversations VALUES ('binding','space','project','reviewer','chatgpt','exact-chat','active',?)").run(at);
  registerNodeOntology(db,"reviewer",{kind:"Communicator"});
  return {db,worldId:compatibilityWorld(db)};}
function adoptHuman(f:ReturnType<typeof fixture>,proposalId:string,level:string,scope:string,reviewTaskId?:string){
  const input={proposalId,...(reviewTaskId?{reviewTaskId}:{})};
  const proof=humanProof(f.db,f.worldId,"owner",{type:"rules.adopt",objectRef:proposalId,scope:`rules/${level}/${scope}`,targetRevision:null,args:input,causalRefs:[proposalId]});
  return adoptRules(f.db,{kind:"human",...proof},input);
}
function task(f:ReturnType<typeof fixture>,body:string,reviewer="operator"){
  const id=randomUUID(),message=randomUUID(),run=randomUUID(),at=new Date().toISOString();
  f.db.prepare("INSERT INTO tasks VALUES (?,?,'issuer',?,'[]','running',NULL,?)").run(id,id,reviewer,at);
  const seq=Number(f.db.prepare("SELECT coalesce(max(sequence),0)+1 n FROM messages WHERE target_session_id=?").get(`s-${reviewer}`)!.n);
  f.db.prepare("INSERT INTO messages VALUES (?,?,?,'issuer',?,?,?,'task',?,'observed','host-turn',NULL,?)").run(message,`task:${id}`,id,reviewer,`s-${reviewer}`,seq,body,at);
  f.db.prepare("INSERT INTO task_runs VALUES (?,?,?,?,'running',1,'',?)").run(run,id,`s-${reviewer}`,message,at);
  return {id,run,reviewer};
}
function complete(f:ReturnType<typeof fixture>,t:ReturnType<typeof task>,objectHash:string){
  const at=new Date().toISOString(),seq=Number(f.db.prepare("SELECT coalesce(max(sequence),0)+1 n FROM messages WHERE target_session_id='s-issuer'").get()!.n);
  f.db.prepare("INSERT INTO messages VALUES (?,?,?,?, 'issuer','s-issuer',?,'result',?,'queued',NULL,NULL,?)").run(randomUUID(),`result:${t.run}`,t.id,t.reviewer,seq,canonical({objectHash,decision:"approve"}),at);
  f.db.prepare("UPDATE task_runs SET state='completed',turn_open=0 WHERE run_id=?").run(t.run);
  f.db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(t.id);
}
function proposal(f:ReturnType<typeof fixture>,input:Omit<RuleProposalInput,"requestId"|"worldId">){return proposeRules(f.db,"issuer",{requestId:randomUUID(),worldId:f.worldId,...input});}
function world(f:ReturnType<typeof fixture>){const p=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.*"],resources:["node/**"],maxBudget:10},policy:{}});return adoptHuman(f,p.proposalId,"World",f.worldId);}
function project(f:ReturnType<typeof fixture>,worldId:string){
  const p=proposal(f,{level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:worldId,boundary:{operations:["file.write"],resources:["node/issuer/**"],maxBudget:5},policy:{}});
  const review=task(f,`SIDERA_MACHINE_REVIEW_V1\n${canonical({proposalId:p.proposalId,objectHash:p.objectHash})}`);
  bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:review.id});
  return {p,review};
}

test("CR-26/43 World adoption is Human-only; nested boundaries cannot widen",()=>{
  const f=fixture();try{
    const p=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.read"]},policy:{}});
    assert.throws(()=>adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId}),{code:"denied"});
    const w=adoptHuman(f,p.proposalId,"World",f.worldId);
    assert.equal(currentRules(f.db,"World",f.worldId)?.versionId,w.versionId);
    assert.throws(()=>proposal(f,{level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:w.versionId,boundary:{operations:["file.*"]},policy:{}}),{code:"denied"});
    for(const child of [{},{resources:["*"]},{resources:["node/issuer/**"],maxBudget:6}])assert.throws(()=>assertRuleBoundary({resources:["node/issuer/**"],maxBudget:5},child),{code:"denied"});
  }finally{f.db.close();}
});

test("CR-44 Project adoption requires actual completed Machine Review and exact Human approval",()=>{
  const f=fixture();try{
    const w=world(f),{p,review}=project(f,w.versionId);
    assert.throws(()=>adoptHuman(f,p.proposalId,"Project","project",review.id),{code:"denied"});
    complete(f,review,p.objectHash);
    assert.throws(()=>adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskId:review.id}),{code:"denied"});
    assert.throws(()=>adoptRules(f.db,{kind:"human",id:"owner"},{proposalId:p.proposalId,reviewTaskId:review.id}),{code:"denied"});
    const adopted=adoptHuman(f,p.proposalId,"Project","project",review.id);
    assert.equal(adopted.parentVersionId,w.versionId);assert.equal(adopted.boundary.maxBudget,5);
    assert.equal(f.db.prepare("SELECT review_result_message_id FROM rule_versions WHERE version_id=?").get(adopted.versionId)!.review_result_message_id!=null,true);
    assert.throws(()=>f.db.prepare("UPDATE rule_versions SET policy_json='{}' WHERE version_id=?").run(adopted.versionId),/immutable/);
  }finally{f.db.close();}
});

test("CR-45 Task Rules require issuer proposal and exact Chief Conversation Machine Review, not another Human act",()=>{
  const f=fixture();try{
    const w=world(f),pr=project(f,w.versionId);complete(f,pr.review,pr.p.objectHash);const adopted=adoptHuman(f,pr.p.proposalId,"Project","project",pr.review.id);
    const work=task(f,"underlying actual work");
    const input={requestId:randomUUID(),worldId:f.worldId,level:"Task" as const,scopeRef:work.id,taskRef:work.id,projectRef:"project",parentVersionId:adopted.versionId,
      boundary:{operations:["file.write"],resources:["node/issuer/files/**"],maxBudget:1},policy:{}};
    assert.throws(()=>proposeRules(f.db,"reviewer",input),{code:"denied"});
    const p=proposeRules(f.db,"issuer",input);
    const bad=task(f,`SIDERA_MACHINE_REVIEW_V1\n${canonical({proposalId:p.proposalId,objectHash:p.objectHash})}`);
    assert.throws(()=>bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:bad.id,reviewerConversationRef:"other-chat"}),{code:"denied"});
    const good=task(f,`SIDERA_MACHINE_REVIEW_V1\n${canonical({proposalId:p.proposalId,objectHash:p.objectHash,bindingId:"binding",conversationRef:"exact-chat"})}`,"reviewer");
    bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:good.id,reviewerConversationRef:"exact-chat"});complete(f,good,p.objectHash);
    const result=adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskId:good.id});
    assert.equal(result.humanActId,null);assert.equal(result.level,"Task");
  }finally{f.db.close();}
});

test("Rules standing authorization issues an exact rule-rooted Grant and version change invalidates it",()=>{
  const f=fixture();try{
    const grant={subjectNodeId:"issuer",capability:"file.read",resourceScope:"node/issuer/**",productScope:"*"};
    const input={level:"World" as const,scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.read"],resources:["node/**"]},policy:{authority:[grant]}};
    const p=proposal(f,input),w=adoptHuman(f,p.proposalId,"World",f.worldId);
    const g=issueRuleGrant(f.db,"issuer",{ruleVersionId:w.versionId,grantIndex:0,requestId:"standing"});assert.equal(g.issuer,`rule:${w.versionId}`);
    assert.equal(issueRuleGrant(f.db,"issuer",{ruleVersionId:w.versionId,grantIndex:0,requestId:"another-request"}).grantId,g.grantId);
    assert.equal(canUseCapability(f.db,{subjectNodeId:"issuer",sessionId:"s-issuer",capability:"file.read",resource:"node/issuer/a",requestId:"read"}),true);
    assert.throws(()=>issueRuleGrant(f.db,"reviewer",{ruleVersionId:w.versionId,grantIndex:0,requestId:"steal"}),{code:"denied"});
    const p2=proposal(f,{...input,policy:{}});adoptHuman(f,p2.proposalId,"World",f.worldId);
    assert.equal(canUseCapability(f.db,{subjectNodeId:"issuer",sessionId:"s-issuer",capability:"file.read",resource:"node/issuer/a",requestId:"read2"}),false);
  }finally{f.db.close();}
});

test("Rule operation budget is shared across independent Grants and records the version used",()=>{
  const f=fixture();try{
    const p=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{maxBudget:1},policy:{}});
    const w=adoptHuman(f,p.proposalId,"World",f.worldId);
    for(const node of ["issuer","reviewer"])issueGrant(f.db,{kind:"human",id:"owner"},{subjectNodeId:node,capability:"file.read",resourceScope:"node/issuer/**",limit:1});
    const action={subjectNodeId:"issuer",sessionId:"s-issuer",capability:"file.read",resource:"node/issuer/a",requestId:"first"};
    const reserved=reserveCapability(f.db,action);assert.equal(reserveCapability(f.db,action).reservationId,reserved.reservationId);
    assert.equal(canUseCapability(f.db,{...action,subjectNodeId:"reviewer",sessionId:"s-reviewer",requestId:"other"}),false);
    settleReservation(f.db,reserved.reservationId!,"consumed");
    const record=f.db.prepare("SELECT rules_json FROM shared_history WHERE id=?").get(`authority-reservation:${reserved.reservationId}`)!;
    assert.equal(JSON.parse(String(record.rules_json)).World,w.versionId);
  }finally{f.db.close();}
});

test("CR-46 review topology is Rule/bootstrap policy read from the adopted parent, never from the proposal",()=>{
  const f=fixture();try{
    assert.equal(normalizeReviewPolicy({reviewers:"Machine",reviewerSelection:"AuthorizedOperator",
      humanInvolvement:"none",independentRequired:true,allowSelfReview:false,reviewerCount:2}).reviewerCount,2);
    for(const bad of [
      {reviewers:"Human",reviewerSelection:"Human",humanInvolvement:"required",independentRequired:false,allowSelfReview:true,reviewerCount:1},
      {reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"required",independentRequired:false,allowSelfReview:true,reviewerCount:1},
      {reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:false,allowSelfReview:true,reviewerCount:0},
      {reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:false,allowSelfReview:true,reviewerCount:1,exactObjectHashRequired:false}])
      assert.throws(()=>normalizeReviewPolicy(bad),{code:/conflict|denied/});
    assert.equal(R1_BOOTSTRAP_GOVERNANCE.kind,"bootstrap-policy");
    // With no adopted parent Rule, the versioned bootstrap policy applies.
    assert.equal(reviewPolicyFor(f.db,"Project",BASIC_RULES_VERSION).source,R1_BOOTSTRAP_GOVERNANCE.version);
    // A World Rule's own reviewPolicy governs Project adoption, not its own adoption:
    // this World version is still adopted by the Human bootstrap procedure.
    const p=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.*"]},
      policy:{reviewPolicy:{reviewers:"Human+Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"required",
        independentRequired:true,allowSelfReview:false,reviewerCount:1}}});
    const w=adoptHuman(f,p.proposalId,"World",f.worldId);
    const effective=reviewPolicyFor(f.db,"Project",w.versionId);
    assert.equal(effective.policy.independentRequired,true);assert.equal(effective.policy.allowSelfReview,false);
    assert.equal(effective.source,`rule:${w.versionId}`);
    // An invalid policy is refused at proposal time and cannot be smuggled in.
    assert.throws(()=>proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,
      boundary:{},policy:{reviewPolicy:{reviewers:"Everyone"}}}),{code:"conflict"});
  }finally{f.db.close();}
});

test("Console Rule adoption preview is inert, exact native review applies, stale parent cannot be adopted",async()=>{
  const setup=new LocalSetup(mkdtempSync(join(tmpdir(),"sidera-rule-console-")));setup.bootstrap();
  const {humanId}=await setup.createHuman({label:"Human"});let db=setup.db();
  const worldId=setup.world(),node=new SemanticStore(db,worldId).registerNode("Rules proposer");
  const p=proposeRules(db,node,{requestId:"world",worldId,level:"World",scopeRef:worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.*"]},policy:{}});db.close();
  const preview=setup.rulesAdoption({humanId,proposalId:p.proposalId});
  assert.equal(preview.adopted,false);assert.equal(preview.ruleProposal.objectHash,p.objectHash);
  assert.ok(preview.exactStatement.includes(p.objectHash));assert.ok(preview.exactStatement.includes("file.*"));
  db=setup.db();assert.equal(db.prepare("SELECT count(*) n FROM rule_versions").get()!.n,0);db.close();
  assert.throws(()=>setup.applyConfirmed({reviewId:preview.reviewId,confirmation:"APPROVE DIFFERENT OBJECT"}),/HUMAN_CONFIRMATION_REQUIRED/);
  assert.throws(()=>setup.applyConfirmed({reviewId:preview.reviewId,confirmation:preview.confirmationText,proposalId:"changed-object"}));
  const adopted=setup.nativeReview({reviewId:preview.reviewId}).apply() as {versionId:string};
  db=setup.db();
  const projectProposal=proposeRules(db,node,{requestId:"project",worldId,level:"Project",scopeRef:"exact-project",projectRef:"exact-project",parentVersionId:adopted.versionId,boundary:{operations:["file.read"]},policy:{}});
  db.close();
  const stale=setup.rulesAdoption({humanId,proposalId:projectProposal.proposalId});
  db=setup.db();const next=proposeRules(db,node,{requestId:"world-next",worldId,level:"World",scopeRef:worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.read"]},policy:{}});db.close();
  const nextReview=setup.rulesAdoption({humanId,proposalId:next.proposalId});setup.nativeReview({reviewId:nextReview.reviewId}).apply();
  assert.throws(()=>setup.nativeReview({reviewId:stale.reviewId}).apply(),/current exact parent version/);
  db=setup.db();try{assert.equal(db.prepare("SELECT count(*) n FROM rule_versions WHERE level='Project'").get()!.n,0);assert.equal(currentRules(db,"World",worldId)?.proposalId,next.proposalId);}finally{db.close();}
});

test("Rule policy allows optional Human adoption with multiple distinct Operator reviews",()=>{
 const f=fixture();try{
  const declared={reviewers:"Human+Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"optional",independentRequired:true,allowSelfReview:false,reviewerCount:2};
  const wp=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{reviewPolicy:declared}}),w=adoptHuman(f,wp.proposalId,"World",f.worldId);
  const p=proposal(f,{level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:w.versionId,boundary:{},policy:{}});
  const marker="SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:p.proposalId,objectHash:p.objectHash});
  const communicator=task(f,marker,"reviewer");assert.throws(()=>bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:communicator.id}),/Operator reviewer/);
  const first=task(f,marker,"operator"),duplicate=task(f,marker,"operator"),second=task(f,marker,"operator2");
  for(const review of [first,duplicate,second]){bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:review.id});complete(f,review,p.objectHash);}
  assert.throws(()=>constitutionalRpc(f.db,{kind:"node",nodeId:"issuer",sessionId:"s-issuer"},"rules.adopt",{proposalId:p.proposalId,reviewTaskIds:[first.id,duplicate.id]}),/distinct reviewer subjects/);
  const input={proposalId:p.proposalId,reviewTaskIds:[first.id,second.id]},proof=humanProof(f.db,f.worldId,"owner",{type:"rules.adopt",objectRef:p.proposalId,scope:"rules/Project/project",targetRevision:null,args:input,causalRefs:[p.proposalId]});
  const adopted=constitutionalRpc(f.db,{kind:"human",...proof},"rules.adopt",input) as {humanActId:string};
  assert.equal(adopted.humanActId,proof.actId);
  const stored=f.db.prepare("SELECT review_task_id FROM rule_versions WHERE proposal_id=?").get(p.proposalId)!;
  assert.deepEqual(JSON.parse(String(stored.review_task_id)),input.reviewTaskIds);
 }finally{f.db.close();}
});

test("Machine-adopted Project standing Grant retains its real Human ancestor and expires with that parent",()=>{
 const f=fixture();try{
  const reviewPolicy={reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:true,allowSelfReview:false,reviewerCount:1};
  const input={level:"World" as const,scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.read"],resources:["node/**"]},policy:{reviewPolicy}};
  const wp=proposal(f,input),w=adoptHuman(f,wp.proposalId,"World",f.worldId);
  const grant={subjectNodeId:"issuer",capability:"file.read",resourceScope:"node/issuer/**",productScope:"*",projectRef:"project"};
  const p=proposal(f,{level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:w.versionId,boundary:{operations:["file.read"],resources:["node/issuer/**"]},policy:{authority:[grant]}});
  const review=task(f,"SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:p.proposalId,objectHash:p.objectHash}));bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:review.id});complete(f,review,p.objectHash);
  const adopted=adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskId:review.id});assert.equal(adopted.humanActId,null);
  const g=issueRuleGrant(f.db,"issuer",{requestId:"project-standing",ruleVersionId:adopted.versionId,grantIndex:0});
  assert.equal(f.db.prepare("SELECT human_act_id FROM grant_provenance WHERE grant_id=?").get(g.grantId)!.human_act_id,w.humanActId);
  const action={subjectNodeId:"issuer",sessionId:"s-issuer",capability:"file.read",resource:"node/issuer/file",projectRef:"project",requestId:"read"};assert.equal(canUseCapability(f.db,action),true);
  const next=proposal(f,input);adoptHuman(f,next.proposalId,"World",f.worldId);assert.equal(canUseCapability(f.db,{...action,requestId:"after-parent-change"}),false);
 }finally{f.db.close();}
});

test("Native Human adoption path carries all selected reviews and displays the governing parent policy",async()=>{
 const setup=new LocalSetup(mkdtempSync(join(tmpdir(),"sidera-rule-multiple-")));setup.bootstrap();
 const {humanId}=await setup.createHuman({label:"Human"}),worldId=setup.world();
 let db=setup.db();const store=new SemanticStore(db,worldId),issuer=store.registerNode("Proposer"),one=store.registerNode("One"),two=store.registerNode("Two"),at=new Date().toISOString();
 for(const node of [issuer,one,two])db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run("s-"+node,node,"loc-"+node,at);
 const policy={reviewers:"Human+Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"required",independentRequired:true,allowSelfReview:false,reviewerCount:2};
 const wp=proposeRules(db,issuer,{requestId:"world",worldId,level:"World",scopeRef:worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{reviewPolicy:policy}});db.close();
 const w=setup.nativeReview({reviewId:setup.rulesAdoption({humanId,proposalId:wp.proposalId}).reviewId}).apply() as {versionId:string};
 db=setup.db();const p=proposeRules(db,issuer,{requestId:"project",worldId,level:"Project",scopeRef:"project",projectRef:"project",parentVersionId:w.versionId,boundary:{},policy:{}});
 const ids:string[]=[];
 for(const reviewer of [one,two]){
  const id=randomUUID(),run=randomUUID(),message=randomUUID();ids.push(id);
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,'[]','running',NULL,?)").run(id,id,issuer,reviewer,at);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,1,'task',?,'observed','review-turn',NULL,?)").run(message,"task:"+id,id,issuer,reviewer,"s-"+reviewer,"SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:p.proposalId,objectHash:p.objectHash}),at);
  db.prepare("INSERT INTO task_runs VALUES (?,?,?,?,'running',1,'',?)").run(run,id,"s-"+reviewer,message,at);
  bindRuleReview(db,issuer,{proposalId:p.proposalId,reviewTaskId:id});
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,'result',?,'queued',NULL,NULL,?)").run(randomUUID(),"result:"+run,id,reviewer,issuer,"s-"+issuer,ids.length,canonical({objectHash:p.objectHash,decision:"approve"}),at);
  db.prepare("UPDATE task_runs SET state='completed',turn_open=0 WHERE run_id=?").run(run);db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(id);
 }
 db.close();
 const projection=new DesktopManagement(setup).consoleProjection(),shown=projection.ruleProposals.find(r=>r.proposalId===p.proposalId)!;
 assert.equal(shown.reviewPolicy.reviewerCount,2);assert.equal(shown.reviewPolicySource,"rule:"+w.versionId);
 const preview=setup.rulesAdoption({humanId,proposalId:p.proposalId,reviewTaskIds:ids});
 assert.equal(preview.adopted,false);assert.deepEqual(preview.args.reviewTaskIds,ids);
 setup.nativeReview({reviewId:preview.reviewId}).apply();
 db=setup.db();try{assert.deepEqual(JSON.parse(String(db.prepare("SELECT review_task_id FROM rule_versions WHERE proposal_id=?").get(p.proposalId)!.review_task_id)),ids);}finally{db.close();}
});

test("CR-World adopted successor procedure is exact, replaceable and retains a real Human root",()=>{
 const f=fixture();try{
  const worldReviewPolicy={reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:true,allowSelfReview:false,reviewerCount:2};
  const boundary={operations:["file.read"],resources:["node/**"]};
  const first=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary,policy:{worldReviewPolicy}});
  const original=adoptHuman(f,first.proposalId,"World",f.worldId);
  const grant={subjectNodeId:"issuer",capability:"file.read",resourceScope:"node/issuer/**",productScope:"*"};
  const humanNext={reviewers:"Human",reviewerSelection:"Human",humanInvolvement:"required",independentRequired:false,allowSelfReview:true,reviewerCount:0};
  const p=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.read"],resources:["node/issuer/**"]},policy:{worldReviewPolicy:humanNext,authority:[grant]}});
  const source=getRuleProposal(f.db,p.proposalId);assert.equal(source.object.governanceVersionId,original.versionId);
  const object=constitutionalRpc(f.db,{kind:"node",nodeId:"issuer",sessionId:"s-issuer"},"rules.review_object",{proposalId:p.proposalId}) as {reviewPolicy:{reviewerCount:number};reviewPolicySource:string};
  assert.equal(object.reviewPolicy.reviewerCount,2);assert.equal(object.reviewPolicySource,"rule:"+original.versionId+"/worldReviewPolicy");
  const marker="SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:p.proposalId,objectHash:p.objectHash});
  const one=task(f,marker,"operator"),two=task(f,marker,"operator2");
  for(const review of [one,two]){bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:review.id});complete(f,review,p.objectHash);}
  const acts=f.db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n;
  assert.throws(()=>adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskId:one.id}),/2 distinct completed machine review/);
  const adopted=adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskIds:[one.id,two.id]});
  assert.equal(adopted.governanceVersionId,original.versionId);assert.equal(adopted.humanActId,null);
  assert.equal(adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskIds:[one.id,two.id]}).versionId,adopted.versionId);
  assert.equal(f.db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n,acts);
  const g=issueRuleGrant(f.db,"issuer",{requestId:"world-standing",ruleVersionId:adopted.versionId,grantIndex:0});
  assert.equal(f.db.prepare("SELECT human_act_id FROM grant_provenance WHERE grant_id=?").get(g.grantId)!.human_act_id,original.humanActId);
  const action={subjectNodeId:"issuer",sessionId:"s-issuer",capability:"file.read",resource:"node/issuer/file",requestId:"read"};
  assert.equal(canUseCapability(f.db,action),true);
  const next=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{}});
  adoptHuman(f,next.proposalId,"World",f.worldId);
  assert.equal(canUseCapability(f.db,{...action,requestId:"after-world-version"}),false);
 }finally{f.db.close();}
});

test("CR-World a changed current procedure invalidates pending exact World proposals",()=>{
 const f=fixture();try{
  const input={level:"World" as const,scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{},policy:{}};
  const first=proposal(f,input),bootstrapPending=proposal(f,input);adoptHuman(f,first.proposalId,"World",f.worldId);
  assert.throws(()=>adoptHuman(f,bootstrapPending.proposalId,"World",f.worldId),/governance version is stale/);
  const pending=proposal(f,input),replacement=proposal(f,input);
  const pinned=getRuleProposal(f.db,pending.proposalId).object.governanceVersionId;
  adoptHuman(f,replacement.proposalId,"World",f.worldId);
  assert.throws(()=>adoptHuman(f,pending.proposalId,"World",f.worldId),/governance version is stale/);
  assert.equal(getRuleProposal(f.db,pending.proposalId).object.governanceVersionId,pinned);
  assert.throws(()=>f.db.prepare("UPDATE rule_proposals SET governance_version_id=NULL WHERE proposal_id=?").run(pending.proposalId),/immutable/);
  const digest=getRuleProposal(f.db,pending.proposalId).objectHash;migrateRules(f.db);
  assert.equal(getRuleProposal(f.db,pending.proposalId).objectHash,digest);
 }finally{f.db.close();}
});

test("CR-World machine adoption cannot widen the governing World or select another procedure",()=>{
 const f=fixture();try{
  const worldReviewPolicy={reviewers:"Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"none",independentRequired:true,allowSelfReview:false,reviewerCount:1};
  const first=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.read"],resources:["node/issuer/**"]},policy:{worldReviewPolicy}});
  const w=adoptHuman(f,first.proposalId,"World",f.worldId);
  assert.throws(()=>proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,governanceVersionId:"caller-procedure",boundary:{},policy:{}}),/cannot replace/);
  const p=proposal(f,{level:"World",scopeRef:f.worldId,parentVersionId:BASIC_RULES_VERSION,boundary:{operations:["file.*"],resources:["*"]},policy:{worldReviewPolicy}});
  const review=task(f,"SIDERA_MACHINE_REVIEW_V1\n"+canonical({proposalId:p.proposalId,objectHash:p.objectHash}));
  bindRuleReview(f.db,"issuer",{proposalId:p.proposalId,reviewTaskId:review.id});complete(f,review,p.objectHash);
  assert.throws(()=>adoptRules(f.db,{kind:"node",nodeId:"issuer"},{proposalId:p.proposalId,reviewTaskId:review.id}),/widen/);
  assert.equal(currentRules(f.db,"World",f.worldId)!.versionId,w.versionId);
 }finally{f.db.close();}
});

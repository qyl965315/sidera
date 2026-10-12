/**
 * SYNTHETIC, offline policy experiment. No provider, network, service, or production DB.
 * The policy lives only here. Runtime/Continuation/MessageBus/Authority/Effect are real.
 * Fixture helpers create explicitly synthetic Human grants, basis and Host evidence.
 * Run: node scripts/orchestration-cost-experiment.ts
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";
import {openDatabase} from "../core/db.ts";
import {CoreRuntime} from "../core/runtime.ts";
import {getTask} from "../core/scheduler.ts";
import {effectKnowledge,type EffectControlProfile} from "../core/effect-gate.ts";
import {registerNodeOntology} from "../core/ontology.ts";
import {executorPool} from "../core/executors.ts";
import {grantSelf,issueGrant} from "../tests/fixtures/authority.ts";
import {fixtureBasis} from "../tests/fixtures/execution.ts";
import {recordFixtureHostAvailable} from "../tests/fixtures/host-condition.ts";
import type {Hythe} from "../hythes/types.ts";

type Policy="A"|"B"|"C";
type Scenario="normal"|"pre_effect_rejection";
type LedgerRow={id:string;account:string;minor:number};
type LedgerResult={balances:{account:string;minor:number}[];totalMinor:number;acceptedIds:string[];rejectedIds:string[]};
type Job={kind:"produce"|"verify"|"exception_triage";records:LedgerRow[];candidate?:LedgerResult;failedTaskId?:string};
type Envelope={messageId:string;taskId:string;kind:string;body:string};
type Invocation={index:number;nodeId:string;fromNodeId:string;messageId:string;taskId:string;messageKind:string;
  jobKind:Job["kind"]|"result_receipt";crossed:boolean;hostRef:string|null;output:string|null};

const OPERATORS=["operator-1","operator-2","operator-3","operator-4"];
const CC="synthetic-cc";
const RECORDS:LedgerRow[]=[
  {id:"r1",account:"alpha",minor:1200},{id:"r2",account:"beta",minor:-250},
  {id:"r3",account:"alpha",minor:-75},{id:"r4",account:"gamma",minor:0},
  {id:"r5",account:"beta",minor:100},{id:"r6",account:"",minor:999},
  {id:"r7",account:"alpha",minor:1.25},{id:"r8",account:"gamma",minor:50},
];
const EXPECTED:LedgerResult={balances:[{account:"alpha",minor:1125},{account:"beta",minor:-150},{account:"gamma",minor:50}],
  totalMinor:1025,acceptedIds:["r1","r2","r3","r4","r5","r8"],rejectedIds:["r6","r7"]};
const INPUT_SHA256=createHash("sha256").update(JSON.stringify(RECORDS)).digest("hex");
const PROFILE:EffectControlProfile={id:"synthetic:orchestration-cost",version:"1",control:"SideraControlled",
  boundary:"synchronous offline stub activation",admission:"recorded in-memory invocation",
  businessEffects:["deterministic in-memory ledger calculation"],cancellation:null,
  uncertainInterval:"stub crossing until correlated synthetic terminal receipt",externalIdentityRequired:false};

function produce(records:LedgerRow[]):LedgerResult {
  const totals=new Map<string,number>(),acceptedIds:string[]=[],rejectedIds:string[]=[];
  for(const row of records) {
    if(!row.account.trim()||!Number.isSafeInteger(row.minor)){rejectedIds.push(row.id);continue;}
    acceptedIds.push(row.id);totals.set(row.account,(totals.get(row.account)??0)+row.minor);
  }
  const balances=[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([account,minor])=>({account,minor}));
  return {balances,totalMinor:balances.reduce((n,x)=>n+x.minor,0),acceptedIds:acceptedIds.sort(),rejectedIds:rejectedIds.sort()};
}

// Independent verifier algorithm plus a fixed known-answer oracle. No LLM quality is inferred.
function verify(records:LedgerRow[],candidate:LedgerResult):boolean {
  const valid=records.filter(r=>r.account.trim().length>0&&Number.isSafeInteger(r.minor));
  const expected:LedgerResult={
    balances:[...new Set(valid.map(r=>r.account))].sort().map(account=>({account,
      minor:valid.filter(r=>r.account===account).reduce((n,r)=>n+r.minor,0)})),
    totalMinor:valid.reduce((n,r)=>n+r.minor,0),acceptedIds:valid.map(r=>r.id).sort(),
    rejectedIds:records.filter(r=>!valid.includes(r)).map(r=>r.id).sort(),
  };
  try{assert.deepEqual(candidate,expected);return true;}catch{return false;}
}

async function runCase(policy:Policy,scenario:Scenario) {
  const db=openDatabase(":memory:"),at=new Date().toISOString();
  // Setup is excluded from elapsed execution time and identical for every case.
  for(const node of [CC,...OPERATORS]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'synthetic','synthetic',?,'active',?)")
      .run(`${node}-session`,node,`synthetic://${node}`,at);
    grantSelf(db,node);recordFixtureHostAvailable(db,`${node}-session`);
    for(const capability of ["task.dispatch","message.send"])
      issueGrant(db,{kind:"human",id:"SYNTHETIC-experiment-setup"},{subjectNodeId:node,capability,resourceScope:"node/**"});
  }
  registerNodeOntology(db,CC,{kind:"Communicator"});
  const basis=fixtureBasis(db,CC);
  for(const node of OPERATORS)assert.equal(executorPool(db,node)[0]?.state,"IDLE");
  const calls:Invocation[]=[],pending:Invocation[]=[],completed=new Set<string>();
  let rejectOnce=scenario==="pre_effect_rejection";
  const adapter:Hythe={hytheId:"synthetic",hostKind:"synthetic",capabilities:()=>["message.receive"],
    effectProfile:()=>PROFILE,locate:async()=>true,receive:async function*(){},
    invoke:async(locator,_cap,input,_request,boundary)=>{
      assert.ok(boundary,"Every stub invocation needs the real Core Effect boundary");
      const envelope=input as Envelope,nodeId=locator.slice("synthetic://".length);
      const message=db.prepare("SELECT from_node_id FROM messages WHERE message_id=?").get(envelope.messageId)!;
      const job=envelope.kind==="result"?null:JSON.parse(envelope.body) as Job;
      const entry:Invocation={index:calls.length+1,nodeId,fromNodeId:String(message.from_node_id),
        messageId:envelope.messageId,taskId:envelope.taskId,messageKind:envelope.kind,
        jobKind:job?.kind??"result_receipt",crossed:false,hostRef:null,output:null};
      calls.push(entry); // Counts the real invoke entrance, including pre-effect rejection.
      if(rejectOnce&&nodeId===OPERATORS[0]&&job?.kind==="produce") {
        rejectOnce=false;
        return {status:"rejected",reason:"SYNTHETIC known pre-effect rejection; boundary.cross was never called"};
      }
      return boundary.cross({product:"synthetic",locator,operation:"message.receive"},()=>{
        entry.crossed=true;entry.hostRef=`synthetic-turn:${entry.index}:${envelope.messageId}`;
        entry.output=job?.kind==="produce"?JSON.stringify(produce(job.records)):
          job?.kind==="verify"?JSON.stringify({accepted:verify(job.records,job.candidate!)}):
          job?.kind==="exception_triage"?JSON.stringify({decision:"use-unused-operator",failedTaskId:job.failedTaskId,
            reason:"Canonical failed Task and confirmed_no_effect were inspected before this synthetic coordination turn"}):
          "SYNTHETIC correlated result receipt";
        pending.push(entry);
        return {status:"accepted" as const,hostRef:entry.hostRef};
      });
    }};
  const runtime=new CoreRuntime(db,new Map([["synthetic",adapter]]),undefined,{ownerId:`synthetic:${policy}:${scenario}`});
  const failures:Array<{taskId:string;messageId:string;effectKnowledge:string;invocations:number;crossings:number}>=[];
  const jobTasks:Array<{taskId:string;nodeId:string;kind:Job["kind"];state:string}>=[];
  const setupHumanActCount=Number(db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n);
  const started=performance.now();let serial=0;
  async function drain() {
    // Push terminal receipts once. No polling, provider calls, or timeout replay.
    while(pending.length) {
      const entry=pending.shift()!;
      assert.ok(!completed.has(entry.messageId));completed.add(entry.messageId);
      await runtime.ingest(`${entry.nodeId}-session`,{observedMessageId:entry.messageId,
        hostRef:entry.hostRef!,outcome:"completed",body:entry.output!});
    }
  }
  async function dispatch(nodeId:string,job:Job):Promise<{failed:true;taskId:string}|{failed:false;taskId:string;body:string}> {
    const result=await runtime.dispatch({requestId:`${policy}:${scenario}:${++serial}`,originNodeId:CC,
      originSessionId:`${CC}-session`,centerNodeId:nodeId,workerNodeIds:[],basis,body:JSON.stringify(job)});
    await drain();
    const view=getTask(db,result.task.taskId);
    jobTasks.push({taskId:view.task.taskId,nodeId,kind:job.kind,state:view.task.state});
    if(view.task.state==="failed") {
      const attempt=db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1")
        .get(result.firstMessage.messageId)!;
      const knowledge=effectKnowledge(db,String(attempt.attempt_id));
      const entries=calls.filter(c=>c.messageId===result.firstMessage.messageId);
      assert.equal(knowledge,"confirmed_no_effect","Only definite pre-effect failures permit policy rescheduling");
      assert.equal(entries.filter(c=>c.crossed).length,0);
      failures.push({taskId:view.task.taskId,messageId:result.firstMessage.messageId,effectKnowledge:knowledge,
        invocations:entries.length,crossings:0});
      return {failed:true,taskId:view.task.taskId};
    }
    assert.equal(view.task.state,"completed");
    const receipt=view.messages.find(m=>m.kind==="result");
    assert.ok(receipt);assert.equal(receipt.state,"observed","Result must return and be observed in the exact CC session");
    assert.equal(receipt.targetSessionId,`${CC}-session`);
    return {failed:false,taskId:view.task.taskId,body:receipt.body};
  }
  try {
    let producer=OPERATORS[0]!,produced=await dispatch(producer,{kind:"produce",records:RECORDS});
    if(produced.failed) {
      if(policy==="C") {
        const triage=await dispatch(CC,{kind:"exception_triage",records:RECORDS,failedTaskId:produced.taskId});
        assert.equal(triage.failed,false);
        if(!triage.failed)assert.equal(JSON.parse(triage.body).decision,"use-unused-operator");
      }
      producer=OPERATORS[1]!;
      produced=await dispatch(producer,{kind:"produce",records:RECORDS,failedTaskId:produced.taskId});
    }
    assert.equal(produced.failed,false);
    if(produced.failed)throw Error("Bounded single fallback did not complete");
    const candidate=JSON.parse(produced.body) as LedgerResult;
    assert.deepEqual(candidate,EXPECTED);
    const reviewers=OPERATORS.filter(node=>node!==producer).slice(0,policy==="A"?3:1);
    let acceptedReviews=0;
    for(const node of reviewers) {
      const review=await dispatch(node,{kind:"verify",records:RECORDS,candidate});
      assert.equal(review.failed,false);
      if(!review.failed&&JSON.parse(review.body).accepted===true)acceptedReviews++;
    }
    // The common quality gate is identical across policies. Extra reviews are
    // a selected policy obligation, not a stronger acceptance gate for A.
    const accepted=acceptedReviews>=1,selectedReviewPolicyFulfilled=acceptedReviews===reviewers.length;
    const elapsedMs=performance.now()-started;
    const effects=db.prepare("SELECT attempt_id,source_message_id FROM action_attempts ORDER BY rowid").all().map(a=>({
      attemptId:String(a.attempt_id),messageId:String(a.source_message_id),knowledge:effectKnowledge(db,String(a.attempt_id))}));
    assert.ok(effects.every(e=>e.knowledge==="completed"||e.knowledge==="confirmed_no_effect"));
    assert.equal(effects.length,calls.length,"Every actual invoke must retain its canonical Effect attempt");
    for(const entry of calls)assert.equal(effects.find(e=>e.messageId===entry.messageId)?.knowledge,
      entry.crossed?"completed":"confirmed_no_effect");
    assert.equal(pending.length,0);
    assert.equal(db.prepare("SELECT count(*) n FROM task_runs WHERE turn_open=1 OR state='uncertain'").get()!.n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.event_processing_error'").get()!.n,0);
    const activations=calls.filter(c=>c.crossed);
    const count=(predicate:(c:Invocation)=>boolean)=>activations.filter(predicate).length;
    const activatedOperatorNodeCount=new Set(activations.filter(c=>OPERATORS.includes(c.nodeId)).map(c=>c.nodeId)).size;
    const runtimeHumanActs=Number(db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n)-setupHumanActCount;
    return {policy,scenario,evidenceKind:"SYNTHETIC_STUB_HOST",inputSha256:INPUT_SHA256,
      availableOperatorNodeCount:OPERATORS.length,availableOperatorNodeIds:OPERATORS,
      metrics:{stubInvokeCount:calls.length,hostActivationCount:activations.length,
        operatorActivationCount:count(c=>OPERATORS.includes(c.nodeId)),
        activatedOperatorNodeCount,idleOperatorNodeCount:OPERATORS.length-activatedOperatorNodeCount,
        ccActivationCount:count(c=>c.nodeId===CC),ccExtraCoordinationTurns:count(c=>c.nodeId===CC&&c.jobKind==="exception_triage"),
        ccResultReceiptTurns:count(c=>c.nodeId===CC&&c.jobKind==="result_receipt"),
        operatorToOperatorTurns:count(c=>OPERATORS.includes(c.fromNodeId)&&OPERATORS.includes(c.nodeId)),
        taskAttempts:jobTasks.length,failedPreEffectAttempts:failures.length,preEffectReschedules:failures.length,
        taskReworkCount:Math.max(0,count(c=>c.jobKind==="produce")-1),
        independentReviewCount:reviewers.length,acceptedReviewCount:acceptedReviews,
        acceptanceRate:Number(accepted),acceptedTaskCount:Number(accepted),qualityTaskCount:1,
        faultHumanInterventions:runtimeHumanActs,elapsedMs:Number(elapsedMs.toFixed(3)),tokens:"UNKNOWN",dollars:"UNKNOWN"},
      accepted,selectedReviewPolicyFulfilled,output:candidate,failures,jobTasks,invocations:calls,effects};
  } finally {runtime.close();db.close();}
}

export async function runOrchestrationCostExperiment() {
  // Validate the quality oracle itself, including a deliberately corrupt candidate.
  assert.deepEqual(produce(RECORDS),EXPECTED);assert.equal(verify(RECORDS,EXPECTED),true);
  assert.equal(verify(RECORDS,{...EXPECTED,totalMinor:EXPECTED.totalMinor+1}),false);
  const runs=[];
  for(const scenario of ["normal","pre_effect_rejection"] as const)
    for(const policy of ["A","B","C"] as const)runs.push(await runCase(policy,scenario));
  const b=runs.find(r=>r.policy==="B"&&r.scenario==="normal")!;
  const c=runs.find(r=>r.policy==="C"&&r.scenario==="normal")!;
  assert.equal(b.metrics.hostActivationCount,c.metrics.hostActivationCount);
  assert.ok(runs.every(r=>r.accepted));
  return {schemaVersion:1,evidenceKind:"SYNTHETIC_STUB_HOST",generatedAt:new Date().toISOString(),
    command:"node scripts/orchestration-cost-experiment.ts",
    design:{qualityTask:"Aggregate valid integer minor-unit ledger rows; sorted exact balances and accepted/rejected IDs",
      minimumAcceptance:"Known answer match plus at least one independent Operator verification",
      policies:{A:"Fixed four Operators: one producer and three independent verifiers; deliberate redundant review policy",
        B:"Central sparse: one producer and one independent verifier; deterministic pre-effect fallback",
        C:"Same sparse path as B; one additional CC triage Task only after observed confirmed_no_effect failure"},
      resourceParity:"Four initially IDLE Operator Nodes and one synthetic Communicator coordinator in every case",
      fault:"First producer invoke rejects before boundary.cross. A new bounded fallback is allowed only after Core confirmed_no_effect",
      faultLifetime:"One Task invocation rejects once; the Host is not permanently unavailable. Operator-1 can later verify a different Task. This is not a real Host replacement experiment",
      measurement:"Actual stub invoke entrances and actual Effect boundary crossings; all CC result receipt turns included",
      reworkDefinition:"Additional producer activations after a producer already crossed; pre-effect reschedules reported separately",
      humanInterventionDefinition:"Measured increase in canonical Human semantic acts after common synthetic setup",
      ccRole:"SYNTHETIC Communicator coordination surrogate; no real ChiefConversation or Chat binding is claimed",
      timing:"Single local sequential run per cell, excluding common fixture setup; no provider latency or speed ranking",
      fixtureSetup:"Existing unmodified helpers create synthetic Human authority/basis/Host health only; production Runtime is imported directly"},
    limitations:["No real model inference, provider token accounting, USD billing, network, production DB, or external side effect",
      "All outputs use deterministic offline algorithms; acceptance cannot establish real LLM quality equivalence",
      "A's extra activations follow the explicitly chosen redundant review policy, not a universal baseline",
      "C can equal B on normal runs and cost more on faults; this experiment does not prove C improves quality",
      "CC triage uses a deterministic stub decision after canonical failure inspection; planning/reasoning capability is not measured",
      "Zero Human intervention covers only this known pre-effect fixture; unknown effects must stop for reconciliation",
      "No Operator-to-Operator topology is exercised; its measured turn count is zero",
      "Tokens and dollars remain UNKNOWN; activation counts are not estimated tokens or money"],runs};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=await runOrchestrationCostExperiment();
  const output=resolve(dirname(fileURLToPath(import.meta.url)),"../evidence/global-convergence-20261012/orchestration-cost.json");
  mkdirSync(dirname(output),{recursive:true});
  const json=JSON.stringify(report,null,2)+"\n";writeFileSync(output,json,"utf8");process.stdout.write(json);
}

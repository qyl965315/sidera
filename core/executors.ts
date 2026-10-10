import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";
import { withTransaction } from "./db.ts";
import { appendHistory } from "./history.ts";
import { readNodeOntology,chiefConversationRole } from "./ontology.ts";
import { completedMachineReview,currentRules } from "./rules.ts";
import { hasPendingStandaloneTurn } from "./continuations.ts";
import { reserveCapability,settleReservation } from "./authority.ts";
import { recordWorld,requireWorld } from "./worlds.ts";
import { canonical } from "./human-admission.ts";
import { readSessionHostCondition, type SessionHostCondition } from "./condition.ts";

export interface ExecutorView {
  executorRef:string; operatorNodeRef:string; runtimeSessionId:string;
  state:"IDLE"|"BUSY"|"UNAVAILABLE"; reason:string|null; contextState:"usable"|"exhausted"|"corrupted"|"unusable";
  hostCondition?: SessionHostCondition;
}
export type ExecutorSelection={state:"selected";executor:ExecutorView}|{state:"machine_review_required"|"waiting";reason:string;reviewRef?:string};

export function migrateExecutors(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_executors(
    executor_ref TEXT PRIMARY KEY,operator_node_ref TEXT NOT NULL REFERENCES nodes(node_id),
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
    context_state TEXT NOT NULL CHECK(context_state IN ('usable','exhausted','corrupted','unusable')),reason TEXT,created_at TEXT NOT NULL,
    routing_admitted INTEGER NOT NULL DEFAULT 0 CHECK(routing_admitted IN(0,1)));
    CREATE TABLE IF NOT EXISTS task_executor_assignments(
      assignment_id TEXT PRIMARY KEY,task_ref TEXT NOT NULL REFERENCES tasks(task_id),executor_ref TEXT NOT NULL REFERENCES operator_executors(executor_ref),
      state TEXT NOT NULL CHECK(state IN ('assigned','released')),review_ref TEXT,created_at TEXT NOT NULL,
      UNIQUE(task_ref,executor_ref));
    CREATE TABLE IF NOT EXISTS executor_machine_reviews(
      review_ref TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,operator_node_ref TEXT NOT NULL REFERENCES nodes(node_id),
      binding_id TEXT NOT NULL,conversation_ref TEXT NOT NULL,review_task_ref TEXT NOT NULL REFERENCES tasks(task_id),
      decision TEXT NOT NULL CHECK(decision IN ('wait','reuse','open')),executor_ref TEXT,reason TEXT NOT NULL,
      used_by TEXT,created_at TEXT NOT NULL);`);
  syncExecutorPool(db);
}

/** Inventory is a projection of registered exact contexts, never a claim of live Host Presence. */
export function syncExecutorPool(db:DatabaseSync) {
  db.prepare(`INSERT OR IGNORE INTO operator_executors
    SELECT 'executor:'||s.session_id,s.node_id,s.session_id,'usable',NULL,s.created_at,0
    FROM sessions s JOIN node_ontology n ON n.node_ref=s.node_id WHERE n.kind='Operator'`).run();
}

export function executorPool(db:DatabaseSync,operatorNodeRef:string):ExecutorView[] {
  if(readNodeOntology(db,operatorNodeRef).kind!=="Operator")return [];
  syncExecutorPool(db);
  return db.prepare(`SELECT e.*,s.state session_state,n.lifecycle FROM operator_executors e JOIN sessions s ON s.session_id=e.session_id
    JOIN nodes n ON n.node_id=e.operator_node_ref WHERE operator_node_ref=? ORDER BY e.created_at,e.executor_ref`).all(operatorNodeRef).map(e=>{
      const id=String(e.session_id),context=e.context_state as ExecutorView["contextState"];
      const health=readSessionHostCondition(db,id);
      const unavailable=context!=="usable"||e.lifecycle!=="active"||e.session_state==="retired"||
        (e.session_state!=="active"&&!e.routing_admitted)||!health.canExecute;
      const busy=Boolean(hasPendingStandaloneTurn(db,id)||db.prepare(`SELECT 1 FROM task_runs r WHERE session_id=? AND (turn_open=1 OR
          (state='uncertain' AND NOT EXISTS(SELECT 1 FROM runtime_event_tasks t WHERE t.task_id=r.task_id)))`).get(id)||
        db.prepare(`SELECT 1 FROM messages m WHERE target_session_id=? AND state IN ('queued','sending','uncertain')
          AND NOT (state='uncertain' AND EXISTS(SELECT 1 FROM runtime_event_tasks e JOIN task_runs r ON r.task_id=e.task_id
            WHERE e.task_id=m.task_id AND r.message_id=m.message_id AND r.turn_open=0))`).get(id)||
        db.prepare(`SELECT 1 FROM task_executor_assignments a JOIN tasks t ON t.task_id=a.task_ref
          WHERE a.executor_ref=? AND a.state='assigned' AND t.state NOT IN ('completed','failed')
          AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.task_id=a.task_ref)`).get(String(e.executor_ref)));
      return {executorRef:String(e.executor_ref),operatorNodeRef,runtimeSessionId:id,
        state:unavailable?"UNAVAILABLE":busy?"BUSY":"IDLE",contextState:context,hostCondition:health,
        reason:unavailable?(e.reason?String(e.reason):e.session_state!=="active"&&!e.routing_admitted?
          "Runtime context has not been admitted":`Host condition ${health.state}: ${health.reason}`):
          busy?"Existing Task or uncertain effect owns this context":null};
    });
}

/** Trusted post-Authority/post-Host-verification hook. This registers one already-created exact context; it cannot create a Host. */
export function admitExecutorRuntime(db:DatabaseSync,input:{operatorNodeRef:string;sessionId:string;reviewRef:string}) {
  if(readNodeOntology(db,input.operatorNodeRef).kind!=="Operator")throw new SideraError("denied","Only Operator contexts are Executors");
  const session=db.prepare("SELECT * FROM sessions WHERE session_id=? AND node_id=? AND state!='retired'").get(input.sessionId,input.operatorNodeRef);
  if(!session)throw new SideraError("not_found","Exact registered Operator runtime context required");
  syncExecutorPool(db);
  const existing=executorPool(db,input.operatorNodeRef).find(e=>e.runtimeSessionId===input.sessionId)!;
  if(existing.state!=="UNAVAILABLE")return existing;
  if(executorPool(db,input.operatorNodeRef).some(e=>e.state==="IDLE"))throw new SideraError("conflict","Reuse an idle Executor before admitting another");
  const review=db.prepare("SELECT * FROM executor_machine_reviews WHERE review_ref=? AND operator_node_ref=? AND decision='open'").get(input.reviewRef,input.operatorNodeRef);
  if(!review||review.used_by&&review.used_by!==existing.executorRef)throw new SideraError("denied","Fresh Chief Conversation machine review is required to open parallel context");
  const role=db.prepare("SELECT 1 FROM chief_conversations WHERE binding_id=? AND conversation_ref=? AND state='active'").get(review.binding_id,review.conversation_ref);
  if(!role)throw new SideraError("denied","Executor review belongs to an inactive Chief Conversation");
  return withTransaction(db,"executor_admit",()=>{
    db.prepare("UPDATE operator_executors SET routing_admitted=1 WHERE executor_ref=?").run(existing.executorRef);
    db.prepare("UPDATE executor_machine_reviews SET used_by=? WHERE review_ref=?").run(existing.executorRef,input.reviewRef);
    appendHistory(db,{kind:"Action",source:"executor.admit",worldRef:recordWorld(db,"nodes",input.operatorNodeRef),nodeRef:input.operatorNodeRef,executorRef:existing.executorRef,
      payload:{runtimeSessionId:input.sessionId,reviewRef:input.reviewRef}});
    return executorPool(db,input.operatorNodeRef).find(e=>e.executorRef===existing.executorRef)!;
  });
}

/** Runtime/default Session are distinct. Registered parallel contexts require explicit pool admission. */
export function isExecutorRuntimeSession(db:DatabaseSync,nodeRef:string,sessionId:string):boolean {
  return Boolean(db.prepare(`SELECT 1 FROM operator_executors e JOIN sessions s ON s.session_id=e.session_id
    JOIN nodes n ON n.node_id=e.operator_node_ref WHERE e.operator_node_ref=? AND e.session_id=? AND e.routing_admitted=1
    AND e.context_state='usable' AND s.state!='retired' AND n.lifecycle='active'`).get(nodeRef,sessionId));
}

export function selectDispatchExecutor(db:DatabaseSync,input:{operatorNodeRef:string;targetSessionId?:string;reviewRef?:string}):ExecutorSelection {
  const pool=executorPool(db,input.operatorNodeRef);
  if(input.targetSessionId) {
    const exact=pool.find(e=>e.runtimeSessionId===input.targetSessionId);
    if(exact?.state==="IDLE")return {state:"selected",executor:exact};
    return {state:"machine_review_required",reason:exact?.reason??"Exact Executor is not admitted"};
  }
  return selectExecutor(db,input);
}

function self(db:DatabaseSync,caller:{nodeId:string;sessionId:string},nodeRef:string) {
  if(caller.nodeId!==nodeRef||!db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND node_id=? AND state='active'").get(caller.sessionId,nodeRef)&&!isExecutorRuntimeSession(db,nodeRef,caller.sessionId))
    throw new SideraError("denied","Executor management belongs to its Operator's admitted context");
}

export function setExecutorContext(db:DatabaseSync,caller:{nodeId:string;sessionId:string},input:{executorRef:string;state:ExecutorView["contextState"];reason:string}) {
  if(!["usable","exhausted","corrupted","unusable"].includes(input.state)||!input.reason.trim())throw new SideraError("conflict","Exact context state and reason required");
  const e=db.prepare("SELECT * FROM operator_executors WHERE executor_ref=?").get(input.executorRef);
  if(!e)throw new SideraError("not_found","Executor not found");self(db,caller,String(e.operator_node_ref));
  return withTransaction(db,"executor_context",()=>{
    db.prepare("UPDATE operator_executors SET context_state=?,reason=? WHERE executor_ref=?").run(input.state,input.reason,input.executorRef);
    appendHistory(db,{kind:"Action",source:"executor.context",worldRef:recordWorld(db,"nodes",caller.nodeId),nodeRef:caller.nodeId,executorRef:input.executorRef,
      payload:{contextState:input.state,reason:input.reason,externalHostClaim:false}});
    return executorPool(db,caller.nodeId).find(x=>x.executorRef===input.executorRef)!;
  });
}

/** Default R1 scheduling policy, separate from constitutional Basic Rules. No Host creation here. */
export function selectExecutor(db:DatabaseSync,input:{operatorNodeRef:string;reviewRef?:string}):ExecutorSelection {
  const pool=executorPool(db,input.operatorNodeRef),idle=pool.find(e=>e.state==="IDLE");
  if(idle)return {state:"selected",executor:idle};
  const review=input.reviewRef?db.prepare("SELECT * FROM executor_machine_reviews WHERE review_ref=? AND operator_node_ref=?")
    .get(input.reviewRef,input.operatorNodeRef):null;
  if(review?.decision==="wait")return {state:"waiting",reason:String(review.reason),reviewRef:String(review.review_ref)};
  // A review can permit creating a context through Registry/Effect Authority. It never creates technical capability.
  return {state:"machine_review_required",reason:review?.decision==="open"?"Opening was reviewed; a real authorized Host context must be admitted before dispatch":"No idle usable Executor; Chief Conversation machine review is required"};
}

export function reviewExecutorPolicy(db:DatabaseSync,caller:{nodeId:string;sessionId:string},input:{requestId:string;projectRef:string;
  operatorNodeRef:string;reviewTaskRef:string;decision:"wait"|"reuse"|"open";executorRef?:string;reason:string}) {
  const role=chiefConversationRole(db,input.projectRef);
  if(!role||role.communicatorNodeRef!==caller.nodeId)throw new SideraError("denied","Only this Project's Chief Conversation can review Executor policy");
  self(db,caller,caller.nodeId);requireWorld(db,recordWorld(db,"nodes",caller.nodeId),"nodes",input.operatorNodeRef);
  if(!["wait","reuse","open"].includes(input.decision)||!input.reason.trim())throw new SideraError("conflict","Explicit machine decision and reason required");
  const prior=db.prepare("SELECT * FROM executor_machine_reviews WHERE request_id=?").get(input.requestId);
  if(prior) {
    if(prior.operator_node_ref!==input.operatorNodeRef||prior.review_task_ref!==input.reviewTaskRef||prior.decision!==input.decision||prior.reason!==input.reason||prior.executor_ref!==(input.executorRef??null)||prior.binding_id!==role.bindingId)
      throw new SideraError("conflict","Executor review requestId reused");
    return {reviewRef:String(prior.review_ref),decision:prior.decision};
  }
  const review=completedMachineReview(db,{taskId:input.reviewTaskRef,reviewerNodeId:caller.nodeId,expectedSessionId:caller.sessionId});
  const marker={bindingId:role.bindingId,conversationRef:role.conversationRef,operatorNodeRef:input.operatorNodeRef,
    decision:input.decision,executorRef:input.executorRef??null,reason:input.reason};
  let answer:unknown;try{const prefix="SIDERA_EXECUTOR_REVIEW_V1\n";if(!review.body.startsWith(prefix))throw Error();answer=JSON.parse(review.body.slice(prefix.length));}catch{answer=null;}
  if(canonical(answer)!==canonical(marker))
    throw new SideraError("denied","Completed review must identify the exact Chief Conversation and Executor decision");
  if(db.prepare("SELECT 1 FROM executor_machine_reviews WHERE review_task_ref=?").get(input.reviewTaskRef))
    throw new SideraError("conflict","This machine review has already been admitted; reuse its original reviewRef");
  if(input.decision==="reuse"&&!executorPool(db,input.operatorNodeRef).some(e=>e.executorRef===input.executorRef&&e.state==="IDLE"))
    throw new SideraError("unavailable","Reviewed Executor is not idle and usable");
  const id=randomUUID();
  return withTransaction(db,"executor_review",()=>{
    db.prepare("INSERT INTO executor_machine_reviews VALUES(?,?,?,?,?,?,?,?,?,NULL,?)")
      .run(id,input.requestId,input.operatorNodeRef,role.bindingId,role.conversationRef,input.reviewTaskRef,input.decision,input.executorRef??null,input.reason,new Date().toISOString());
    appendHistory(db,{kind:"Review",source:"executor.machine_review",worldRef:recordWorld(db,"nodes",caller.nodeId),nodeRef:caller.nodeId,communicatorRef:caller.nodeId,
      conversationRef:role.conversationRef,projectRef:role.projectRef,taskRef:input.reviewTaskRef,payload:{reviewRef:id,...marker,reason:input.reason,runId:review.runId}});
    return {reviewRef:id,decision:input.decision};
  });
}

/** Scheduler invokes this inside its Task transaction; multiple assignments are an explicit project policy. */
export function assignExecutor(db:DatabaseSync,input:{taskRef:string;executorRef:string;allowMultiple?:boolean;reviewRef?:string}) {
  const e=db.prepare("SELECT operator_node_ref FROM operator_executors WHERE executor_ref=?").get(input.executorRef);
  if(!e)throw new SideraError("not_found","Executor not found");
  const prior=db.prepare("SELECT assignment_id FROM task_executor_assignments WHERE task_ref=? AND executor_ref=?").get(input.taskRef,input.executorRef);
  if(prior)return {assignmentRef:String(prior.assignment_id),executorRef:input.executorRef};
  const task=db.prepare("SELECT center_node_id,worker_node_ids FROM tasks WHERE task_id=?").get(input.taskRef);
  if(!task)throw new SideraError("not_found","Task not found");
  if(task.center_node_id!==e.operator_node_ref&&!JSON.parse(String(task.worker_node_ids)).includes(e.operator_node_ref))
    throw new SideraError("denied","Executor Operator is not a Task participant");
  if(!input.allowMultiple&&db.prepare("SELECT 1 FROM task_executor_assignments WHERE task_ref=? AND state='assigned'").get(input.taskRef))
    throw new SideraError("denied","Project policy has not admitted multiple Executors");
  const selected=executorPool(db,String(e.operator_node_ref)).find(x=>x.executorRef===input.executorRef)!;
  if(selected.state!=="IDLE")throw new SideraError("unavailable",selected.reason??"Executor not usable");
  const id=randomUUID();
  db.prepare("INSERT INTO task_executor_assignments VALUES(?,?,?,'assigned',?,?)").run(id,input.taskRef,input.executorRef,input.reviewRef??null,new Date().toISOString());
  appendHistory(db,{kind:"Action",source:"executor.assignment",worldRef:recordWorld(db,"tasks",input.taskRef),nodeRef:String(e.operator_node_ref),taskRef:input.taskRef,executorRef:input.executorRef,
    payload:{assignmentRef:id,runtimeSessionId:selected.runtimeSessionId,reviewRef:input.reviewRef??null}});
  return {assignmentRef:id,executorRef:input.executorRef};
}

export function taskExecutorAssignments(db:DatabaseSync,taskRef:string) {
  return db.prepare(`SELECT assignment_id AS assignmentRef,executor_ref AS executorRef,state,review_ref AS reviewRef,created_at AS createdAt
    FROM task_executor_assignments WHERE task_ref=? ORDER BY created_at,assignment_id`).all(taskRef);
}

/** Node-facing assignment path. Lower Rules must explicitly admit multiple contexts for this Task. */
export function assignTaskExecutor(db:DatabaseSync,caller:{nodeId:string;sessionId:string},input:{requestId:string;taskRef:string;executorRef:string}) {
  self(db,caller,caller.nodeId);
  return withTransaction(db,"task_executor_assign",()=>{
    const task=db.prepare("SELECT * FROM tasks WHERE task_id=?").get(input.taskRef);
    if(!task||![task.origin_node_id,task.center_node_id].includes(caller.nodeId))throw new SideraError("denied","Only the Task issuer or accepting Operator may assign its work");
    requireWorld(db,recordWorld(db,"nodes",caller.nodeId),"tasks",input.taskRef);
    const e=db.prepare("SELECT * FROM operator_executors WHERE executor_ref=?").get(input.executorRef);
    if(!e)throw new SideraError("not_found","Executor not found");
    const prior=db.prepare("SELECT assignment_id FROM task_executor_assignments WHERE task_ref=? AND executor_ref=?").get(input.taskRef,input.executorRef);
    if(prior)return {assignmentRef:String(prior.assignment_id),executorRef:input.executorRef};
    const projectRef=db.prepare("SELECT project_ref FROM task_rule_context WHERE task_id=?").get(input.taskRef)?.project_ref;
    const project=projectRef?currentRules(db,"Project",String(projectRef)):null,taskRules=currentRules(db,"Task",input.taskRef);
    const count=Number(db.prepare("SELECT count(*) n FROM task_executor_assignments WHERE task_ref=? AND state='assigned'").get(input.taskRef)!.n);
    const applicable=[currentRules(db,"World",recordWorld(db,"tasks",input.taskRef)),project,taskRules].filter(x=>x!==null);
    const max=Math.min(...applicable.map(r=>r.boundary.maxExecutors??Infinity));
    const multiple=project?.policy.multipleExecutorsPerTask===true&&taskRules?.policy.multipleExecutorsPerTask!==false;
    if(count>=max||count>0&&!multiple)throw new SideraError("denied","Applicable Project/Task Rules do not admit another Executor assignment");
    const permit=reserveCapability(db,{subjectNodeId:caller.nodeId,sessionId:caller.sessionId,requestId:input.requestId,
      capability:"task.dispatch",resource:`node/${e.operator_node_ref}`,taskId:input.taskRef,projectRef:projectRef?String(projectRef):undefined});
    const result=assignExecutor(db,{taskRef:input.taskRef,executorRef:input.executorRef,allowMultiple:multiple});
    if(permit.reservationId)settleReservation(db,permit.reservationId,"consumed");return result;
  });
}

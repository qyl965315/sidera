import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { appendHistory, currentOmega, readHistory, type HistoryRecord } from "./history.ts";
import { BASIC_RULES_VERSION } from "./constitution.ts";
import { SideraError } from "./types.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { canonical } from "./human-admission.ts";
import { completedMachineReview, currentRules, getRuleVersion, ruleVersionCurrent } from "./rules.ts";

function recordParticipants(r:HistoryRecord):string[] {
  const nodes=new Set<string>();if(r.nodeRef)nodes.add(r.nodeRef);
  if(r.source.startsWith("node:"))nodes.add(r.source.slice(5));
  const payload=r.payload as Record<string,unknown>|null;
  // Typed protocol provenance only; arbitrary Claim content never assigns another subject's responsibility.
  if(payload&&typeof payload==="object"&&r.kind!=="Claim") {
    for(const key of ["actorNodeRef","reviewerNodeRef","parentNodeRef","childNodeRef","requesterNodeRef"])
      if(typeof payload[key]==="string")nodes.add(payload[key] as string);
    if(typeof payload.issuer==="string"&&payload.issuer.startsWith("node:"))nodes.add(payload.issuer.slice(5));
  }
  if(r.kind!=="Claim")for(const d of r.deltaOmega??[]) {
    const value=d.nextValue as Record<string,unknown>|null;
    if(value&&typeof value==="object")for(const key of ["origin_node_id","center_node_id","owner_node_id","subject_node_id","operator_node_ref","communicator_node_ref"])
      if(typeof value[key]==="string")nodes.add(value[key] as string);
  }
  return [...nodes];
}

/** R = history + current Omega + applicable versioned rules. No mutable reputation ledger. */
export function deriveResponsibility(db:DatabaseSync,query:{worldRef:string;nodeRef?:string;projectRef?:string}) {
  const history=readHistory(db,{worldRef:query.worldRef});
  const byId=new Map(history.map(r=>[r.id,r]));
  const traces=(r:HistoryRecord,nodeRef:string,visited=new Set<string>()):boolean=>{
    if(visited.has(r.id))return false;visited.add(r.id);
    return recordParticipants(r).includes(nodeRef)||r.parentRecords.some(id=>{const parent=byId.get(id);return parent?traces(parent,nodeRef,visited):false;});
  };
  const selected=history.filter(r=>(!query.nodeRef||traces(r,query.nodeRef))&&
    (!query.projectRef||r.projectRef===query.projectRef));
  const records=selected.map(r=>({recordId:r.id,sequence:r.sequence,kind:r.kind,nodeRef:r.nodeRef??null,taskRef:r.taskRef??null,
    source:r.source,parentRecords:r.parentRecords,rulesVersions:r.rulesVersions,participants:recordParticipants(r),participation:participation(r)}));
  const project=query.projectRef?currentRules(db,"Project",query.projectRef):null;
  return {derived:true,records,currentState:currentOmega(db,query.worldRef),rulesAtActionPreserved:true,
    applicableProjectRules:project?.worldId===query.worldRef?project:null};
}
function participation(r:HistoryRecord):string {
  return r.kind==="Review"?"review":r.kind==="Grant"||r.kind==="Revoke"?"authorization":r.kind==="Action"?"request/action":
    r.kind==="Effect"?"recognized execution consequence":r.kind==="Fork"?"lineage":r.kind==="HumanDecision"?"institutional decision":"attributed expression";
}
export interface ConsequenceInput { requestId:string;projectRef:string;ruleVersionId:string;ruleName:string;subjectNodeRef:string;sourceRecords:string[];reviewTaskId:string }
/** A review approves this exact application, not merely any prior completed Task. */
export function consequenceReviewObject(input:Omit<ConsequenceInput,"reviewTaskId">) {
  for(const key of ["requestId","projectRef","ruleVersionId","ruleName","subjectNodeRef"] as const)
    if(typeof input[key]!=="string"||!input[key].trim())throw new SideraError("conflict",`Consequence ${key} required`);
  if(!Array.isArray(input.sourceRecords)||!input.sourceRecords.length||input.sourceRecords.some(r=>typeof r!=="string"||!r.trim())||new Set(input.sourceRecords).size!==input.sourceRecords.length)
    throw new SideraError("conflict","Unique Responsibility source records required");
  const object={requestId:input.requestId,projectRef:input.projectRef,ruleVersionId:input.ruleVersionId,
    ruleName:input.ruleName,subjectNodeRef:input.subjectNodeRef,sourceRecords:[...input.sourceRecords]};
  return {object,objectHash:createHash("sha256").update(canonical(object)).digest("hex")};
}
export function consequenceReviewMarker(input:Omit<ConsequenceInput,"reviewTaskId">):string {
  return `SIDERA_CONSEQUENCE_REVIEW_V1\n${canonical(consequenceReviewObject(input))}`;
}
/** Enforce a named adopted Project rule. The rule supplies its consequence, not Basic Rules. */
export function applyConsequence(db:DatabaseSync,actorNodeRef:string,input:ConsequenceInput) {
  const reviewObject=consequenceReviewObject(input);
  const worldRef=recordWorld(db,"nodes",actorNodeRef);requireWorld(db,worldRef,"nodes",input.subjectNodeRef);requireWorld(db,worldRef,"tasks",input.reviewTaskId);
  const id=`consequence:${actorNodeRef}:${input.requestId}`,history=readHistory(db,{worldRef});
  const existing=history.find(r=>r.id===id);if(existing){if(canonical(existing.payload)!==canonical(input))throw new SideraError("conflict","Consequence request reused");return existing;}
  const version=db.prepare("SELECT * FROM rule_versions WHERE version_id=?").get(input.ruleVersionId);
  if(!version||version.world_id!==worldRef||version.scope_ref!==input.projectRef||version.level!=="Project")throw new SideraError("denied","Applicable adopted Project Rules required");
  const rule=getRuleVersion(db,input.ruleVersionId);
  if(!rule||!ruleVersionCurrent(db,rule))throw new SideraError("conflict","Project/World Rules version changed");
  const policy=JSON.parse(String(version.policy_json)),spec=policy.consequences?.[input.ruleName];
  if(!spec||!["deny","allocation"].includes(spec.mode)||typeof spec.resourceScope!=="string")throw new SideraError("conflict","No applicable named consequence interface in Project Rules");
  if(!input.sourceRecords.length)throw new SideraError("conflict","Responsibility provenance required");
  const selected=input.sourceRecords.map(id=>history.find(r=>r.id===id));
  if(selected.some(r=>!r)||!selected.some(r=>recordParticipants(r!).includes(input.subjectNodeRef)))throw new SideraError("denied","Consequence must trace subject's existing acts");
  const task=db.prepare("SELECT * FROM tasks WHERE task_id=? AND origin_node_id=?").get(input.reviewTaskId,actorNodeRef);
  if(!task)throw new SideraError("denied","Consequence Review Task must originate from its requesting actor");
  const review=completedMachineReview(db,{taskId:input.reviewTaskId,reviewerNodeId:String(task.center_node_id),expectedObjectHash:reviewObject.objectHash});
  const initial=db.prepare("SELECT m.body FROM task_runs r JOIN messages m ON m.message_id=r.message_id WHERE r.run_id=?").get(review.runId);
  if(initial?.body!==consequenceReviewMarker(input))throw new SideraError("denied","Consequence Review Task lacks the exact structured application marker");
  const context=db.prepare("SELECT project_ref FROM task_rule_context WHERE task_id=?").get(input.reviewTaskId);
  if(context&&context.project_ref!==input.projectRef)throw new SideraError("denied","Consequence Review belongs to another Project");
  const target=`consequence/${input.subjectNodeRef}/${input.projectRef}/${input.ruleName}`, prior=currentOmega(db,worldRef).find(e=>e.target===target);
  if(prior?.state==="UNRESOLVED")throw new SideraError("unavailable","Consequence target requires conflict resolution");
  const at=new Date().toISOString();
  return appendHistory(db,{id,kind:"Consequence",source:`ProjectRule:${input.ruleVersionId}/${input.ruleName}`,worldRef,nodeRef:actorNodeRef,
    projectRef:input.projectRef,taskRef:input.reviewTaskId,parentRecords:input.sourceRecords,rulesVersions:{Project:input.ruleVersionId},payload:input,
    deltaOmega:[{target,baseRevision:prior?.revision??null,nextValue:{...spec,subjectNodeRef:input.subjectNodeRef,projectRef:input.projectRef,ruleVersionId:input.ruleVersionId},
      source:`review-result:${review.resultMessageId}`,causalParents:input.sourceRecords,rulesVersions:{Basic:BASIC_RULES_VERSION,Project:input.ruleVersionId},effectiveAt:at,recordedAt:at}]});
}
/** Runtime Authority consults real rule-defined restrictions. No default penalty exists. */
export function consequenceDenial(db:DatabaseSync,nodeRef:string,resource:string,capability:string,projectRef?:string):string|null {
  const matches=(v:unknown):boolean=>{
    if(!v||typeof v!=="object")return false;
    const rule=v as {mode?:string;resourceScope?:string;operations?:string[];projectRef?:string};
    const scope=rule.resourceScope??"",inScope=scope==="*"||scope===resource||scope.endsWith("/**")&&(resource===scope.slice(0,-3)||resource.startsWith(scope.slice(0,-3)+"/"));
    return rule.projectRef===projectRef&&rule.mode==="deny"&&inScope&&(!rule.operations||rule.operations.includes("*")||rule.operations.some(op=>op===capability||op.endsWith(".*")&&capability.startsWith(op.slice(0,-1))));
  };
  for(const entry of currentOmega(db,recordWorld(db,"nodes",nodeRef))){
    if(!entry.target.startsWith(`consequence/${nodeRef}/`))continue;
    if(entry.state==="UNRESOLVED"){
      if(entry.candidates.some(candidate=>matches(candidate.value)))return `Project consequence ${entry.target} is UNRESOLVED`;
      continue;
    }
    if(entry.state!=="CURRENT")continue;
    if(matches(entry.value))return `Project consequence ${entry.target}`;
  }return null;
}

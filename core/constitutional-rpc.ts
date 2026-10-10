import type { DatabaseSync } from "node:sqlite";
import type { RpcPrincipal } from "./rpc.ts";
import { appendHistory, readHistory, currentOmega, resolveHistoryConflict, conflictResolutionMarker, conflictResolutionObject, type ConflictResolutionInput } from "./history.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { SideraError } from "./types.ts";
import { BASIC_RULES_VERSION, BASIC_INVARIANTS, R1_GOVERNANCE, R1_BOOTSTRAP_GOVERNANCE } from "./constitution.ts";
import { reserveCapability, settleReservation, issueRuleGrant } from "./authority.ts";
import { proposeRules, bindRuleReview, adoptRules, listRules, getRuleProposal, reviewPolicyFor, type RuleProposalInput } from "./rules.ts";
import { canonical } from "./human-admission.ts";
import { deriveResponsibility, applyConsequence, consequenceReviewMarker, consequenceReviewObject, type ConsequenceInput } from "./consequences.ts";
import { chiefConversationRole, readNodeOntology } from "./ontology.ts";
import { executorPool, reviewExecutorPolicy, setExecutorContext, assignTaskExecutor, isExecutorRuntimeSession } from "./executors.ts";

const methods=new Set(["console.inspect","history.list","claim.publish","omega.inspect","responsibility.trace",
  "rules.list","rules.propose","rules.review","rules.review_object","rules.adopt","grant.from_rules","consequence.apply","consequence.review_object","conflict.resolve","conflict.review_object",
  "chief.conversation_role","node.ontology","executor.list","executor.review","executor.context","executor.assign"]);
export function isConstitutionalMethod(method:string):boolean{return methods.has(method);}
function text(v:unknown,name:string):string{if(typeof v!=="string"||!v.trim())throw new SideraError("conflict",`${name} required`);return v;}
function worldScope(db:DatabaseSync,caller:RpcPrincipal,p:Record<string,unknown>):string {
  if(caller.kind==="node"){const world=recordWorld(db,"nodes",caller.nodeId);if(p.worldId&&p.worldId!==world)throw new SideraError("denied","Cross-World access");return world;}
  const worlds=db.prepare("SELECT world_id FROM world_humans WHERE human_id=?").all(caller.id).map(r=>String(r.world_id));
  const world=p.worldId??(worlds.length===1?worlds[0]:null);if(typeof world!=="string"||!worlds.includes(world))throw new SideraError("denied","Exact Human World required");return world;
}
/** Finite typed boundaries. No generic History append, Delta setter, or cross-Node Sovereignty RPC. */
export function constitutionalRpc(db:DatabaseSync,caller:RpcPrincipal,method:string,p:Record<string,unknown>):unknown {
  if(caller.kind==="node") {
    const active=db.prepare("SELECT 1 FROM sessions s JOIN nodes n USING(node_id) WHERE s.session_id=? AND s.node_id=? AND s.state='active' AND n.lifecycle='active'").get(caller.sessionId,caller.nodeId);
    if(!active&&!isExecutorRuntimeSession(db,caller.nodeId,caller.sessionId))throw new SideraError("denied","Current own Conversation or admitted Executor required");
  }
  const worldRef=worldScope(db,caller,p);
  if(method==="console.inspect")return {kind:"Console",isNode:false,hasSovereignty:false,basicVersion:BASIC_RULES_VERSION,
    invariants:BASIC_INVARIANTS,governance:R1_GOVERNANCE,bootstrapGovernance:R1_BOOTSTRAP_GOVERNANCE,history:readHistory(db,{worldRef,limit:100}),omega:currentOmega(db,worldRef),
    conflicts:currentOmega(db,worldRef).filter(e=>e.state==="UNRESOLVED"),rules:listRules(db,worldRef)};
  if(method==="history.list")return readHistory(db,{worldRef,afterSequence:p.afterSequence==null?undefined:Number(p.afterSequence),limit:Math.max(1,Math.min(1000,Number(p.limit??100)))});
  if(method==="omega.inspect")return {derived:true,targets:currentOmega(db,worldRef).filter(e=>p.target==null||e.target===p.target)};
  if(method==="responsibility.trace")return deriveResponsibility(db,{worldRef,nodeRef:p.nodeRef==null?undefined:text(p.nodeRef,"nodeRef"),projectRef:p.projectRef==null?undefined:text(p.projectRef,"projectRef")});
  if(method==="rules.list")return listRules(db,worldRef);
  if(method==="rules.review_object") {const source=getRuleProposal(db,text(p.proposalId,"proposalId"));
    if(source.object.worldId!==worldRef)throw new SideraError("denied","Cross-World Rules proposal");
    // Reviewer topology is institutional policy: the applicable adopted parent
    // Rule decides, and the versioned bootstrap policy applies until one does.
    const policyRef=reviewPolicyFor(db,source.object.level,source.object.parentVersionId,source.object.governanceVersionId),policy=policyRef.policy;
    if(policy.reviewers==="Human"||policy.reviewerCount<1)
      return {...source,adoption:"Human",reviewPolicy:policy,reviewPolicySource:policyRef.source,createsTask:false};
    const chief=policy.reviewerSelection==="ChiefConversation";
    const role=chief?chiefConversationRole(db,text(source.object.projectRef,"projectRef")):null;
    if(chief&&!role)throw new SideraError("unavailable","Applicable review policy requires the exact Chief Conversation");
    const object={proposalId:source.proposalId,objectHash:source.objectHash,...(role?{bindingId:role.bindingId,conversationRef:role.conversationRef}:{})};
    return {...source,taskCommand:`SIDERA_MACHINE_REVIEW_V1\n${canonical(object)}`,reviewer:role,reviewPolicy:policy,reviewPolicySource:policyRef.source,expectedApproval:{objectHash:source.objectHash,decision:"approve"},createsTask:false};}
  if(method==="consequence.review_object") {const input=p as unknown as Omit<ConsequenceInput,"reviewTaskId">;requireWorld(db,worldRef,"nodes",text(input.subjectNodeRef,"subjectNodeRef"));return {...consequenceReviewObject(input),taskCommand:consequenceReviewMarker(input),createsTask:false};}
  if(method==="conflict.review_object") {const input=p as unknown as Omit<ConflictResolutionInput,"reviewTaskId">;
    if(!currentOmega(db,worldRef).some(e=>e.target===input.target&&e.state==="UNRESOLVED"))throw new SideraError("unavailable","No current conflict in your World");
    return {...conflictResolutionObject(input),taskCommand:conflictResolutionMarker(input),createsTask:false};}
  if(method==="rules.adopt"){
    if(p.reviewTaskIds!==undefined && (!Array.isArray(p.reviewTaskIds)||p.reviewTaskIds.some(v=>typeof v!=="string"||!v.trim())))
      throw new SideraError("conflict","reviewTaskIds must contain exact review Task IDs");
    if(p.reviewTaskId!==undefined && p.reviewTaskIds!==undefined)throw new SideraError("conflict","Choose reviewTaskId or reviewTaskIds");
    return adoptRules(db,caller,{proposalId:text(p.proposalId,"proposalId"),
      ...(p.reviewTaskId!==undefined?{reviewTaskId:text(p.reviewTaskId,"reviewTaskId")}: {}),
      ...(p.reviewTaskIds!==undefined?{reviewTaskIds:p.reviewTaskIds as string[]}: {})});
  }
  if(method==="chief.conversation_role") {const role=chiefConversationRole(db,text(p.projectRef,"projectRef"));if(role)requireWorld(db,worldRef,"nodes",role.communicatorNodeRef);return role;}
  if(method==="node.ontology"||method==="executor.list") {
    const ref=text(p.nodeRef??(caller.kind==="node"?caller.nodeId:null),"nodeRef");requireWorld(db,worldRef,"nodes",ref);
    return method==="node.ontology"?readNodeOntology(db,ref):executorPool(db,ref);
  }
  if(caller.kind!=="node")throw new SideraError("denied","Node authors this operation; Human institutional decisions use their exact admission path");
  if(method==="rules.propose")return proposeRules(db,caller.nodeId,{...p,worldId:worldRef} as unknown as RuleProposalInput);
  if(method==="rules.review")return bindRuleReview(db,caller.nodeId,{proposalId:text(p.proposalId,"proposalId"),reviewTaskId:text(p.reviewTaskId,"reviewTaskId"),...(p.reviewerConversationRef?{reviewerConversationRef:text(p.reviewerConversationRef,"reviewerConversationRef")}:{})});
  if(method==="executor.review")return reviewExecutorPolicy(db,caller,p as unknown as Parameters<typeof reviewExecutorPolicy>[2]);
  if(method==="executor.context")return setExecutorContext(db,caller,p as unknown as Parameters<typeof setExecutorContext>[2]);
  if(method==="executor.assign")return assignTaskExecutor(db,caller,{requestId:text(p.requestId,"requestId"),taskRef:text(p.taskRef,"taskRef"),executorRef:text(p.executorRef,"executorRef")});
  if(method==="grant.from_rules")return issueRuleGrant(db,caller.nodeId,{requestId:text(p.requestId,"requestId"),ruleVersionId:text(p.ruleVersionId,"ruleVersionId"),grantIndex:Number(p.grantIndex)});
  const capability=method==="claim.publish"?"self.claim.publish":method==="conflict.resolve"?"state.conflict.resolve":"responsibility.consequence",
    resource=method==="claim.publish"?`node/${caller.nodeId}`:method==="conflict.resolve"?`state/${text(p.target,"target")}`:`project/${text(p.projectRef,"projectRef")}`;
  const permit=reserveCapability(db,{subjectNodeId:caller.nodeId,sessionId:caller.sessionId,capability,resource,requestId:text(p.requestId,"requestId"),projectRef:typeof p.projectRef==="string"?p.projectRef:undefined});
  try {
    let result:unknown;
    if(method==="claim.publish")result=appendHistory(db,{id:`claim:${caller.nodeId}:${p.requestId}`,kind:"Claim",source:"node-expression",nodeRef:caller.nodeId,worldRef,
      payload:{claim:text(p.claim,"claim"),contextRef:p.contextRef??null,intentRef:p.intentRef??null},parentRecords:Array.isArray(p.parentRecords)?p.parentRecords.map(v=>text(v,"parentRecord")):[]});
    else if(method==="consequence.apply")result=applyConsequence(db,caller.nodeId,p as unknown as ConsequenceInput);
    else if(method==="conflict.resolve")result=resolveHistoryConflict(db,caller.nodeId,p as unknown as ConflictResolutionInput);
    else throw new SideraError("not_found","No constitutional mutation");
    if(permit.reservationId)settleReservation(db,permit.reservationId,"consumed");return result;
  }catch(e){if(permit.reservationId)settleReservation(db,permit.reservationId,"released");throw e;}
}

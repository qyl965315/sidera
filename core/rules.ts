import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { canonical, consumeHumanAct } from "./human-admission.ts";
import type { Principal } from "./authority.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { appendHistory, currentOmega } from "./history.ts";
import { BASIC_RULES_VERSION, R1_BOOTSTRAP_GOVERNANCE, normalizeReviewPolicy, reviewPolicyForRule,
  type RuleReviewPolicy } from "./constitution.ts";
import { chiefConversationRole, readNodeOntology } from "./ontology.ts";

export type RuleLevel="World"|"Project"|"Task";
/** Omitted dimensions are unrestricted. An empty allowed list permits none. */
export interface RuleBoundary {
  operations?:string[]; resources?:string[]; models?:string[];
  maxBudget?:number; maxExecutors?:number; maxDelegationDepth?:number;
  delegable?:boolean; validFrom?:string; expiresAt?:string;
}
export interface RuleProposalInput {
  proposalId?:string; requestId:string; worldId:string; level:RuleLevel; scopeRef:string;
  projectRef?:string; taskRef?:string; parentVersionId:string;
  boundary:RuleBoundary; policy:Record<string,unknown>; governanceVersionId?:string;
}
export interface RuleVersion {
  versionId:string; sequence:number; level:RuleLevel; scopeRef:string; worldId:string;
  projectRef:string|null; taskRef:string|null; parentVersionId:string;
  boundary:RuleBoundary; policy:Record<string,unknown>; proposalId:string; humanActId:string|null; governanceVersionId?:string;
}
function proposalObject(row:Record<string,unknown>):RuleProposalInput {
  return {requestId:String(row.request_id),worldId:String(row.world_id),level:row.level as RuleLevel,scopeRef:String(row.scope_ref),
    ...(row.project_ref!=null?{projectRef:String(row.project_ref)}:{}),...(row.task_ref!=null?{taskRef:String(row.task_ref)}:{}),
    parentVersionId:String(row.parent_version_id),boundary:JSON.parse(String(row.boundary_json)),policy:JSON.parse(String(row.policy_json)),
    ...(row.governance_version_id!=null?{governanceVersionId:String(row.governance_version_id)}:{})};
}

/** A declared review policy rides in the already-digest-bound `policy` object, so
 * it needs no schema change and is immutable with the version that declared it. */
export function validateProposalPolicy(policy:Record<string,unknown>):void {
  if(policy.reviewPolicy!==undefined)normalizeReviewPolicy(policy.reviewPolicy);
  if(policy.worldReviewPolicy!==undefined){const world=normalizeReviewPolicy(policy.worldReviewPolicy);
    if(world.reviewerSelection==="ChiefConversation")throw new SideraError("conflict","World review cannot select a Project-scoped Chief Conversation");}
}
/**
 * The policy that governs adoption of `level`. It is read from the *adopted
 * parent* version, never from the proposal itself, so a proposal can never choose
 * its own reviewer, waive independence or relax Human involvement. When no
 * adopted parent Rule declares one, the versioned R1 bootstrap governance policy
 * applies. This is institutional policy, not a Basic invariant.
 */
export function reviewPolicyFor(db:DatabaseSync,level:RuleLevel,parentVersionId:string,governanceVersionId?:string|null):{policy:RuleReviewPolicy;source:string}{
  if(level==="World"){
    const governor=governanceVersionId?getRuleVersion(db,governanceVersionId):null;
    if(governanceVersionId&&(!governor||governor.level!=="World"))throw new SideraError("denied","Exact World governance version is unavailable");
    if(governor?.policy.worldReviewPolicy!==undefined)return {policy:normalizeReviewPolicy(governor.policy.worldReviewPolicy),source:`rule:${governor.versionId}/worldReviewPolicy`};
    return {policy:R1_BOOTSTRAP_GOVERNANCE.review.World,source:R1_BOOTSTRAP_GOVERNANCE.version};
  }
  const parent=getRuleVersion(db,parentVersionId);
  if(!parent||parent.policy.reviewPolicy===undefined)
    return {policy:reviewPolicyForRule(level,null),source:R1_BOOTSTRAP_GOVERNANCE.version};
  return {policy:normalizeReviewPolicy(parent.policy.reviewPolicy),source:`rule:${parent.versionId}`};
}
/** Root revisions use the adopted World procedure pinned when proposed. Legacy null pins fail closed after a World is adopted. */
function assertWorldGovernanceCurrent(db:DatabaseSync,p:Record<string,unknown>):void {
  if(p.level!=="World")return;
  const governor=currentRules(db,"World",String(p.world_id));
  if((governor?.versionId??null)!==(p.governance_version_id??null)||governor&&governor.scopeRef!==String(p.scope_ref))
    throw new SideraError("denied","World proposal governance version is stale; propose an exact new object under the current procedure");
}
export function getRuleProposal(db:DatabaseSync,proposalId:string){
  const row=db.prepare("SELECT * FROM rule_proposals WHERE proposal_id=?").get(proposalId);
  if(!row)throw new SideraError("not_found","Rules proposal not found");
  const object=proposalObject(row),objectHash=createHash("sha256").update(canonical(object)).digest("hex");
  if(objectHash!==row.object_hash)throw new SideraError("conflict","Rules proposal source digest changed");
  return {proposalId,proposerNodeId:String(row.proposer_node_id),objectHash,object};
}
export function migrateRules(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS rule_proposals (
    proposal_id TEXT PRIMARY KEY, proposer_node_id TEXT NOT NULL REFERENCES nodes(node_id), request_id TEXT NOT NULL,
    world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), level TEXT NOT NULL CHECK(level IN ('World','Project','Task')),
    scope_ref TEXT NOT NULL, project_ref TEXT, task_ref TEXT, parent_version_id TEXT NOT NULL,
    boundary_json TEXT NOT NULL, policy_json TEXT NOT NULL, object_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(proposer_node_id,request_id));
  CREATE TABLE IF NOT EXISTS machine_rule_reviews (
    proposal_id TEXT NOT NULL REFERENCES rule_proposals(proposal_id), task_id TEXT NOT NULL REFERENCES tasks(task_id),
    reviewer_node_id TEXT NOT NULL REFERENCES nodes(node_id), session_id TEXT NOT NULL REFERENCES sessions(session_id),
    binding_id TEXT, conversation_ref TEXT, object_hash TEXT NOT NULL, PRIMARY KEY(proposal_id,task_id));
  CREATE TABLE IF NOT EXISTS rule_versions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, version_id TEXT NOT NULL UNIQUE, proposal_id TEXT NOT NULL UNIQUE REFERENCES rule_proposals(proposal_id),
    level TEXT NOT NULL, scope_ref TEXT NOT NULL, world_id TEXT NOT NULL, project_ref TEXT, task_ref TEXT,
    parent_version_id TEXT NOT NULL,boundary_json TEXT NOT NULL,policy_json TEXT NOT NULL,
    review_task_id TEXT,review_result_message_id TEXT,human_act_id TEXT,adopted_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS rule_scope_versions ON rule_versions(level,scope_ref,sequence);
  CREATE TABLE IF NOT EXISTS task_rule_context (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),project_ref TEXT NOT NULL,
    world_version_id TEXT NOT NULL,project_version_id TEXT NOT NULL,task_version_id TEXT);
  `);
  // Additive; historical objects retain their original digest and null procedure pin.
  for(const table of ["rule_proposals","rule_versions"])
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==="governance_version_id"))db.exec(`ALTER TABLE ${table} ADD COLUMN governance_version_id TEXT`);
  for(const table of ["rule_proposals","machine_rule_reviews","rule_versions","task_rule_context"])
    for(const op of ["UPDATE","DELETE"])db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${op} BEFORE ${op} ON ${table}
      BEGIN SELECT RAISE(ABORT,'Rule versions and review provenance are immutable'); END;`);
}
const operationCovers=(a:string,b:string)=>a==="*"||a===b||a.endsWith(".*")&&b.startsWith(a.slice(0,-1));
const resourceCovers=(a:string,b:string)=>a==="*"||a===b||a.endsWith("/**")&&(b===a.slice(0,-3)||b.startsWith(a.slice(0,-2)));
export function assertRuleBoundary(parent:RuleBoundary,child:RuleBoundary):void {
  const known=new Set(["operations","resources","models","maxBudget","maxExecutors","maxDelegationDepth","delegable","validFrom","expiresAt"]);
  if(!child||typeof child!=="object"||Array.isArray(child)||Object.keys(child).some(k=>!known.has(k)))throw new SideraError("conflict","Unknown constitutional boundary dimension");
  for(const key of ["operations","resources","models"] as const){
    const values=child[key];
    if(values!==undefined && (!Array.isArray(values)||values.some(v=>typeof v!=="string"||!v.trim())))throw new SideraError("conflict",`Invalid ${key} boundary`);
    const covers=key==="operations"?operationCovers:key==="resources"?resourceCovers:(a:string,b:string)=>a==="*"||a===b;
    if(parent[key]!==undefined && (values===undefined || values.some(v=>!parent[key]!.some(p=>covers(p,v)))))throw new SideraError("denied",`Lower Rules widen ${key}`);
  }
  for(const key of ["maxBudget","maxExecutors","maxDelegationDepth"] as const){
    const value=child[key];
    if(value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw new SideraError("conflict",`Invalid ${key} boundary`);
    if(parent[key]!==undefined&&(value===undefined||value>parent[key]!))throw new SideraError("denied",`Lower Rules widen ${key}`);
  }
  if(child.delegable!==undefined&&typeof child.delegable!=="boolean")throw new SideraError("conflict","Invalid delegability boundary");
  if(parent.delegable===false&&child.delegable!==false)throw new SideraError("denied","Lower Rules widen delegability");
  for(const key of ["validFrom","expiresAt"] as const)if(child[key]!==undefined&&!Number.isFinite(Date.parse(child[key]!)))throw new SideraError("conflict","Invalid Rules time boundary");
  if(parent.validFrom!==undefined&&(child.validFrom===undefined||Date.parse(child.validFrom)<Date.parse(parent.validFrom)) ||
    parent.expiresAt!==undefined&&(child.expiresAt===undefined||Date.parse(child.expiresAt)>Date.parse(parent.expiresAt)))throw new SideraError("denied","Lower Rules widen time boundary");
  if(child.validFrom&&child.expiresAt&&Date.parse(child.validFrom)>=Date.parse(child.expiresAt))throw new SideraError("conflict","Empty Rules time interval");
}
function version(row:Record<string,unknown>):RuleVersion {
  return {versionId:String(row.version_id),sequence:Number(row.sequence),level:row.level as RuleLevel,scopeRef:String(row.scope_ref),worldId:String(row.world_id),
    projectRef:row.project_ref==null?null:String(row.project_ref),taskRef:row.task_ref==null?null:String(row.task_ref),parentVersionId:String(row.parent_version_id),
    boundary:JSON.parse(String(row.boundary_json)),policy:JSON.parse(String(row.policy_json)),proposalId:String(row.proposal_id),humanActId:row.human_act_id==null?null:String(row.human_act_id),
    ...(row.governance_version_id!=null?{governanceVersionId:String(row.governance_version_id)}:{})};
}
export function getRuleVersion(db:DatabaseSync,id:string):RuleVersion|null {const r=db.prepare("SELECT * FROM rule_versions WHERE version_id=?").get(id);return r?version(r):null;}
export function currentRules(db:DatabaseSync,level:RuleLevel,scopeRef:string):RuleVersion|null {
  const latest=db.prepare("SELECT * FROM rule_versions WHERE level=? AND scope_ref=? ORDER BY sequence DESC LIMIT 1").get(level,scopeRef);
  if(!latest)return null;
  const projected=currentOmega(db,String(latest.world_id)).find(e=>e.target===`rules/${latest.world_id}/${level}/${scopeRef}`);
  if(projected?.state!=="CURRENT")throw new SideraError("unavailable","Applicable Rules projection is missing or UNRESOLVED");
  const id=(projected.value as {versionId?:string}).versionId;
  const r=db.prepare("SELECT * FROM rule_versions WHERE version_id=? AND level=? AND scope_ref=?").get(id??"",level,scopeRef);
  if(!r)throw new SideraError("unavailable","Rules projection cannot resolve its immutable version");
  return version(r);
}
export function listRules(db:DatabaseSync,worldId:string):RuleVersion[]{return db.prepare("SELECT * FROM rule_versions WHERE world_id=? ORDER BY sequence").all(worldId).map(version);}
export function ruleVersionCurrent(db:DatabaseSync,rule:RuleVersion):boolean {
  if(currentRules(db,rule.level,rule.scopeRef)?.versionId!==rule.versionId)return false;
  if(rule.level==="World")return rule.parentVersionId===BASIC_RULES_VERSION;
  const parent=getRuleVersion(db,rule.parentVersionId);
  return Boolean(parent&&parent.worldId===rule.worldId&&parent.level===(rule.level==="Project"?"World":"Project")&&ruleVersionCurrent(db,parent));
}
function parentFor(db:DatabaseSync,input:RuleProposalInput):RuleBoundary {
  if(input.level==="World"){
    if(input.scopeRef!==input.worldId||input.projectRef||input.taskRef||input.parentVersionId!==BASIC_RULES_VERSION)throw new SideraError("denied","World Rules must be nested under the current Basic protocol");
    return {};
  }
  const parent=getRuleVersion(db,input.parentVersionId);
  if(!parent||parent.worldId!==input.worldId||parent.level!==(input.level==="Project"?"World":"Project")||!ruleVersionCurrent(db,parent))
    throw new SideraError("denied","Lower Rules require the current exact parent version");
  if(input.level==="Project"&&(input.scopeRef!==input.projectRef||input.taskRef)||input.level==="Task"&&(input.scopeRef!==input.taskRef||input.projectRef!==parent.scopeRef))
    throw new SideraError("denied","Rule scope does not match its parent domain");
  return parent.boundary;
}
export function proposeRules(db:DatabaseSync,actorNodeId:string,input:RuleProposalInput){
  return withTransaction(db,"rules_propose",()=>{
    requireWorld(db,input.worldId,"nodes",actorNodeId);
    if(!input.requestId?.trim()||!input.scopeRef?.trim()||!["World","Project","Task"].includes(input.level)||!input.policy||typeof input.policy!=="object"||Array.isArray(input.policy))throw new SideraError("conflict","Explicit Rules scope and object required");
    validateProposalPolicy(input.policy);
    if(input.level!=="World"&&(input.policy.worldReviewPolicy!==undefined||input.governanceVersionId!==undefined))throw new SideraError("conflict","World governance fields belong only to World Rules");
    const governanceVersionId=input.level==="World"?currentRules(db,"World",input.worldId)?.versionId:undefined;
    if(input.governanceVersionId!==undefined&&input.governanceVersionId!==governanceVersionId)throw new SideraError("denied","Caller cannot replace the current World governance version");
    const object={requestId:input.requestId,worldId:input.worldId,level:input.level,scopeRef:input.scopeRef,
      ...(input.projectRef!=null?{projectRef:input.projectRef}:{}),...(input.taskRef!=null?{taskRef:input.taskRef}:{}),
      parentVersionId:input.parentVersionId,boundary:input.boundary,policy:input.policy,...(governanceVersionId?{governanceVersionId}:{})};
    const objectHash=createHash("sha256").update(canonical(object)).digest("hex");
    if(db.prepare("SELECT 1 FROM rule_proposals WHERE level=? AND scope_ref=? AND world_id<>?").get(input.level,input.scopeRef,input.worldId))throw new SideraError("denied","Stable Rule scope identity is already bound to another World");
    const prior=db.prepare("SELECT proposal_id,object_hash FROM rule_proposals WHERE proposer_node_id=? AND request_id=?").get(actorNodeId,input.requestId);
    if(prior){if(prior.object_hash!==objectHash)throw new SideraError("conflict","Rule proposal request was reused");return {proposalId:String(prior.proposal_id),objectHash};}
    assertRuleBoundary(parentFor(db,input),input.boundary);
    if(input.level==="Task"){
      requireWorld(db,input.worldId,"tasks",input.taskRef!);
      if(db.prepare("SELECT origin_node_id FROM tasks WHERE task_id=?").get(input.taskRef!)?.origin_node_id!==actorNodeId)throw new SideraError("denied","Task Rules must be proposed by the issuing Node");
    }
    const proposalId=input.proposalId??randomUUID();
    db.prepare(`INSERT INTO rule_proposals(proposal_id,proposer_node_id,request_id,world_id,level,scope_ref,project_ref,task_ref,parent_version_id,boundary_json,policy_json,object_hash,created_at,governance_version_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(proposalId,actorNodeId,input.requestId,input.worldId,input.level,input.scopeRef,input.projectRef??null,input.taskRef??null,input.parentVersionId,canonical(input.boundary),canonical(input.policy),objectHash,new Date().toISOString(),governanceVersionId??null);
    appendHistory(db,{kind:"Claim",source:`node:${actorNodeId}`,nodeRef:actorNodeId,worldRef:input.worldId,projectRef:input.projectRef,taskRef:input.taskRef,
      payload:{type:"RuleProposal",proposalId,objectHash,level:input.level,scopeRef:input.scopeRef,parentVersionId:input.parentVersionId,boundary:input.boundary,policy:input.policy,...(governanceVersionId?{governanceVersionId}:{})}});
    return {proposalId,objectHash};
  });
}

/** A real review must complete through the existing canonical Task result path. */
export function completedMachineReview(db:DatabaseSync,input:{taskId:string;reviewerNodeId:string;expectedSessionId?:string;expectedObjectHash?:string}){
  const task=db.prepare("SELECT * FROM tasks WHERE task_id=?").get(input.taskId);
  if(!task||task.state!=="completed"||task.center_node_id!==input.reviewerNodeId)throw new SideraError("denied","Machine Review requires the reviewer's completed Task");
  const row=db.prepare(`SELECT r.run_id,r.session_id,m.message_id,m.body FROM task_runs r JOIN messages m
    ON m.task_id=r.task_id AND m.request_id='result:'||r.run_id AND m.kind='result' AND m.from_node_id=?
    WHERE r.task_id=? AND r.state='completed' AND r.turn_open=0 ORDER BY r.rowid DESC LIMIT 1`).get(input.reviewerNodeId,input.taskId);
  if(!row||input.expectedSessionId&&row.session_id!==input.expectedSessionId)throw new SideraError("denied","Machine Review has no exact completed Run and canonical result");
  if(input.expectedObjectHash){
    let answer:Record<string,unknown>;try{answer=JSON.parse(String(row.body));}catch{throw new SideraError("denied","Review result must decide an exact structured object");}
    if(answer.objectHash!==input.expectedObjectHash||answer.decision!=="approve")throw new SideraError("denied","Machine Review did not approve this exact object");
  }
  return {runId:String(row.run_id),sessionId:String(row.session_id),resultMessageId:String(row.message_id),body:String(row.body)};
}
export function bindRuleReview(db:DatabaseSync,actorNodeId:string,input:{proposalId:string;reviewTaskId:string;reviewerConversationRef?:string}){
  return withTransaction(db,"rules_review_bind",()=>{
    const p=db.prepare("SELECT * FROM rule_proposals WHERE proposal_id=?").get(input.proposalId);
    if(!p||p.proposer_node_id!==actorNodeId)throw new SideraError("denied","Only the Rules proposer can request its machine review");
    assertWorldGovernanceCurrent(db,p);
    const policyRef=reviewPolicyFor(db,p.level as RuleLevel,String(p.parent_version_id),p.governance_version_id==null?null:String(p.governance_version_id));
    const policy=policyRef.policy;
    if(policy.reviewerCount<1||policy.reviewers==="Human")
      throw new SideraError("conflict","The applicable review policy requires no machine review for this level");
    requireWorld(db,String(p.world_id),"tasks",input.reviewTaskId);
    const task=db.prepare("SELECT * FROM tasks WHERE task_id=?").get(input.reviewTaskId)!;
    if(task.origin_node_id!==actorNodeId)throw new SideraError("denied","Review Task must originate from the proposal issuer");
    if(policy.reviewerSelection==="AuthorizedOperator"&&readNodeOntology(db,String(task.center_node_id)).kind!=="Operator")
      throw new SideraError("denied","The applicable review policy requires an Operator reviewer");
    const role=policy.reviewerSelection==="ChiefConversation"?chiefConversationRole(db,String(p.project_ref)):null;
    if(policy.reviewerSelection==="ChiefConversation"&&(!role||role.communicatorNodeRef!==task.center_node_id||role.conversationRef!==input.reviewerConversationRef))throw new SideraError("denied","The applicable review policy requires the exact Project Chief Conversation review");
    if((policy.independentRequired||!policy.allowSelfReview)&&task.center_node_id===String(p.proposer_node_id))
      throw new SideraError("denied","The applicable review policy forbids self-review by the proposal issuer");
    const run=db.prepare("SELECT * FROM task_runs WHERE task_id=? ORDER BY rowid LIMIT 1").get(input.reviewTaskId);
    // The immutable original command is the review binding proof, not the
    // timing of this second RPC. A fast actual review may already be completed.
    if(!run||!["running","completed"].includes(String(run.state))||!["running","completed"].includes(String(task.state)))throw new SideraError("denied","Bind an actual running or completed review Task");
    const message=db.prepare("SELECT body FROM messages WHERE message_id=?").get(String(run.message_id));
    const chiefBound=policy.reviewerSelection==="ChiefConversation"&&Boolean(role);
    const expected={proposalId:input.proposalId,objectHash:p.object_hash,...(chiefBound?{bindingId:role!.bindingId,conversationRef:role!.conversationRef}:{})};
    if(message?.body!==`SIDERA_MACHINE_REVIEW_V1\n${canonical(expected)}`)throw new SideraError("denied","Review Task must carry the exact structured proposal reference");
    const prior=db.prepare("SELECT * FROM machine_rule_reviews WHERE proposal_id=? AND task_id=?").get(p.proposal_id,input.reviewTaskId);
    if(prior){
      if(prior.reviewer_node_id!==task.center_node_id||prior.session_id!==run.session_id||prior.object_hash!==p.object_hash||prior.conversation_ref!==(chiefBound?role!.conversationRef:null))throw new SideraError("conflict","Review identity changed");
      return {proposalId:input.proposalId,reviewTaskId:input.reviewTaskId,objectHash:String(p.object_hash)};
    }
    db.prepare("INSERT INTO machine_rule_reviews VALUES (?,?,?,?,?,?,?)").run(p.proposal_id,input.reviewTaskId,task.center_node_id,run.session_id,chiefBound?role!.bindingId:null,chiefBound?role!.conversationRef:null,p.object_hash);
    appendHistory(db,{kind:"Review",source:`node:${actorNodeId}`,nodeRef:actorNodeId,worldRef:String(p.world_id),projectRef:String(p.project_ref),taskRef:input.reviewTaskId,
      payload:{phase:"requested",proposalId:input.proposalId,objectHash:p.object_hash,reviewerNodeRef:task.center_node_id,conversationRef:input.reviewerConversationRef??null,reviewPolicy:policy,reviewPolicySource:policyRef.source}});
    return {proposalId:input.proposalId,reviewTaskId:input.reviewTaskId,objectHash:String(p.object_hash)};
  });
}
export function adoptRules(db:DatabaseSync,actor:Principal,input:{proposalId:string;reviewTaskId?:string;reviewTaskIds?:string[]}):RuleVersion {
  return withTransaction(db,"rules_adopt",()=>{
    const p=db.prepare("SELECT * FROM rule_proposals WHERE proposal_id=?").get(input.proposalId);
    if(!p)throw new SideraError("not_found","Rules proposal not found");
    getRuleProposal(db,input.proposalId);
    if(actor.kind==="node")requireWorld(db,String(p.world_id),"nodes",actor.nodeId);
    const level=p.level as RuleLevel,worldId=String(p.world_id);
    const previous=db.prepare("SELECT * FROM rule_versions WHERE proposal_id=?").get(input.proposalId);
    if(previous){
      if(actor.kind==="node"&&(actor.nodeId!==String(p.proposer_node_id)||previous.human_act_id!=null))throw new SideraError("denied","Existing adoption receipt belongs to its exact original actor");
      if(actor.kind==="human"&&!db.prepare("SELECT 1 FROM human_semantic_acts WHERE act_id=? AND human_id=?").get(String(previous.human_act_id),actor.id))throw new SideraError("denied","Adopted Rule belongs to another Human decision");
      return version(previous);
    }
    // Reviewer topology, independence, self-review and Human involvement come
    // from the applicable adopted parent Rule, never from this proposal.
    assertWorldGovernanceCurrent(db,p);
    const policyRef=reviewPolicyFor(db,level,String(p.parent_version_id),p.governance_version_id==null?null:String(p.governance_version_id)),policy=policyRef.policy;
    if(level==="World"&&actor.kind==="node"&&p.governance_version_id!=null){const governor=getRuleVersion(db,String(p.governance_version_id))!;
      assertRuleBoundary(governor.boundary,JSON.parse(String(p.boundary_json)));}
    const machineRequired=policy.reviewers!=="Human",humanRequired=policy.humanInvolvement==="required";
    if(humanRequired&&actor.kind!=="human")
      throw new SideraError("denied",`The applicable review policy (${policyRef.source}) requires an exact Human decision`);
    if(!humanRequired&&actor.kind==="human"&&policy.humanInvolvement==="none")
      throw new SideraError("denied","The applicable review policy has no Human involvement for this level");
    if(actor.kind==="node"&&actor.nodeId!==String(p.proposer_node_id))
      throw new SideraError("denied","Node adoption under this review policy belongs to the issuing Node");
    const proposal=proposalObject(p);
    assertRuleBoundary(parentFor(db,proposal),proposal.boundary);
    let humanActId:string|null=null,resultMessageId:string|null=null,reviewTaskRef:string|null=null;
    if(actor.kind==="human"&&policy.humanInvolvement!=="none")
      humanActId=consumeHumanAct(db,actor,worldId,"rules.adopt",input.proposalId,`rules/${level}/${p.scope_ref}`,input);
    if(machineRequired){
      const ids=input.reviewTaskIds??(input.reviewTaskId?[input.reviewTaskId]:[]);
      if(ids.length<policy.reviewerCount)
        throw new SideraError("denied",`The applicable review policy requires ${policy.reviewerCount} distinct completed machine review(s)`);
      if(new Set(ids).size!==ids.length)throw new SideraError("conflict","Machine review Task IDs must be distinct");
      const selected=ids,reviewers=new Set<string>(),messages:string[]=[];
      for(const taskId of selected){
        const review=db.prepare("SELECT * FROM machine_rule_reviews WHERE proposal_id=? AND task_id=?").get(p.proposal_id,taskId);
        if(!review)throw new SideraError("denied","Machine Review Task binding is missing");
        if(policy.reviewerSelection==="ChiefConversation"){
          const role=chiefConversationRole(db,String(p.project_ref));
          if(!role||role.bindingId!==review.binding_id||role.conversationRef!==review.conversation_ref||role.communicatorNodeRef!==review.reviewer_node_id)throw new SideraError("denied","Chief Conversation changed since review request");
        }
        const reviewerNode=String(review.reviewer_node_id);
        if((policy.independentRequired||!policy.allowSelfReview)&&reviewerNode===String(p.proposer_node_id))
          throw new SideraError("denied","The applicable review policy forbids self-review by the proposal issuer");
        if(reviewers.has(reviewerNode))
          throw new SideraError("denied","reviewerCount requires distinct reviewer subjects");
        if(policy.reviewerSelection==="AuthorizedOperator"&&readNodeOntology(db,reviewerNode).kind!=="Operator")
          throw new SideraError("denied","The applicable review policy requires an Operator reviewer");
        reviewers.add(reviewerNode);
        messages.push(completedMachineReview(db,{taskId:String(review.task_id),reviewerNodeId:reviewerNode,expectedSessionId:String(review.session_id),expectedObjectHash:String(p.object_hash)}).resultMessageId);
      }
      reviewTaskRef=selected.length===1?selected[0]!:JSON.stringify(selected);
      resultMessageId=messages.length===1?messages[0]!:(JSON.stringify(messages) as string);
    }
    const versionId=randomUUID(),at=new Date().toISOString();
    db.prepare(`INSERT INTO rule_versions(version_id,proposal_id,level,scope_ref,world_id,project_ref,task_ref,parent_version_id,boundary_json,policy_json,review_task_id,review_result_message_id,human_act_id,adopted_at,governance_version_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(versionId,p.proposal_id,level,p.scope_ref,worldId,p.project_ref,p.task_ref,p.parent_version_id,p.boundary_json,p.policy_json,reviewTaskRef,resultMessageId,humanActId,at,p.governance_version_id??null);
    const source=actor.kind==="human"?`human:${actor.id}`:`node:${actor.nodeId}`,target=`rules/${worldId}/${level}/${p.scope_ref}`;
    const prior=currentOmega(db,worldId).find(v=>v.target===target);
    if(prior?.state==="UNRESOLVED")throw new SideraError("conflict","Rule target requires explicit conflict resolution");
    appendHistory(db,{kind:"RuleChange",source,worldRef:worldId,
      projectRef:proposal.projectRef,taskRef:proposal.taskRef,rulesVersions:{[level]:versionId,parent:proposal.parentVersionId},
      payload:{versionId,proposalId:input.proposalId,objectHash:p.object_hash,level,scopeRef:p.scope_ref,boundary:proposal.boundary,policy:proposal.policy,reviewTaskId:reviewTaskRef,resultMessageId,humanActId,
        reviewPolicy:policy,reviewPolicySource:policyRef.source,...(p.governance_version_id!=null?{governanceVersionId:String(p.governance_version_id)}:{})},
      deltaOmega:[{target,baseRevision:prior?.revision??null,nextValue:{versionId,level,scopeRef:p.scope_ref,parentVersionId:proposal.parentVersionId,boundary:proposal.boundary,policy:proposal.policy,...(proposal.governanceVersionId?{governanceVersionId:proposal.governanceVersionId}:{})},source,
        causalParents:[],rulesVersions:{Basic:BASIC_RULES_VERSION,[level]:versionId},effectiveAt:at,recordedAt:at}]});
    return getRuleVersion(db,versionId)!;
  });
}

/** Trusted scheduler hook: Project membership is stable provenance, not caller-selected authority. */
export function bindTaskRuleContext(db:DatabaseSync,taskId:string,projectRef:string):void {
  const worldId=recordWorld(db,"tasks",taskId),project=currentRules(db,"Project",projectRef),world=currentRules(db,"World",worldId);
  const role=chiefConversationRole(db,projectRef);
  const legacy=!project&&role&&recordWorld(db,"nodes",role.communicatorNodeRef)===worldId;
  if(!legacy&&(!project||!world||project.worldId!==worldId||!ruleVersionCurrent(db,project)))throw new SideraError("denied","Task needs current adopted Project/World Rules or a preserved exact legacy Chief binding");
  const prior=db.prepare("SELECT * FROM task_rule_context WHERE task_id=?").get(taskId);
  if(prior){if(prior.project_ref!==projectRef)throw new SideraError("denied","Task Project identity is immutable");return;}
  db.prepare("INSERT INTO task_rule_context VALUES (?,?,?,?,?)").run(taskId,projectRef,world?.versionId??"legacy-unadopted",project?.versionId??"legacy-unadopted",currentRules(db,"Task",taskId)?.versionId??null);
  appendHistory(db,{kind:"Action",source:"interface:scheduler/project-binding",worldRef:worldId,projectRef,taskRef:taskId,
    rulesVersions:{...(world?{World:world.versionId}:{}),...(project?{Project:project.versionId}:{})},
    payload:{type:"TaskProjectBinding",legacyUnadopted:Boolean(legacy),projectRef,taskId,bindingId:role?.bindingId??null,authorityMinted:false}});
}

/** Existing action gates consult applicable nested boundaries; no second authority engine. */
export function rulesAllowAction(db:DatabaseSync,input:{worldId:string;projectRef?:string|null;taskId?:string|null;capability:string;resource:string;modelId?:string|null}):boolean {
  const world=currentRules(db,"World",input.worldId), project=input.projectRef?currentRules(db,"Project",input.projectRef):null,
    task=input.taskId?currentRules(db,"Task",input.taskId):null;
  if(project&&(!world||project.parentVersionId!==world.versionId)||task&&(!project||task.parentVersionId!==project.versionId))return false;
  const now=Date.now();
  return [world,project,task].filter((v):v is RuleVersion=>v!==null).every(v=>{
    const b=v.boundary;
    return (!b.operations||b.operations.some(s=>operationCovers(s,input.capability)))&&(!b.resources||b.resources.some(s=>resourceCovers(s,input.resource)))&&
      (!b.models||input.modelId!=null&&b.models.some(s=>s==="*"||s===input.modelId))&&(!b.validFrom||Date.parse(b.validFrom)<=now)&&(!b.expiresAt||Date.parse(b.expiresAt)>now);
  });
}

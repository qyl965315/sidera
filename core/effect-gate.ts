import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { effectiveHumanRoot, getGrant, reserveCapability,settleReservation, type ActionRequest } from "./authority.ts";
import { SemanticStore,taskBasis } from "./semantics.ts";
import { canonical,consumeHumanAct,type HumanActProof } from "./human-admission.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { SideraError } from "./types.ts";
import {readSessionHostCondition} from "./condition.ts";

export interface EffectControlProfile {
  id:string; version:string; control:"SideraControlled"|"ProviderCancelable"|"ProviderAutonomousNonCancelable";
  boundary:string; admission:string; businessEffects:string[]; cancellation:string|null;
  uncertainInterval:string; externalIdentityRequired:boolean;
}
export interface EffectBoundary {
  /** The thunk must synchronously initiate the irreversible IPC/fetch/write. No local await/preparation inside it. */
  cross<T>(target:{product:string;locator:string;operation:string},send:()=>T):T;
}
export interface EffectRequest {
  actionId:string;attemptId:string;actorSessionId:string;capability:string;resource:string;
  requestId:string;reservationId?:string|null;runId?:string;taskId?:string;payload:unknown;
  profile:EffectControlProfile;requestedControl?:"admission"|"post_admission_revocable";
  humanGateActId?:string;
  requiresHuman?:boolean;
  finalProduct?:string;
  finalLocator?:string;
  frontendBindingId?:string;
  targetExecutes?:boolean;
  hostResourceCreation?:boolean;
  hostResourceRecovery?:boolean;
}
export function migrateEffectGate(db:DatabaseSync):void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_accounts(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      world_id TEXT NOT NULL,identity_id TEXT,knowledge TEXT NOT NULL CHECK(knowledge IN ('bound','not_applicable')),
      FOREIGN KEY(world_id,identity_id) REFERENCES external_identities(world_id,identity_id));
    CREATE TABLE IF NOT EXISTS frontend_accounts(binding_id TEXT PRIMARY KEY REFERENCES chief_conversations(binding_id),
      world_id TEXT NOT NULL,identity_id TEXT NOT NULL,knowledge TEXT NOT NULL CHECK(knowledge='bound'),
      FOREIGN KEY(world_id,identity_id) REFERENCES external_identities(world_id,identity_id));
    CREATE TABLE IF NOT EXISTS effect_attempt_state(attempt_id TEXT PRIMARY KEY REFERENCES action_attempts(attempt_id),
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), action_id TEXT NOT NULL REFERENCES logical_actions(action_id),
      state TEXT NOT NULL CHECK(state IN ('allocated','prepared','may_have_effect','accepted','completed','uncertain','confirmed_no_effect','superseded')),
      eligible INTEGER NOT NULL, owner_token TEXT NOT NULL, evidence_ref TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_eligible_generation ON effect_attempt_state(action_id) WHERE eligible=1;
    CREATE TRIGGER IF NOT EXISTS effect_attempt_allocated AFTER INSERT ON action_attempts BEGIN
      INSERT INTO effect_attempt_state VALUES(NEW.attempt_id,NEW.world_id,NEW.action_id,'allocated',0,'no-permit',NULL); END;
    CREATE TABLE IF NOT EXISTS effect_permits(permit_id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      attempt_id TEXT NOT NULL UNIQUE REFERENCES action_attempts(attempt_id), context_json TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL,policy_epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('issued','consumed','denied')));
    CREATE TABLE IF NOT EXISTS effect_audit(event_id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      attempt_id TEXT NOT NULL REFERENCES action_attempts(attempt_id),kind TEXT NOT NULL,detail_json TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS effect_reservation_claims(reservation_id TEXT PRIMARY KEY REFERENCES grant_uses(reservation_id),
      attempt_id TEXT NOT NULL REFERENCES action_attempts(attempt_id));
    CREATE TABLE IF NOT EXISTS execution_evidence(run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id),
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),attempt_id TEXT NOT NULL REFERENCES action_attempts(attempt_id),
      owner_token TEXT NOT NULL,host_ref TEXT NOT NULL,observed_at INTEGER NOT NULL,fresh_until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS local_effect_requests(node_id TEXT NOT NULL REFERENCES nodes(node_id),request_id TEXT NOT NULL,
      action_id TEXT NOT NULL REFERENCES logical_actions(action_id),PRIMARY KEY(node_id,request_id));
    CREATE TRIGGER IF NOT EXISTS effect_audit_immutable_update BEFORE UPDATE ON effect_audit BEGIN SELECT RAISE(ABORT,'Effect evidence is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS effect_audit_immutable_delete BEFORE DELETE ON effect_audit BEGIN SELECT RAISE(ABORT,'Effect evidence is append-only'); END;
  `);
}

const owners=new WeakMap<DatabaseSync,string>();
function owner(db:DatabaseSync):string { let id=owners.get(db);if(!id){id=randomUUID();owners.set(db,id);}return id; }
function audit(db:DatabaseSync,attemptId:string,kind:string,details:unknown) {
  const world=String(db.prepare("SELECT world_id FROM action_attempts WHERE attempt_id=?").get(attemptId)!.world_id);
  const id=randomUUID();db.prepare("INSERT INTO effect_audit VALUES (?,?,?,?,?,?)").run(id,world,attemptId,kind,canonical(details),new Date().toISOString());return id;
}
function state(db:DatabaseSync,attemptId:string) { return db.prepare("SELECT * FROM effect_attempt_state WHERE attempt_id=?").get(attemptId); }
function snapshot(db:DatabaseSync,request:EffectRequest) {
  const attempt=db.prepare("SELECT * FROM action_attempts WHERE attempt_id=? AND action_id=?").get(request.attemptId,request.actionId);
  const action=db.prepare("SELECT * FROM logical_actions WHERE action_id=?").get(request.actionId);
  if(!attempt || !action || action.world_id!==attempt.world_id)throw new SideraError("denied","Exact Action/Attempt required");
  const world=String(action.world_id);
  const sourceMessage=attempt.source_message_id?db.prepare("SELECT task_id FROM messages WHERE message_id=?").get(attempt.source_message_id):undefined;
  const executionRun=request.runId?db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(request.runId):undefined;
  if(request.runId&&(!executionRun||attempt.source_message_id&&executionRun.message_id!==attempt.source_message_id))
    throw new SideraError("denied","Run must belong to the exact source Message");
  if(sourceMessage && request.taskId && sourceMessage.task_id!==request.taskId)
    throw new SideraError("denied","Effect Task differs from its canonical source Message");
  const taskId=sourceMessage?(sourceMessage.task_id?String(sourceMessage.task_id):undefined):request.taskId??(executionRun?String(executionRun.task_id):undefined);
  const executionTaskId=executionRun?String(executionRun.task_id):taskId;
  for(const ref of new Set([taskId,executionTaskId]))if(ref)requireWorld(db,world,"tasks",ref);
  const projectRef=taskId?db.prepare("SELECT project_ref FROM task_rule_context WHERE task_id=?").get(taskId)?.project_ref:undefined;
  const executionProjectRef=executionTaskId?db.prepare("SELECT project_ref FROM task_rule_context WHERE task_id=?").get(executionTaskId)?.project_ref:undefined;
  requireWorld(db,world,"sessions",request.actorSessionId);
  const session=db.prepare("SELECT * FROM sessions WHERE session_id=? AND node_id=?").get(attempt.target_session_id,action.target_node_id);
  if(session&&session.state!=="active"&&!isExecutorRuntimeSession(db,String(action.target_node_id),String(session.session_id)))throw new SideraError("denied","Exact target is not an admitted runtime context");
  if(!session || session.locator_ref!==attempt.locator_ref || session.host_kind!==attempt.host_kind)throw new SideraError("denied","Exact target Presence changed");
  const hostResourceCreation=request.hostResourceCreation===true && action.actor_node_id===action.target_node_id &&
    action.operation==="session.create" && request.capability==="self.session.create";
  if(request.hostResourceCreation && !hostResourceCreation)throw new SideraError("denied","Host resource creation is not a general health override");
  const hostResourceRecovery=request.hostResourceRecovery===true && action.actor_node_id===action.target_node_id &&
    request.actorSessionId===session.session_id && action.operation==="conversation.resume" && request.capability==="self.host.conversation.resume";
  if(request.hostResourceRecovery && !hostResourceRecovery)throw new SideraError("denied","Host recovery requires an exact self Session resume");
  if(!hostResourceCreation && !hostResourceRecovery && !readSessionHostCondition(db,String(session.session_id)).canExecute)
    throw new SideraError("unavailable","Target execution resource was lost; old permits cannot revive it");
  const account=request.profile.externalIdentityRequired?(request.frontendBindingId
    ? db.prepare("SELECT * FROM frontend_accounts WHERE binding_id=? AND world_id=?").get(request.frontendBindingId,world)
    : db.prepare("SELECT * FROM presence_accounts WHERE session_id=? AND world_id=?").get(session.session_id,world)):undefined;
  if(request.profile.externalIdentityRequired && (!account || account.knowledge!=="bound"))throw new SideraError("unavailable","Final ExternalIdentity UNKNOWN; explicit Host binding required");
  const identity=account?.identity_id?db.prepare("SELECT * FROM external_identities WHERE identity_id=? AND world_id=? AND state='active'").get(account.identity_id,world):null;
  if(account?.identity_id && !identity)throw new SideraError("unavailable","Final ExternalIdentity unavailable");
  let basis:unknown={kind:"standalone",semanticRef:action.semantic_ref};
  if(request.runId) {
    const run=executionRun;
    if(!run || run.session_id!==session.session_id)throw new SideraError("denied","Run/Presence mismatch");
    const observed=new SemanticStore(db,world).runBasis(request.runId);
    if(observed.currency!=="CURRENT")throw new SideraError("denied","Effect requires a known current Responsibility/Intent basis; reobserve or explicitly establish legacy basis");
    basis={kind:"run",runId:request.runId,...observed};
  } else if(taskId) {
    const observed=taskBasis(db,taskId),store=new SemanticStore(db,world);
    if(!observed)throw new SideraError("denied","Task Effect requires a known Responsibility/Intent basis");
    const revision=store.revision(observed.intentRevisionId),current=store.currentIntent(String(revision.intent_id));
    if(current.state!=="CURRENT" || current.candidates[0]?.revision_id!==observed.intentRevisionId)
      throw new SideraError("denied","Task Effect Intent basis is stale or conflicted");
    basis={kind:"task",taskId,...observed};
  }
  let product=request.finalProduct??String(session.host_kind),locator=request.finalLocator??String(session.locator_ref),frontend:unknown=null;
  if(request.frontendBindingId) {
    const binding=db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND chief_node_id=?").get(request.frontendBindingId,action.target_node_id);
    const pinned=taskId?db.prepare("SELECT binding_id FROM chief_task_routes WHERE task_id=?").get(taskId):undefined;
    if(!binding || (binding.state!=="active" && pinned?.binding_id!==request.frontendBindingId))throw new SideraError("denied","Exact active or task-pinned frontend binding missing");
    // Account proof must belong to this exact frontend, never its Runtime Session.
    product=String(binding.frontend_kind);locator=String(binding.conversation_ref);frontend={...binding};
  }
  const policy=db.prepare("SELECT requires_human FROM effect_policy WHERE world_id=? AND product=? AND capability=?").get(world,product,request.capability);
  return {worldId:world,actorNodeId:String(action.actor_node_id),actorSessionId:request.actorSessionId,targetNodeId:String(action.target_node_id),targetExecutes:Boolean(request.targetExecutes),
    actionId:request.actionId,attemptId:request.attemptId,generation:Number(attempt.generation),fenceToken:String(attempt.fence_token),
    product,targetSessionId:String(session.session_id),locator,sessionLocator:String(session.locator_ref),hytheId:String(session.hythe_id),frontend,
    externalIdentity:account?.identity_id??null,identityContext:identity,identityKnowledge:account?.knowledge??(request.profile.externalIdentityRequired?"UNKNOWN":"not_applicable"),
    operation:String(action.operation),capability:request.capability,resource:request.resource,basis,hostResourceCreation,hostResourceRecovery,
    taskId,projectRef:projectRef?String(projectRef):undefined,executionTaskId,executionProjectRef:executionProjectRef?String(executionProjectRef):undefined,
    payloadDigest:createHash("sha256").update(canonical(request.payload)).digest("hex"),profile:request.profile,
    requestedControl:request.requestedControl??"admission",requiresHuman:Boolean(policy?.requires_human || request.requiresHuman),humanGateActId:request.humanGateActId??null};
}

/** Initial frontend account binding uses the same explicit Human admission as a Runtime Presence. */
export function bindFrontendAccount(db:DatabaseSync,proof:HumanActProof,input:{worldId:string;bindingId:string;identityId:string}) {
  return withTransaction(db,"frontend_account_bind",()=>{
    const binding=db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND state='active'").get(input.bindingId);
    const identity=db.prepare("SELECT * FROM external_identities WHERE identity_id=? AND world_id=? AND state='active'").get(input.identityId,input.worldId);
    if(!binding || recordWorld(db,"nodes",String(binding.chief_node_id))!==input.worldId || !identity || identity.human_id!==proof.id)
      throw new SideraError("denied","Exact Human-owned frontend identity/binding required");
    consumeHumanAct(db,proof,input.worldId,"presence.frontend.bind",input.bindingId,`frontend/${input.bindingId}`,input);
    db.prepare("INSERT INTO frontend_accounts VALUES (?,?,?,'bound') ON CONFLICT(binding_id) DO UPDATE SET world_id=excluded.world_id,identity_id=excluded.identity_id,knowledge='bound'")
      .run(input.bindingId,input.worldId,input.identityId);
    return {bindingId:input.bindingId,identityId:input.identityId,knowledge:"bound"};
  });
}
function authorize(db:DatabaseSync,request:EffectRequest,context:ReturnType<typeof snapshot>) {
  if(context.requestedControl==="post_admission_revocable" && context.profile.control==="ProviderAutonomousNonCancelable") {
    throw new SideraError("unavailable","PROVIDER_CONTROL_LIMIT: post-admission revocation scope is infeasible");
  }
  const action:ActionRequest={subjectNodeId:context.actorNodeId,sessionId:context.actorSessionId,capability:context.capability,
    resource:context.resource,requestId:request.requestId,requireExplicitGrant:true,product:context.product,effectScope:context.requestedControl,
    taskId:context.taskId,projectRef:context.projectRef};
  let grantId:string|null=null,reservationId:string|null=null;
  if(request.reservationId) {
    const reserved=db.prepare("SELECT * FROM grant_uses WHERE reservation_id=?").get(request.reservationId);
    if(!reserved || reserved.subject_node_id!==context.actorNodeId || reserved.session_id!==context.actorSessionId || reserved.capability!==context.capability ||
      reserved.resource!==context.resource || reserved.status!=="reserved")throw new SideraError("denied","Final reservation context changed or consumed");
    action.requestId=String(reserved.request_id);
    ({grantId,reservationId}=reserveCapability(db,action));
  } else ({grantId,reservationId}=reserveCapability(db,action));
  claimReservedBudget(db,reservationId,request.attemptId);
  const grant=grantId && getGrant(db,grantId);
  if(!grant || !effectiveHumanRoot(db,grant))throw new SideraError("denied","Effect requires an explicit effective Human-rooted grant");
  const provenance=db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(grant.grantId)!;
  if(provenance.product_scope!==context.product && provenance.product_scope!=="*")throw new SideraError("denied","Product is outside standing grant");
  if(provenance.effect_scope!==context.requestedControl)throw new SideraError("denied","Effect control scope is outside standing grant");
  if(context.requiresHuman || request.humanGateActId) {
    const human=db.prepare(`SELECT * FROM human_semantic_acts WHERE act_id=? AND world_id=?
      AND act_type='effect.authorize' AND object_ref=? AND scope=?`).get(request.humanGateActId??"",context.worldId,request.actionId,context.resource);
    if(!human || human.policy_epoch!==db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(context.worldId)!.epoch ||
      human.args_json!==canonical({actionId:request.actionId,capability:request.capability,resource:request.resource,product:context.product,payloadDigest:context.payloadDigest}))
      throw new SideraError("denied","Human-gated Effect lacks exact admitted authorization");
  }
  let executor:unknown=null;
  if(context.targetExecutes) {
    const permission=reserveCapability(db,{subjectNodeId:context.targetNodeId,sessionId:context.targetSessionId,
      capability:"self.host.execute",resource:`node/${context.targetNodeId}/session/${context.targetSessionId}`,
      requestId:`executor:${request.attemptId}`,product:context.product,effectScope:context.requestedControl,
      taskId:context.executionTaskId,projectRef:context.executionProjectRef});
    claimReservedBudget(db,permission.reservationId,request.attemptId);
    const root=db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(permission.grantId!);
    if(!root || ![context.product,"*"].includes(String(root.product_scope)) || root.effect_scope!==context.requestedControl)
      throw new SideraError("denied","Selected Node lacks its own Human-rooted Host execution scope");
    executor={nodeId:context.targetNodeId,...permission,humanActId:String(root.human_act_id)};
  }
  return {grantId:grant.grantId,reservationId,humanActId:String(provenance.human_act_id),disclosureScope:String(provenance.disclosure_scope),executor};
}
function claimReservedBudget(db:DatabaseSync,reservationId:string|null,attemptId:string):void {
  if(!reservationId || db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(reservationId)?.status!=="reserved")
    throw new SideraError("denied","Effect reservation is already settled or missing");
  db.prepare("INSERT OR IGNORE INTO effect_reservation_claims VALUES (?,?)").run(reservationId,attemptId);
  if(db.prepare("SELECT attempt_id FROM effect_reservation_claims WHERE reservation_id=?").get(reservationId)!.attempt_id!==attemptId)
    throw new SideraError("denied","Effect reservation belongs to a different Attempt");
}

export function prepareEffect(db:DatabaseSync,request:EffectRequest):string {
  if(request.requestedControl==="post_admission_revocable" && request.profile.control==="ProviderAutonomousNonCancelable") {
    const context=snapshot(db,request);
    new SemanticStore(db,context.worldId).assessFeasibility(request.actionId,"false",`control-profile:${request.profile.id}:${request.profile.version}`);
    throw new SideraError("unavailable","PROVIDER_CONTROL_LIMIT: post-admission revocation scope is infeasible");
  }
  return withTransaction(db,"effect_prepare",()=>{
    const context=snapshot(db,request), old=db.prepare("SELECT * FROM effect_attempt_state WHERE action_id=? AND eligible=1").get(request.actionId);
    if(state(db,request.attemptId)?.state!=="allocated")throw new SideraError("conflict","Attempt identity already prepared or legacy; never replay it");
    if(db.prepare("SELECT 1 FROM effect_attempt_state WHERE action_id=? AND state IN ('may_have_effect','accepted','completed','uncertain')").get(request.actionId))
      throw new SideraError("uncertain","Original Attempt may have effect or already completed; ordinary retry forbidden");
    // Historical M1 attempts have no controlled-boundary evidence. Absence of an
    // M2 state row is not evidence that an earlier worker never sent.
    if(db.prepare(`SELECT 1 FROM action_attempts a WHERE a.action_id=? AND a.attempt_id!=?
      AND NOT EXISTS(SELECT 1 FROM effect_attempt_state s WHERE s.attempt_id=a.attempt_id)`).get(request.actionId,request.attemptId))
      throw new SideraError("uncertain","Legacy Attempt has UNKNOWN Effect knowledge");
    const latest=db.prepare("SELECT max(generation) generation FROM action_attempts WHERE action_id=?").get(request.actionId)!;
    if(context.generation!==latest.generation)throw new SideraError("denied","Old Attempt generation cannot become eligible");
    const provenance=authorize(db,request,context);
    if(old) {db.prepare("UPDATE effect_attempt_state SET eligible=0,state='superseded' WHERE attempt_id=?").run(old.attempt_id);audit(db,String(old.attempt_id),"generation.superseded",{by:request.attemptId});settleEffectReservations(db,String(old.attempt_id),"released");}
    db.prepare("UPDATE effect_attempt_state SET state='prepared',eligible=1,owner_token=? WHERE attempt_id=?").run(owner(db),request.attemptId);
    const id=randomUUID(), auth=db.prepare("SELECT epoch FROM authority_epochs WHERE world_id=?").get(context.worldId)!,policy=db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(context.worldId)!;
    db.prepare("INSERT INTO effect_permits VALUES (?,?,?,?,?,?,?,'issued')").run(id,context.worldId,request.attemptId,canonical({...context,provenance}),auth.epoch,policy.epoch,Date.now()+60_000);
    audit(db,request.attemptId,"permit.issued",{permitId:id,authorityEpoch:auth.epoch,policyEpoch:policy.epoch,...context,provenance});return id;
  });
}

/** May-have-effect is committed BEFORE the second, serialized validation/send.
 * The synchronous send initiation stays inside a SQLite write transaction so a
 * concurrent revocation/fence writer linearizes before or after it, never between
 * the last validation and initiation. No transaction is held across a Promise. */
export function effectBoundary(db:DatabaseSync,permitId:string,request:EffectRequest,validateAdditional?:()=>void):EffectBoundary {
  function validate() {
    const permit=db.prepare("SELECT * FROM effect_permits WHERE permit_id=? AND attempt_id=?").get(permitId,request.attemptId), current=state(db,request.attemptId);
    if(!permit || permit.state!=="issued" || Number(permit.expires_at)<=Date.now() || !current || !current.eligible || current.owner_token!==owner(db))throw new SideraError("denied","Permit is expired, consumed, fenced or belongs to a lost executor");
    if(!["prepared","may_have_effect"].includes(String(current.state)))throw new SideraError("uncertain","Attempt cannot re-enter the send boundary");
    const context=snapshot(db,request),provenance=authorize(db,request,context);
    if(permit.authority_epoch!==db.prepare("SELECT epoch FROM authority_epochs WHERE world_id=?").get(context.worldId)!.epoch ||
      permit.policy_epoch!==db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(context.worldId)!.epoch || permit.context_json!==canonical({...context,provenance}))
      throw new SideraError("denied","Permit Authority/policy/Presence/basis changed");
    const latest=db.prepare("SELECT max(generation) generation FROM action_attempts WHERE action_id=?").get(request.actionId)!;
    if(context.generation!==latest.generation)throw new SideraError("denied","Attempt generation is obsolete");
    validateAdditional?.(); // Trusted synchronous governance, before the may-have transition and again at send.
    return context;
  }
  return {cross(target,send) {
    if(db.isTransaction)throw new SideraError("denied","Effect boundary must commit outside any enclosing transaction");
    withTransaction(db,"effect_may_have",()=>{
      // Acquire SQLite write ownership before validating mutable governance.
      db.prepare("UPDATE effect_permits SET state=state WHERE permit_id=?").run(permitId);
      const c=validate();
      if(target.product!==c.product || target.locator!==c.locator || target.operation!==c.operation)throw new SideraError("denied","Boundary target differs from permit");
      if(state(db,request.attemptId)!.state!=="prepared")throw new SideraError("uncertain","May-have-effect Attempt cannot be sent again");
      db.prepare("UPDATE effect_attempt_state SET state='may_have_effect' WHERE attempt_id=?").run(request.attemptId);
      audit(db,request.attemptId,"may_have_effect",{permitId});
    });
    return withTransaction(db,"effect_final_send",()=>{
      db.prepare("UPDATE effect_permits SET state=state WHERE permit_id=?").run(permitId);validate();
      db.prepare("UPDATE effect_permits SET state='consumed' WHERE permit_id=?").run(permitId);
      audit(db,request.attemptId,"send.initiated",{permitId});
      return send();
    });
  }};
}

export function observeEffect(db:DatabaseSync,attemptId:string,knowledge:"accepted"|"completed"|"uncertain",sourceRef:string) {
  withTransaction(db,"effect_observe",()=>{
    const previous=state(db,attemptId);
    if(!previous || !["may_have_effect","accepted","uncertain"].includes(String(previous.state)))throw new SideraError("conflict","No admitted attempt to observe");
    db.prepare("UPDATE effect_attempt_state SET state=? WHERE attempt_id=?").run(knowledge,attemptId);
    audit(db,attemptId,`observation.${knowledge}`,{sourceRef});
    if(knowledge!=="uncertain")settleEffectReservations(db,attemptId,"consumed");
  });
}
/** Trusted executor/provider observation, never inferred from host acceptance alone. */
export function recordExecutionProgress(db:DatabaseSync,runId:string,attemptId:string,sourceRef:string) {
  const previous=state(db,attemptId);
  const attempt=db.prepare("SELECT * FROM action_attempts WHERE attempt_id=?").get(attemptId);
  const run=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(runId);
  if(!sourceRef || !previous?.eligible || previous.state!=="accepted" || previous.owner_token!==owner(db) ||
    !run || run.session_id!==attempt?.target_session_id || run.message_id!==attempt?.source_message_id)
    throw new SideraError("denied","Fresh exact eligible executor evidence required");
  db.prepare(`INSERT INTO execution_evidence VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET attempt_id=excluded.attempt_id,owner_token=excluded.owner_token,host_ref=excluded.host_ref,observed_at=excluded.observed_at,fresh_until=excluded.fresh_until`)
    .run(runId,previous.world_id,attemptId,owner(db),sourceRef,Date.now(),Date.now()+60_000);
  audit(db,attemptId,"execution.progress",{runId,sourceRef});
}
export function effectKnowledge(db:DatabaseSync,attemptId:string):string {
  return String(state(db,attemptId)?.state??"not_prepared");
}
/** Ownership is process-local evidence, never inherited from an old eligible row. */
export function isCurrentEffectOwner(db:DatabaseSync,attemptId:string):boolean {
  const current=state(db,attemptId);
  return Boolean(current?.eligible && current.owner_token===owner(db));
}
/** Only safe before the durable may-have transition; fences a delayed callback. */
export function abandonPreparedEffect(db:DatabaseSync,attemptId:string,reason:string):void {
  withTransaction(db,"effect_abandon",()=>{
    if(!["allocated","prepared"].includes(String(state(db,attemptId)?.state)))return;
    db.prepare("UPDATE effect_attempt_state SET state='confirmed_no_effect',eligible=0,evidence_ref=? WHERE attempt_id=?").run(reason,attemptId);
    audit(db,attemptId,"confirmed_no_effect",{sourceRef:reason,pastEffectExcluded:true,futureEffectExcluded:true,mechanism:"never crossed; local fence"});
    settleEffectReservations(db,attemptId,"released");
  });
}
function settleEffectReservations(db:DatabaseSync,attemptId:string,result:"consumed"|"released") {
  const permit=db.prepare("SELECT context_json FROM effect_permits WHERE attempt_id=?").get(attemptId);
  if(!permit)return;
  const p=JSON.parse(String(permit.context_json)).provenance;
  for(const id of new Set([p.reservationId,p.executor?.reservationId]))if(id && db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(id)?.status==="reserved")
    settleReservation(db,id,result);
}
export function recoverEffects(db:DatabaseSync) {
  owners.set(db,randomUUID());
  withTransaction(db,"effect_recover",()=>{
    const rows=db.prepare("SELECT * FROM effect_attempt_state WHERE state IN ('allocated','prepared','may_have_effect','accepted')").all();
    for(const row of rows) {
      const neverSent=row.state==="prepared" || row.state==="allocated";
      db.prepare("UPDATE effect_attempt_state SET state=?,eligible=0,evidence_ref=? WHERE attempt_id=?")
        .run(neverSent?"confirmed_no_effect":"uncertain",neverSent?"durable-prepared-only; prior owner fenced":"restart without Effect evidence",row.attempt_id);
      audit(db,String(row.attempt_id),"recovered",{knowledge:neverSent?"confirmed_no_effect":"uncertain",oldOwnerFenced:true});
      if(neverSent) {
        audit(db,String(row.attempt_id),"confirmed_no_effect",{pastEffectExcluded:true,futureEffectExcluded:true,mechanism:"durable pre-boundary state; prior owner fenced"});
        settleEffectReservations(db,String(row.attempt_id),"released");
      }
    }
  });
}

export interface NoEffectWitness {sourceRef:string;pastEffectExcluded:boolean;futureEffectExcluded:boolean;providerAttemptRef:string}
/** Only trusted integration code obtains this producer. Never an Agent RPC boolean. */
export function reconciliationProducer(db:DatabaseSync,profileId:string,verify:(attempt:Record<string,unknown>,evidence:unknown)=>NoEffectWitness|null) {
  return (attemptId:string,evidence:unknown)=>withTransaction(db,"effect_reconcile",()=>{
    const attempt=db.prepare("SELECT * FROM action_attempts WHERE attempt_id=?").get(attemptId), current=state(db,attemptId);
    const permit=db.prepare("SELECT context_json FROM effect_permits WHERE attempt_id=?").get(attemptId);
    if(!attempt || !current || !permit || JSON.parse(String(permit.context_json)).profile.id!==profileId)throw new SideraError("denied","Reconciliation profile/Attempt mismatch");
    const proof=verify(attempt,evidence);
    if(!proof?.pastEffectExcluded || !proof.futureEffectExcluded || !proof.sourceRef || proof.providerAttemptRef!==attemptId)
      throw new SideraError("uncertain","Evidence does not exclude both past and future Effect");
    if(!["may_have_effect","accepted","uncertain"].includes(String(current.state)))throw new SideraError("conflict","Attempt is not awaiting reconciliation");
    db.prepare("UPDATE effect_attempt_state SET state='confirmed_no_effect',eligible=0,evidence_ref=? WHERE attempt_id=?").run(proof.sourceRef,attemptId);
    audit(db,attemptId,"confirmed_no_effect",proof);settleEffectReservations(db,attemptId,"released");return {knowledge:"confirmed_no_effect",retryEligible:true};
  });
}
export function executionReality(db:DatabaseSync,runId:string) {
  const evidence=db.prepare(`SELECT e.*,s.state,s.eligible,r.turn_open,h.state AS health FROM execution_evidence e
    JOIN effect_attempt_state s USING(attempt_id) JOIN task_runs r USING(run_id)
    LEFT JOIN session_health h ON h.session_id=r.session_id WHERE e.run_id=?`).get(runId);
  const executing=Boolean(evidence && evidence.owner_token===owner(db) && Number(evidence.fresh_until)>Date.now() && evidence.eligible && evidence.state==="accepted" && evidence.turn_open && evidence.health!=="unavailable");
  return {state:executing?"executing":"unknown",authoritativeRunning:executing,evidence:executing?evidence:null};
}

/** A resource-loss event permanently fences paused callbacks, even after health recovers. */
export function fenceSessionEffects(db:DatabaseSync,sessionId:string,sourceRef:string):void {
  withTransaction(db,"effect_resource_fence",()=>{
    const rows=db.prepare(`SELECT s.* FROM effect_attempt_state s JOIN action_attempts a USING(attempt_id)
      WHERE a.target_session_id=? AND s.state IN ('allocated','prepared','may_have_effect','accepted','uncertain')`).all(sessionId);
    for(const row of rows) {
      const id=String(row.attempt_id);
      if(["allocated","prepared"].includes(String(row.state)))abandonPreparedEffect(db,id,sourceRef);
      else {
        db.prepare("UPDATE effect_attempt_state SET eligible=0,state='uncertain',evidence_ref=? WHERE attempt_id=?").run(sourceRef,id);
        audit(db,id,"resource.fenced",{sourceRef,pastEffectExcluded:false,futureEffectExcluded:false});
      }
    }
  });
}

export function setEffectPolicy(db:DatabaseSync,proof:HumanActProof,input:{worldId:string;product:string;capability:string;requiresHuman:boolean}) {
  return withTransaction(db,"effect_policy",()=>{
    const act=consumeHumanAct(db,proof,input.worldId,"authority.effect_policy",input.product,input.capability,input);
    db.prepare(`INSERT INTO effect_policy VALUES (?,?,?,?,?) ON CONFLICT(world_id,product,capability)
      DO UPDATE SET requires_human=excluded.requires_human,human_act_id=excluded.human_act_id`)
      .run(input.worldId,input.product,input.capability,input.requiresHuman?1:0,act);
    db.prepare("UPDATE trust_policy SET epoch=epoch+1 WHERE world_id=?").run(input.worldId);
  });
}
/** Initial account association only. Identity rebind is deliberately not M2. */
export function bindPresenceIdentity(db:DatabaseSync,proof:HumanActProof,input:{worldId:string;sessionId:string;identityId:string}) {
  return withTransaction(db,"presence_account",()=>{
    requireWorld(db,input.worldId,"sessions",input.sessionId);
    consumeHumanAct(db,proof,input.worldId,"identity.bind_presence",input.sessionId,`identity/${input.identityId}`,input);
    db.prepare("INSERT INTO presence_accounts VALUES (?,?,?,'bound')").run(input.sessionId,input.worldId,input.identityId);
  });
}
import { isExecutorRuntimeSession } from "./executors.ts";

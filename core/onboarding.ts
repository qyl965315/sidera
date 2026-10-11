import { randomUUID } from "node:crypto";
import { Registry,registryAuthority } from "./registry.ts";
import { reserveCapability } from "./authority.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Hythe } from "../hythes/types.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import {readSessionHostCondition} from "./condition.ts";
import { createHostResource } from "./session-effects.ts";
import { continueBoundHostIdentity } from "./session-presence.ts";
import { IdentityStore } from "./identity.ts";

export interface NodeHostSpec {
  nodeId:string; displayName:string; sessionId:string; locatorRef:string; hostKind:string; hytheId:string;
  model?:{provider:string;modelId:string;reasoningConfig?:Record<string,unknown>};
  options:Record<string,unknown>; coreToken:string;
  recoverLostSession?:boolean;
  recovery?:{requestId:string;approvedAt:string;state:'approved'|'attempting'|'completed'|'blocked'};
  /** A first native Session is a separate Human-reviewed provider Effect.
   * The provider chooses the resulting locator; a blocked/uncertain request is
   * deliberately never retried on a later Core start. */
  enrollment?:{requestId:string;approvedAt:string;effectRef:string;model:{provider:string;modelId:string};state:'approved'|'attempting'|'completed'|'blocked'};
}
/** Specs are Human-owned local configuration, never accepted from an Agent RPC. */
export function reconcileSpecs(db:DatabaseSync,specs:NodeHostSpec[],hythes:ReadonlyMap<string,Hythe>) {
  if (new Set(specs.map(s=>s.nodeId)).size!==specs.length || new Set(specs.map(s=>s.sessionId)).size!==specs.length)
    throw new SideraError("conflict","Node/Session specs must be unique");
  return withTransaction(db,"node_specs",()=>specs.map(spec=>{
    const hythe=hythes.get(spec.hytheId);
    if (!hythe || hythe.hostKind!==spec.hostKind || !hythe.manifest) throw new SideraError("conflict","Host spec has no canonical adapter manifest");
    const node=db.prepare("SELECT node_id,lifecycle FROM nodes WHERE node_id=?").get(spec.nodeId) as {lifecycle:string}|undefined;
    if (!node) db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(spec.nodeId,spec.displayName,new Date().toISOString());
    else if (node.lifecycle!=="active") throw new SideraError("conflict","Specs cannot reactivate a retired Node");
    const current=db.prepare("SELECT * FROM sessions WHERE node_id=? AND state='active'").get(spec.nodeId) as
      {session_id:string;hythe_id:string;host_kind:string;locator_ref:string}|undefined;
    if (current && (current.hythe_id!==spec.hytheId || current.host_kind!==spec.hostKind))
      throw new SideraError("conflict","A changed Session requires explicit authorized handoff");
    if(current){spec.sessionId=current.session_id;spec.locatorRef=current.locator_ref;}
    if (!current) {
      if (db.prepare("SELECT 1 FROM sessions WHERE session_id=? OR (hythe_id=? AND locator_ref=?)").get(spec.sessionId,spec.hytheId,spec.locatorRef))
        throw new SideraError("conflict","Existing Session cannot be silently reused");
      db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,'active',?)").run(spec.sessionId,spec.nodeId,spec.hytheId,spec.hostKind,spec.locatorRef,new Date().toISOString());
    }
    const model=db.prepare("SELECT provider,model_id FROM model_bindings WHERE node_id=? AND valid_until IS NULL").get(spec.nodeId) as
      {provider:string;model_id:string}|undefined;
    if (spec.model && model && (model.provider!==spec.model.provider || model.model_id!==spec.model.modelId))
      throw new SideraError("conflict","Model change requires model.migrate; spec cannot overwrite lineage");
    if (spec.model && !model) throw new SideraError("conflict","Bind a verified ModelBinding before activating a new configured Host");
    const manifest={...hythe.manifest(),nodeId:spec.nodeId,sessionId:spec.sessionId,availability:readSessionHostCondition(db,spec.sessionId)};
    db.prepare("INSERT INTO capability_manifests VALUES (?,?,?) ON CONFLICT(node_id) DO UPDATE SET manifest_json=excluded.manifest_json,updated_at=excluded.updated_at")
      .run(spec.nodeId,JSON.stringify(manifest),new Date().toISOString());
    return {nodeId:spec.nodeId,sessionId:spec.sessionId,hytheId:spec.hytheId};
  }));
}

/** Consume one explicitly approved native Session creation exactly once.  The
 * generic Session layer knows no provider brand: LocalSetup selects an
 * installed Host, but only the provider's stream-json init may supply the
 * locator and attest the ModelBinding. */
export async function activateApprovedEnrollments(db:DatabaseSync,specs:NodeHostSpec[],hythes:ReadonlyMap<string,Hythe>,persist:()=>void) {
 for(const node of specs.filter(n=>n.enrollment?.state==='approved')){
  const enrollment=node.enrollment!;enrollment.state='attempting';persist();
  try{
   if(!node.locatorRef.startsWith('pending-native-session:')||!enrollment.effectRef.startsWith('native-session-create:'))throw new Error('NATIVE_SESSION_CREATE_CONTEXT_CHANGED');
   const hythe=hythes.get(node.hytheId);if(!hythe?.createSession||!hythe.modelBinding)throw new Error('NATIVE_SESSION_CREATE_UNAVAILABLE');
   const locator=await createHostResource(db,hythe,{nodeId:node.nodeId,sessionId:node.sessionId,requestId:enrollment.requestId},
    boundary=>hythe.createSession!(boundary,node.locatorRef));
   if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,512}$/.test(locator)||locator.startsWith('pending-native-session:'))throw new Error('NATIVE_SESSION_CREATE_LOCATOR_INVALID');
   const observed=hythe.modelBinding(locator);
   if(!observed||observed.provider!==enrollment.model.provider||observed.modelId!==enrollment.model.modelId)throw new Error('NATIVE_ENROLLMENT_MODEL_NOT_ATTESTED');
   const binding=new IdentityStore(db).bindModel({nodeId:node.nodeId,sessionId:node.sessionId},`native-enrollment:${enrollment.requestId}`,{provider:observed.provider,modelId:observed.modelId,reasoningConfig:{effort:String(node.options.effort??'medium')}});
   db.prepare("UPDATE sessions SET locator_ref=? WHERE session_id=? AND node_id=? AND locator_ref=?").run(locator,node.sessionId,node.nodeId,node.locatorRef);
   if(db.prepare("SELECT locator_ref FROM sessions WHERE session_id=?").get(node.sessionId)?.locator_ref!==locator)throw new Error('NATIVE_SESSION_LOCATOR_PERSIST_FAILED');
   node.locatorRef=locator;node.model={provider:binding.provider,modelId:binding.modelId,reasoningConfig:binding.reasoningConfig};enrollment.state='completed';persist();
   db.prepare("INSERT INTO events VALUES (?,?,'session.enrollment_completed',?,?)").run(randomUUID(),node.nodeId,JSON.stringify({requestId:enrollment.requestId,nodeId:node.nodeId,sessionId:node.sessionId,locatorRef:locator,modelBindingId:binding.bindingId,provider:binding.provider,modelId:binding.modelId,replay:false}),new Date().toISOString());
  }catch(error){enrollment.state='blocked';persist();db.prepare("INSERT INTO events VALUES (?,?,'session.enrollment_blocked',?,?)").run(randomUUID(),node.nodeId,JSON.stringify({requestId:enrollment.requestId,nodeId:node.nodeId,sessionId:node.sessionId,code:error instanceof Error?error.message:'NATIVE_ENROLLMENT_UNAVAILABLE',replay:false}),new Date().toISOString());}
 }
}

/** A Human-owned spec may replace a proven lost runtime container; it never resumes an old Task. */
export async function activateLostSession(db:DatabaseSync,spec:NodeHostSpec,hythe:Hythe):Promise<boolean> {
 if(!spec.recoverLostSession || !hythe.canReplaceLostSession?.(spec.locatorRef) || !hythe.createSession || !hythe.modelBinding)return false;
 if(db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND turn_open=1").get(spec.sessionId))throw new SideraError("conflict","Reconcile the lost owner before replacement");
 const prior=db.prepare("SELECT request_id,state,to_session_id FROM session_activations WHERE from_session_id=?").get(spec.sessionId) as
   {request_id:string;state:string;to_session_id:string|null}|undefined;
 if(prior && prior.state!=="confirmed_no_effect")
   throw new SideraError("uncertain","Session activation already has evidence; reconcile, never repeat");
 const old=spec.sessionId,requestId=randomUUID();
 reserveCapability(db,{subjectNodeId:spec.nodeId,sessionId:old,requestId,capability:"self.session.create",resource:`node/${spec.nodeId}`});
 const activationAt=new Date().toISOString();
 if(prior){
  db.prepare("INSERT INTO events VALUES (?,?,'session.activation_retry_after_no_effect',?,?)").run(randomUUID(),spec.nodeId,
   JSON.stringify({nodeId:spec.nodeId,fromSessionId:old,priorRequestId:prior.request_id,requestId,replay:false}),activationAt);
  db.prepare("UPDATE session_activations SET request_id=?,state='intent',to_session_id=NULL,created_at=? WHERE from_session_id=?")
   .run(requestId,activationAt,old);
 }else db.prepare("INSERT INTO session_activations VALUES (?,?,'intent',NULL,?)").run(old,requestId,activationAt);
 db.prepare("INSERT INTO events VALUES (?,?,'session.activation_intent',?,?)").run(requestId,spec.nodeId,
  JSON.stringify({source:"human-owned-runtime-spec",nodeId:spec.nodeId,fromSessionId:old,replay:false}),activationAt);
 try{
  const locator=await createHostResource(db,hythe,{nodeId:spec.nodeId,sessionId:old,requestId},
    boundary=>hythe.createSession!(boundary,spec.locatorRef)),actual=hythe.modelBinding(locator);
  db.prepare("INSERT INTO events VALUES (?,?,'session.activation_host_created',?,?)").run(randomUUID(),spec.nodeId,
   JSON.stringify({requestId,nodeId:spec.nodeId,fromSessionId:old,locatorRef:locator,actualModelBinding:actual,agentTurnCompleted:false,taskCompleted:false}),new Date().toISOString());
  const expected=db.prepare("SELECT provider,model_id FROM model_bindings WHERE node_id=? AND valid_until IS NULL").get(spec.nodeId) as {provider:string;model_id:string};
  if(!actual || !expected || actual.provider!==expected.provider || actual.modelId!==expected.model_id)
   throw new SideraError("uncertain","Created Host resource needs explicit ModelBinding reconciliation; never create again");
  const registry=new Registry(db,{authorize:registryAuthority(db),getHythe:id=>id===hythe.hytheId?hythe:undefined});
  const context={actorNodeId:spec.nodeId,actorSessionId:old,resourceScope:`node/${spec.nodeId}`};
  const next=await registry.bindSession({...context,requestId:`activation-bind:${requestId}`},{nodeId:spec.nodeId,hytheId:spec.hytheId,hostKind:spec.hostKind,locatorRef:locator});
  let identityContinued=false;
  await registry.handoffSession({...context,requestId:`activation-handoff:${requestId}`},spec.nodeId,next.sessionId,old,()=>{
   identityContinued=continueBoundHostIdentity(db,{fromSessionId:old,toSessionId:next.sessionId,requestId,
     source:"human-bound Host identity on recovered Session"});
  });
  db.prepare("UPDATE session_activations SET state='ready',to_session_id=? WHERE from_session_id=?").run(next.sessionId,old);
  spec.sessionId=next.sessionId;spec.locatorRef=locator;
  db.prepare("INSERT INTO events VALUES (?,?,'session.activation_ready',?,?)").run(randomUUID(),spec.nodeId,
   JSON.stringify({requestId,nodeId:spec.nodeId,fromSessionId:old,toSessionId:next.sessionId,actualModelBinding:actual,oldTaskReplay:false,
     identityContinued}),new Date().toISOString());
  return true;
 }catch(error){
  const action=db.prepare(`SELECT action_id FROM logical_actions WHERE actor_node_id=? AND target_node_id=?
    AND operation='session.create' AND semantic_ref=? ORDER BY created_at DESC LIMIT 1`)
   .get(spec.nodeId,spec.nodeId,`session-resource:${requestId}`) as {action_id:string}|undefined;
  const effect=action?db.prepare(`SELECT e.state FROM action_attempts a LEFT JOIN effect_attempt_state e USING(attempt_id)
    WHERE a.action_id=? ORDER BY a.generation DESC LIMIT 1`).get(action.action_id) as {state:string}|undefined:undefined;
  const reconciledNoEffect=!action || effect?.state==="confirmed_no_effect";
  db.prepare("UPDATE session_activations SET state=? WHERE from_session_id=?")
   .run(reconciledNoEffect?"confirmed_no_effect":"uncertain",old);
  if(reconciledNoEffect)db.prepare("INSERT INTO events VALUES (?,?,'session.activation_confirmed_no_effect',?,?)")
   .run(randomUUID(),spec.nodeId,JSON.stringify({requestId,nodeId:spec.nodeId,fromSessionId:old,
     reason:!action?"No session.create Action was allocated":"Effect boundary confirmed no effect",replay:false}),new Date().toISOString());
  throw error;
 }
}

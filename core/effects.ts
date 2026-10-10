import type { DatabaseSync } from "node:sqlite";
import { boundaryEvent } from "./boundary.ts";
import { SideraError } from "./types.ts";
import { withTransaction } from "./db.ts";
import { consumeHumanAct } from "./human-admission.ts";
import { recordWorld } from "./worlds.ts";

export type EffectResolution="OPEN_UNCERTAIN"|"OBSERVED_COMPLETED"|"OBSERVED_NOT_APPLIED"|"SUPERSEDED"|"HUMAN_ADJUDICATED";
export interface EffectView {
 effectId:string;action:string;actorNodeId:string|null;resource:string;route:string|null;lastConfirmedStage:string;
 reason:string;evidence:unknown;state:EffectResolution;reconciliation:unknown[];safeToRetry:boolean;
 availableReconciliation:string[];taskId?:string;
}
/** One derived view of existing canonical sources; no duplicate Effect status table. */
export function uncertainEffects(db:DatabaseSync):EffectView[] {
 const effects:EffectView[]=[];
 const add=(e:Omit<EffectView,"state"|"reconciliation"|"safeToRetry"|"availableReconciliation">)=>{
  const history=db.prepare("SELECT event_id,actor_node_id,payload,created_at FROM events WHERE kind='effect.reconciled' AND json_extract(payload,'$.effectId')=? ORDER BY rowid").all(e.effectId) as {event_id:string;actor_node_id:string|null;payload:string;created_at:string}[];
  const reconciliation=history.map(row=>({...row,payload:JSON.parse(row.payload)}));
  const state:EffectResolution=reconciliation.at(-1)?.payload.state??"OPEN_UNCERTAIN";
  effects.push({...e,state,reconciliation,safeToRetry:false,
   availableReconciliation:state==="OPEN_UNCERTAIN"?["read-only Host observation","append sourced reconciliation","Human adjudication"]:[],});
 };
 const runs=db.prepare(`SELECT r.*,t.center_node_id,m.host_ref,m.state message_state,s.hythe_id,s.locator_ref,
   EXISTS(SELECT 1 FROM runtime_event_tasks et WHERE et.task_id=r.task_id) incident_observation
   FROM task_runs r JOIN tasks t USING(task_id) JOIN messages m ON m.message_id=r.message_id
   JOIN sessions s ON s.session_id=r.session_id WHERE r.state='uncertain'`).all() as Record<string,unknown>[];
 for(const r of runs) {
  const evidence=db.prepare(`SELECT event_id,kind,json_extract(payload,'$.reason') reason,created_at FROM events WHERE
   kind IN ('runtime.host_failure','runtime.execution_reconciled','runtime.resource_lost') AND
   (json_extract(payload,'$.runId')=? OR json_extract(payload,'$.taskId')=? OR json_extract(payload,'$.sessionId')=?) ORDER BY rowid DESC LIMIT 32`).all(String(r.run_id),String(r.task_id),String(r.session_id));
  add({effectId:`run:${r.run_id}`,action:"Agent execution",actorNodeId:String(r.center_node_id),taskId:String(r.task_id),resource:`session/${r.session_id}`,
   route:String(r.hythe_id),lastConfirmedStage:r.message_state==="observed"?"agent_observed":r.host_ref?"host_accepted":"intent_recorded",
   reason:"Run completion/effect not proven; closed turn is not proof of no effect",
   evidence:{runId:r.run_id,messageId:r.message_id,hostRef:r.host_ref,messageState:r.message_state,turnOpen:r.turn_open,locatorRef:r.locator_ref,incidentObservation:Boolean(r.incident_observation),events:evidence}});
 }
 const messages=db.prepare(`SELECT m.*,s.hythe_id FROM messages m JOIN sessions s ON s.session_id=m.target_session_id
   WHERE m.state='uncertain' AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.message_id=m.message_id AND r.state='uncertain')`).all() as Record<string,unknown>[];
 for(const m of messages)add({effectId:`message:${m.message_id}`,action:`message.${m.kind}`,actorNodeId:String(m.from_node_id),taskId:String(m.task_id),resource:`session/${m.target_session_id}`,
  route:String(m.hythe_id),lastConfirmedStage:m.host_ref?"host_accepted":"intent_recorded",reason:"Message effect unconfirmed",evidence:{messageId:m.message_id,hostRef:m.host_ref}});
 const presentations=db.prepare(`SELECT p.*,c.chief_node_id,c.conversation_ref FROM chief_presentations p JOIN chief_conversations c USING(binding_id)
   WHERE p.state IN ('uncertain','sending')`).all() as Record<string,unknown>[];
 for(const p of presentations) {
  const observations=db.prepare("SELECT event_id,kind,payload,created_at FROM events WHERE kind IN ('boundary.presentation_effect','HumanObserved') AND json_extract(payload,'$.messageId')=? ORDER BY rowid").all(String(p.message_id));
  const routed=observations.findLast(o=>o.kind==="boundary.presentation_effect") as {payload:string}|undefined;
  add({effectId:`presentation:${p.message_id}`,action:"conversation.send",actorNodeId:String(p.chief_node_id),resource:String(p.conversation_ref),route:routed?JSON.parse(routed.payload).route:null,
   lastConfirmedStage:p.host_ref?"host_accepted":"intent_recorded",reason:String(p.reason??"Presentation in flight or interrupted"),evidence:{bindingId:p.binding_id,hostRef:p.host_ref,events:observations}});
 }
 const controls=db.prepare(`SELECT e.* FROM events e WHERE kind='host.control.started' AND NOT EXISTS(SELECT 1 FROM events s
   WHERE s.kind='host.control.settled' AND s.actor_node_id=e.actor_node_id AND json_extract(s.payload,'$.requestId')=json_extract(e.payload,'$.requestId'))`).all() as {event_id:string;actor_node_id:string;payload:string;created_at:string}[];
 for(const c of controls){const p=JSON.parse(c.payload),request=JSON.parse(p.fingerprint);
  add({effectId:`control:${c.event_id}`,action:request.operation,actorNodeId:c.actor_node_id,resource:p.resource,route:p.locatorRef,
   lastConfirmedStage:"intent_recorded",reason:"Host control has no settled Effect",evidence:{eventId:c.event_id,requestId:p.requestId,at:c.created_at,targetSessionId:p.targetSessionId}});
 }
 return effects;
}
/** Reconciliation is an annotation over immutable provenance, never a resend/reset instruction. */
export function reconcileEffect(db:DatabaseSync,actor:{kind:"human";id:string;actId?:string}|{kind:"node";nodeId:string},input:{
 effectId:string;state:EffectResolution;reason:string;evidenceEventIds:string[];expectedRevision:number;
}) {
 return withTransaction(db,"effect_reconciliation",()=>{
  const effect=uncertainEffects(db).find(e=>e.effectId===input.effectId);
  if(!effect)throw new SideraError("not_found","Uncertain Effect not found");
  if(effect.reconciliation.length!==input.expectedRevision)throw new SideraError("conflict","Effect reconciliation changed");
  if(!input.reason.trim()||!input.evidenceEventIds.length)throw new SideraError("conflict","Sourced evidence is required");
  if(input.state==="HUMAN_ADJUDICATED"&&actor.kind!=="human")throw new SideraError("denied","Only Human may adjudicate");
  if(actor.kind==="human") {
   if(!effect.actorNodeId)throw new SideraError("denied","Effect World provenance is unknown");
   consumeHumanAct(db,actor,recordWorld(db,"nodes",effect.actorNodeId),"effect.adjudicate",input.effectId,effect.resource,input);
  }
  for(const id of input.evidenceEventIds) {
   const row=db.prepare("SELECT payload FROM events WHERE event_id=?").get(id) ?? db.prepare("SELECT detail_json FROM effect_audit WHERE event_id=?").get(id);
   if(!row)throw new SideraError("not_found","Evidence event not found");
  }
  // Completion/no-effect can only be closed by a correlated adapter observation, not an Agent claim.
  if(input.state==="OBSERVED_COMPLETED"||input.state==="OBSERVED_NOT_APPLIED") {
   const expected=input.state==="OBSERVED_COMPLETED"?"observation.completed":"confirmed_no_effect";
   const ids=effectAttemptIds(db,input.effectId);
   const proof=input.evidenceEventIds.some(id=>{
    const row=db.prepare("SELECT kind,attempt_id FROM effect_audit WHERE event_id=?").get(id);
    return row?.kind===expected && ids.includes(String(row.attempt_id));
   });
   if(!proof)throw new SideraError("denied","Correlated Host observation required; keep uncertain");
  }
  const eventId=boundaryEvent(db,actor.kind==="node"?actor.nodeId:null,"effect.reconciled",{...input,
   issuer:actor.kind==="human"?`human:${actor.id}`:actor.nodeId,originalEffectPreserved:true,replayed:false});
  return {eventId,effect:uncertainEffects(db).find(e=>e.effectId===input.effectId)};
 });
}

function effectAttemptIds(db:DatabaseSync,effectId:string):string[] {
 const kind=effectId.slice(0,effectId.indexOf(':')),id=effectId.slice(effectId.indexOf(':')+1);
 if(kind==="control") {const row=db.prepare("SELECT payload FROM events WHERE event_id=? AND kind='host.control.started'").get(id);return row?[JSON.parse(String(row.payload)).attemptId]:[];}
 const messageId=kind==="message"?id:kind==="run"?db.prepare("SELECT message_id FROM task_runs WHERE run_id=?").get(id)?.message_id:null;
 return messageId?db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=?").all(messageId).map(r=>String(r.attempt_id)):[];
}


import type { DatabaseSync } from "node:sqlite";
import { SemanticStore } from "./semantics.ts";
import { recordWorld } from "./worlds.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { prepareEffect,effectBoundary,effectKnowledge,observeEffect,abandonPreparedEffect,type EffectControlProfile } from "./effect-gate.ts";

/** Synchronous local filesystem/process admission. Exact request dedupe is
 * durable; no similarity comparison or automatic retry after an unknown result. */
export function localEffect<T>(db:DatabaseSync,input:{nodeId:string;sessionId:string;requestId:string;capability:string;resource:string;targetRef:string;payload:unknown;autonomous?:boolean},send:()=>T):T {
  const profile:EffectControlProfile={id:input.autonomous?"local-process:admission":"local-filesystem:commit",version:"m2-v1",
    control:input.autonomous?"ProviderAutonomousNonCancelable":"SideraControlled",boundary:input.autonomous?"synchronous spawn initiation":"synchronous filesystem operation",
    admission:"local runtime operation",businessEffects:[input.autonomous?"Child process can perform autonomous effects":"Named filesystem mutation"],
    cancellation:null,uncertainInterval:"operation invocation through local result recording",externalIdentityRequired:false};
  const prepared=withTransaction(db,"local_effect_intent",()=>{
    if(db.prepare("SELECT 1 FROM local_effect_requests WHERE node_id=? AND request_id=?").get(input.nodeId,input.requestId))
      throw new SideraError("uncertain","Local Effect request already exists; reconcile exact original action");
    const store=new SemanticStore(db,recordWorld(db,"nodes",input.nodeId));
    const actionId=store.logicalAction(input.nodeId,input.nodeId,input.capability,`local:${input.requestId}`),attemptId=store.attempt(actionId,input.sessionId);
    db.prepare("INSERT INTO local_effect_requests VALUES (?,?,?)").run(input.nodeId,input.requestId,actionId);
    return {actionId,attemptId};
  });
  const locator=input.targetRef;
  const request={...prepared,actorSessionId:input.sessionId,capability:input.capability,resource:input.resource,
    requestId:input.requestId,payload:input.payload,profile,finalProduct:"sidera-local",finalLocator:locator};
  try {
    const boundary=effectBoundary(db,prepareEffect(db,request),request);
    const result=boundary.cross({product:"sidera-local",locator,operation:input.capability},send);
    observeEffect(db,prepared.attemptId,input.autonomous?"accepted":"completed","synchronous local operation returned");return result;
  } catch(error) {
    if(["allocated","prepared"].includes(effectKnowledge(db,prepared.attemptId)))abandonPreparedEffect(db,prepared.attemptId,"Local boundary denied before execution");
    else if(["may_have_effect","accepted"].includes(effectKnowledge(db,prepared.attemptId)))observeEffect(db,prepared.attemptId,"uncertain","Local operation outcome not durably confirmed");
    throw error;
  }
}

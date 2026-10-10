import type { DatabaseSync } from "node:sqlite";
import type { Hythe } from "../hythes/types.ts";
import { SemanticStore } from "./semantics.ts";
import { recordWorld } from "./worlds.ts";
import { SideraError } from "./types.ts";
import { prepareEffect,effectBoundary,effectKnowledge,observeEffect,abandonPreparedEffect,type EffectBoundary } from "./effect-gate.ts";

/** Creating a runtime container is an Effect too. A profile-less legacy helper
 * must not run before the normal prompt gate. Bootstrap setup is not a grant. */
export async function createHostResource(db:DatabaseSync,hythe:Hythe,input:{nodeId:string;sessionId:string;requestId:string;runId?:string},
  invoke:(boundary:EffectBoundary)=>Promise<string>):Promise<string> {
  const profile=hythe.effectProfile?.("session.create");
  if(!profile)throw new SideraError("unavailable","LEGACY_MIGRATION_RISK: Host Session creation lacks a verified final-send profile");
  const store=new SemanticStore(db,recordWorld(db,"nodes",input.nodeId));
  const actionId=store.logicalAction(input.nodeId,input.nodeId,"session.create",`session-resource:${input.requestId}`);
  const attemptId=store.attempt(actionId,input.sessionId);
  const request={actionId,attemptId,actorSessionId:input.sessionId,capability:"self.session.create",resource:`node/${input.nodeId}`,
    requestId:input.requestId,runId:input.runId,payload:input,profile,hostResourceCreation:true};
  try {
    const permit=prepareEffect(db,request),locator=await invoke(effectBoundary(db,permit,request));
    if(!["may_have_effect","accepted"].includes(effectKnowledge(db,attemptId)))throw new SideraError("denied","Session helper did not cross final gate");
    observeEffect(db,attemptId,"accepted",`host-session:${locator}`);return locator;
  } catch(error) {
    if(["allocated","prepared"].includes(effectKnowledge(db,attemptId)))abandonPreparedEffect(db,attemptId,"Session resource boundary not crossed; callback fenced");
    else if(["may_have_effect","accepted"].includes(effectKnowledge(db,attemptId)))observeEffect(db,attemptId,"uncertain","Session resource result unavailable");
    throw error;
  }
}

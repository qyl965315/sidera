import type { DatabaseSync } from "node:sqlite";
import type { ChiefBinding, ChiefFrontend } from "../core/chief.ts";
import { boundaryEvent, observeBoundary } from "../core/boundary.ts";
import { effectAwareRoute } from "../core/control-plane.ts";
import type { CapabilityManifest, RouteClass } from "./manifest.ts";
import type { EffectBoundary, EffectControlProfile } from "../core/effect-gate.ts";
import { SideraError } from "../core/types.ts";
import { recordWorld } from "../core/worlds.ts";
import { latestFrontendPresence, recordFrontendPresence } from "../core/frontend-presence.ts";
import { invalidateFrontendRoute,latestFrontendRoute, recordFrontendRoute, selectRoute, type RouteCandidate, type RouteState } from "../core/frontend-route.ts";

export interface HumanRoute {
  id:string; routeClass:RouteClass; manifest:CapabilityManifest;
  effectProfile?():EffectControlProfile;
  supportsBinding?(binding:ChiefBinding):boolean;
  /** A declared, non-negotiable precondition for this route to be usable. */
  requirement?:string;
  requirementSatisfied?():boolean;
  invoke(operation:string,binding:ChiefBinding,input?:Record<string,unknown>,boundary?:EffectBoundary):Promise<Record<string,unknown>>;
  close?():Promise<void>;
}
function productionEligible(route:HumanRoute):boolean {
  return route.routeClass!=="ui-fallback" && (route.requirementSatisfied?.()??!route.requirement);
}
/** Same canonical IR/router; the binding is never a profile, cookie jar or runtime Session. */
export class HumanBoundary implements ChiefFrontend {
  private db:DatabaseSync; private routes:HumanRoute[]; private ingressStatus:(binding?:ChiefBinding)=>Record<string,unknown>;
  private selectedRoutes=new Map<string,string>();
  constructor(db:DatabaseSync,routes:HumanRoute[],ingress:(binding?:ChiefBinding)=>Record<string,unknown>=()=>({state:"unknown"})) {
    this.db=db;this.routes=routes;this.ingressStatus=ingress;
  }
  ingress(binding?:ChiefBinding) {return this.ingressStatus(binding);}
  effectProfile(binding?:ChiefBinding){if(!binding)return undefined;return this.routes.find(r=>r.id===this.selectedRoutes.get(binding.bindingId))?.effectProfile?.();}
  async close(){for(const route of this.routes)await route.close?.();}
  private candidates(binding:ChiefBinding,operation:string,input:Record<string,unknown>={},boundary?:EffectBoundary) {
    return this.routes.filter(r=>productionEligible(r) && r.supportsBinding?.(binding)!==false && r.manifest.operations.some(o=>o.operation===operation&&o.supported)).map(r=>({
      id:r.id,routeClass:r.routeClass,logicalLocator:binding.conversationRef,invoke:()=>r.invoke(operation,binding,input,boundary)}));
  }
  /**
   * Pure read of a previously prepared route. Safe to call from a status query:
   * it touches no browser, sends nothing, and only reflects durable evidence.
   */
  restore(binding:ChiefBinding):RouteState {
    const state=latestFrontendRoute(this.db,{worldId:recordWorld(this.db,"nodes",binding.chiefNodeId),bindingId:binding.bindingId});
    const route=this.routes.find(r=>r.id===state.routeId);
    if(state.state==="USABLE" && (!route || !productionEligible(route) || route.supportsBinding?.(binding)===false ||
      route.effectProfile?.()?.id!==state.controlProfile?.id)) state.state="STALE";
    if(state.state==="USABLE" && state.routeId)this.selectedRoutes.set(binding.bindingId,state.routeId);else this.selectedRoutes.delete(binding.bindingId);
    return state;
  }
  /**
   * Select a declared outbound route and record it. Browser-free by construction:
   * it never opens a UI, never sends, and never falls through to a ui-fallback
   * route merely because a better route was unavailable. A route is only eligible
   * if it declares support for the send AND a real control profile AND its own
   * declared requirement is satisfied.
   */
  prepare(binding:ChiefBinding):{prepared:boolean;routeId:string|null;reason:string} {
    const worldId=recordWorld(this.db,"nodes",binding.chiefNodeId);
    const presence=latestFrontendPresence(this.db,{worldId,bindingId:binding.bindingId,verifiedOnly:true});
    const active=this.db.prepare("SELECT 1 FROM chief_conversations WHERE binding_id=? AND conversation_ref=? AND state='active'").get(binding.bindingId,binding.conversationRef);
    if(!active || presence.state!=="LIVE" || presence.evidenceClass!=="ROUTE_VERIFIED") {
      this.selectedRoutes.delete(binding.bindingId);return {prepared:false,routeId:null,reason:"Exact active Chat has no fresh verified Presence"};
    }
    const candidates:RouteCandidate[]=this.routes.filter(r=>r.supportsBinding?.(binding)!==false).map(r=>({
      routeId:r.id,routeClass:r.routeClass,
      supportsSend:r.manifest.operations.some(o=>o.operation==="conversation.send"&&o.supported),
      controlProfile:r.effectProfile?.(),
      requirement:r.requirement??null,
      requirementSatisfied:r.requirementSatisfied?.()??!r.requirement}));
    const chosen=selectRoute(candidates);
    if(!chosen){
      this.selectedRoutes.delete(binding.bindingId);
      const why=candidates.filter(c=>c.supportsSend).map(c=>`${c.routeId}:${c.controlProfile?(c.requirement??"requirement unmet"):"no control profile"}`).join("; ");
      return {prepared:false,routeId:null,reason:why||"no declared route supports conversation.send"};
    }
    const evidenceRef=`${presence.evidenceRef};declared-route:${chosen.routeId}`;
    const prior=latestFrontendRoute(this.db,{worldId,bindingId:binding.bindingId});
    if(prior.state!=="USABLE" || prior.evidenceRef!==evidenceRef || prior.controlProfile?.id!==chosen.controlProfile?.id)
      recordFrontendRoute(this.db,{worldId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
      candidate:chosen,evidenceRef,
      method:"browser-free declared route preparation"});
    this.selectedRoutes.set(binding.bindingId,chosen.routeId);
    return {prepared:true,routeId:chosen.routeId,reason:"prepared"};
  }
  /** Explicit startup/recovery/Presence lifecycle, never a status side effect.
   * A failed native observation cannot launch an unobserved browser fallback. */
  async verifyPresence(binding:ChiefBinding) {
    const unavailable=(reason:string)=>{
      this.selectedRoutes.delete(binding.bindingId);
      invalidateFrontendRoute(this.db,{worldId:recordWorld(this.db,"nodes",binding.chiefNodeId),bindingId:binding.bindingId,reason});
      boundaryEvent(this.db,binding.chiefNodeId,"frontend.route_unavailable",{bindingId:binding.bindingId,conversationRef:binding.conversationRef,reason,browserLaunches:0});
      return {prepared:false,routeId:null,reason};
    };
    const candidates=this.routes.filter(r=>productionEligible(r)&&r.supportsBinding?.(binding)!==false);
    const chosen=selectRoute(candidates.map(r=>({routeId:r.id,routeClass:r.routeClass,
      supportsSend:r.manifest.operations.some(o=>o.operation==="conversation.send"&&o.supported),controlProfile:r.effectProfile?.()})));
    if(!chosen)return unavailable("No authenticated native/protocol route; browser transport is ineligible");
    const route=candidates.find(r=>r.id===chosen.routeId)!;
    try {
      const observed=await route.invoke("conversation.locate",binding);
      const data=observed.data as {located?:boolean;conversationRef?:string}|undefined;
      if(observed.status!=="host_confirmed" || data?.located!==true || data.conversationRef!==binding.conversationRef || !productionEligible(route))
        throw new Error("Exact authenticated Conversation and send capability were not confirmed");
      const worldId=recordWorld(this.db,"nodes",binding.chiefNodeId);
      recordFrontendPresence(this.db,{worldId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
        evidenceClass:"ROUTE_VERIFIED",evidenceRef:`${route.id}:authenticated-exact-locate@${new Date().toISOString()}`,
        method:"native/protocol exact conversation read"});
      return this.prepare(binding);
    } catch(error) {return unavailable(String(error));}
  }
  async inspect(binding:ChiefBinding) {
    const observation=await observeBoundary(this.db,binding.chiefNodeId,binding.conversationRef,"conversation.locate",this.candidates(binding,"conversation.locate"));
    // Observation never changes the prepared send route.
    const ready=observation.observation==="live" && this.routes.some(r=>r.id===observation.selectedRoute&&r.manifest.operations.some(o=>o.operation==="conversation.send"&&o.supported));
    return {ready,reason:ready?"Existing Human Conversation located":JSON.stringify(observation.rawRouteErrors),observation,
      routes:this.routes.map(r=>({id:r.id,manifest:r.manifest,health:r.id===observation.selectedRoute?"available":"unverified",
        errors:observation.rawRouteErrors.filter(e=>e.route===r.id)}))};
  }
  async deliver(binding:ChiefBinding,message:{messageId:string;body:string},boundary?:EffectBoundary) {
    if(!boundary)throw new SideraError("denied","Final Core Effect boundary required for Human presentation");
    const marker=`SIDERA_PRESENTATION:${binding.bindingId}:${message.messageId}`;
    const body=`${marker}\n${message.body}\n\n这是 Chief 审阅后返回本主 Chat 的 Sidera 结果。请简要呈现，不调用工具、不创建对话、不要求 Human 搬运。`;
    // A permit describes one concrete control profile. Never switch to an
    // unrelated write route after preparing it, even after preflight rejection.
    const routes=this.candidates(binding,"conversation.send",{...message,body},boundary).filter(r=>r.id===this.selectedRoutes.get(binding.bindingId));
    const routed=await effectAwareRoute("conversation.send",binding.conversationRef,routes);
    boundaryEvent(this.db,binding.chiefNodeId,"boundary.presentation_effect",{messageId:message.messageId,bindingId:binding.bindingId,
      resource:binding.conversationRef,marker,route:routed.route??null,result:routed});
    if(routed.status==="UNCERTAIN")return {status:"uncertain" as const,reason:JSON.stringify(routed),route:routed.route,humanObserved:"unknown" as const};
    if(routed.status!=="PASS")return {status:"rejected" as const,reason:JSON.stringify(routed),humanObserved:false as const};
    if(routed.effect?.status!=="accepted" && routed.effect?.status!=="host_confirmed")
      return {status:"uncertain" as const,reason:"No explicit Host acceptance",route:routed.route,humanObserved:"unknown" as const};
    // One safe read after acceptance; failed observation never causes another write.
    const observed=await this.observePresentation(binding,message.messageId,marker);
    return {status:"accepted" as const,hostRef:String(routed.effect.hostRef??message.messageId),route:routed.route,
      humanObserved:observed,agentCompleted:null};
  }
  async observePresentation(binding:ChiefBinding,messageId:string,marker=`SIDERA_PRESENTATION:${binding.bindingId}:${messageId}`) {
    const observation=await observeBoundary(this.db,binding.chiefNodeId,binding.conversationRef,"conversation.observe",this.candidates(binding,"conversation.observe"));
    const data=(observation.data as {data?:{turns?:{items?:{type:string;content?:{text?:string}[];text?:string;id?:string}[]}[]}}|null)?.data;
    // Exact marker in an actual user message, not a title/preview/assistant quotation.
    const item=data?.turns?.flatMap(t=>t.items??[]).find(i=>i.type==="userMessage"&&i.content?.some(c=>c.text?.startsWith(marker+"\n")));
    if(!item)return "unknown" as const;
    const prior=this.db.prepare("SELECT 1 FROM events WHERE kind='HumanObserved' AND json_extract(payload,'$.messageId')=?").get(messageId);
    if(!prior)boundaryEvent(this.db,binding.chiefNodeId,"HumanObserved",{messageId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
      hostMessageId:item.id,route:observation.selectedRoute,meaning:"Presentation appeared in the bound Chat; Human attention and model completion not inferred"});
    return true;
  }
}

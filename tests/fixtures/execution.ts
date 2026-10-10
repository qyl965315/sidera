import type { DatabaseSync } from "node:sqlite";
import type { Hythe } from "../../hythes/types.ts";
import type { EffectBoundary,EffectControlProfile } from "../../core/effect-gate.ts";
import { CoreRuntime as Runtime } from "../../core/runtime.ts";
import { Continuations as Scheduler } from "../../core/continuations.ts";
import { setResponsibilityBasis,type SemanticBasis } from "../../core/semantics.ts";
import { recordWorld } from "../../core/worlds.ts";
import { SemanticStore } from "./human.ts";
import { grantSelf } from "./authority.ts";
import {recordFixtureHostAvailable} from "./host-condition.ts";
export const mockProfile:EffectControlProfile={id:"fixture:controlled-send",version:"1",control:"SideraControlled",
  boundary:"synchronous mock invocation",admission:"mock counter",businessEffects:["mock counter increment"],
  cancellation:null,uncertainInterval:"mock invocation to response",externalIdentityRequired:false};
/** Adapter-only protocol tests use no live transport. Core tests use real permits. */
export const protocolTestBoundary:EffectBoundary={cross(_target,send){return send();}};
export function guardMocks(map:ReadonlyMap<string,Hythe>):ReadonlyMap<string,Hythe> {
  return new Map([...map].map(([key,h])=>[key,h.effectProfile?h:new Proxy(h,{get(target,prop){
    if(prop==="effectProfile")return ()=>mockProfile;
    if(prop==="invoke")return (locator:string,cap:string,input:unknown,id:string,boundary?:EffectBoundary)=>{
      if(!boundary)throw new Error("Mock requires Core permit");
      return boundary.cross({product:h.hostKind,locator,operation:cap},()=>h.invoke(locator,cap,input,id));
    };
    if(prop==="control" && h.control)return (locator:string,op:string,input:Record<string,unknown>,boundary?:EffectBoundary)=>
      boundary?boundary.cross({product:h.hostKind,locator,operation:op},()=>h.control!(locator,op,input)):h.control!(locator,op,input);
    if(prop==="createSession" && h.createSession)return (boundary:EffectBoundary,locator:string)=>
      boundary.cross({product:h.hostKind,locator,operation:"session.create"},()=>h.createSession!());
    if(prop==="prepareWake" && h.prepareWake)return (locator:string,boundary:EffectBoundary)=>
      boundary.cross({product:h.hostKind,locator,operation:"session.create"},()=>h.prepareWake!(locator));
    const value=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
  }})]));
}
export function fixtureBasis(db:DatabaseSync,nodeId:string):SemanticBasis {
  const world=recordWorld(db,"nodes",nodeId),store=new SemanticStore(db,world);
  const prior=db.prepare("SELECT responsibility_id,intent_revision_id FROM responsibility_bases WHERE provenance='explicit_basis_at_creation' AND responsibility_id=?").get(`fixture-basis:${nodeId}`);
  if(prior)return {responsibilityId:String(prior.responsibility_id),intentRevisionId:String(prior.intent_revision_id),contextBasis:["fixture:bounded regression"]};
  const human=store.createHuman("Regression Human","synthetic regression frontend"),intent=store.createIntent(human,"synthetic regression intent");
  const revision=store.reviseIntent(intent,null,"Perform the bounded regression operation","fixture:explicit intent");
  const responsibilityId=`fixture-basis:${nodeId}`,at=new Date().toISOString();
  // Synthetic storage fixture, deliberately proposed: creates no background wake.
  db.prepare("INSERT INTO responsibilities(responsibility_id,title,scope,owner_node_id,state,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(responsibilityId,"Bounded regression","fixture",nodeId,at,at);
  setResponsibilityBasis(db,responsibilityId,{intentRevisionId:revision,contextBasis:["fixture:bounded regression"]});
  return {responsibilityId,intentRevisionId:revision,contextBasis:["fixture:bounded regression"]};
}
function selfGrants(db:DatabaseSync) {
  for(const row of db.prepare("SELECT node_id FROM nodes").all()) {
    const node=String(row.node_id);
    grantSelf(db,node);
  }
  // Test-only synthetic exact Host evidence for active contexts. A merely
  // configured production Node never gets this evidence.
  for(const row of db.prepare("SELECT session_id FROM sessions WHERE state='active'").all()) {
    const id=String(row.session_id);
    if(!db.prepare("SELECT 1 FROM session_health WHERE session_id=?").get(id))
      recordFixtureHostAvailable(db,id);
  }
}
function configure(db:DatabaseSync,scheduler:Scheduler) {
  const submit=scheduler.submit.bind(scheduler);
  scheduler.submit=(input,parent)=>submit(parent||input.basis?input:{...input,basis:fixtureBasis(db,input.originNodeId)},parent);
}
export class Continuations extends Scheduler {
  constructor(db:DatabaseSync,hythes:ReadonlyMap<string,Hythe>) {selfGrants(db);super(db,guardMocks(hythes));configure(db,this);}
}
export class CoreRuntime extends Runtime {
  constructor(...args:ConstructorParameters<typeof Runtime>) {
    selfGrants(args[0]);super(args[0],guardMocks(args[1]),args[2],args[3]);configure(args[0],this.continuations);
  }
}

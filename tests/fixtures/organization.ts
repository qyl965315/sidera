export * from "../../core/organization.ts";
import * as real from "../../core/organization.ts";
import { humanProof } from "./human.ts";
import type { DatabaseSync } from "node:sqlite";
function wrap<F extends (db:DatabaseSync,actor:real.OrgActor,input:any)=>any>(fn:F,method:string):F {
  return ((db:DatabaseSync,actor:real.OrgActor,input:Record<string,unknown>)=>{
    if(actor.kind!=="human")return fn(db,actor,input);
    const target=real.humanOrganizationTarget(db,input);
    const proof=humanProof(db,target.worldId,actor.id,{type:method,objectRef:target.objectRef,scope:target.scope,targetRevision:null,args:input,causalRefs:["fixture:Human organization act"]});
    return fn(db,{kind:"human",...proof},input);
  }) as F;
}
export const createResponsibility=wrap(real.createResponsibility,"responsibility.create");
export const appointRole=wrap(real.appointRole,"role.appoint");
export const completeResponsibility=wrap(real.completeResponsibility,"responsibility.complete");
export const transferResponsibility=wrap(real.transferResponsibility,"responsibility.transfer");
export const deferResponsibility=wrap(real.deferResponsibility,"responsibility.defer");
export const deferEscalation=wrap(real.deferEscalation,"escalation.defer");

export * from "../../core/authority.ts";
import * as real from "../../core/authority.ts";
import { recordWorld } from "../../core/worlds.ts";
import { humanProof } from "./human.ts";
import type { DatabaseSync } from "node:sqlite";
export function grantSelf(db:DatabaseSync,node:string):void {
  issueGrant(db,{kind:"human",id:"fixture-standing-owner"},{requestId:`fixture-self:${node}`,subjectNodeId:node,capability:"self.*",resourceScope:`node/${node}/**`,productScope:"*"});
}

export const issueGrant:typeof real.issueGrant=(db,actor,input)=>{
  if(actor.kind!=="human")return real.issueGrant(db,actor,input);
  const bounded={productScope:"*",...input};
  const proof=humanProof(db,recordWorld(db,"nodes",input.subjectNodeId),actor.id,{type:"authority.grant",objectRef:input.subjectNodeId,
    scope:input.resourceScope,targetRevision:null,args:bounded,causalRefs:["fixture:Human standing grant"]});
  return real.issueGrant(db,{kind:"human",...proof},bounded);
};
export const revokeGrant:typeof real.revokeGrant=(db,actor,input)=>{
  if(actor.kind!=="human")return real.revokeGrant(db,actor,input);
  const grant=real.getGrant(db,input.grantId)!;
  const proof=humanProof(db,recordWorld(db,"nodes",grant.subjectNodeId),actor.id,{type:"authority.revoke",objectRef:input.grantId,
    scope:grant.resourceScope,targetRevision:null,args:input,causalRefs:["fixture:Human revocation"]});
  return real.revokeGrant(db,{kind:"human",...proof},input);
};
export const setAuthorityConstraint:typeof real.setAuthorityConstraint=(db,actor,input)=>{
  if(actor.kind!=="human")return real.setAuthorityConstraint(db,actor,input);
  const proof=humanProof(db,recordWorld(db,"nodes",input.subjectNodeId),actor.id,{type:"authority.constraint",objectRef:input.subjectNodeId,
    scope:input.resourceScope,targetRevision:null,args:input,causalRefs:["fixture:Human constraint"]});
  return real.setAuthorityConstraint(db,{kind:"human",...proof},input);
};

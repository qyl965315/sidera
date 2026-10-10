export * from "../../core/chief.ts";
import * as real from "../../core/chief.ts";
import { humanProof } from "./human.ts";
import { recordWorld } from "../../core/worlds.ts";
export const bindChiefConversation:typeof real.bindChiefConversation=(db,actor,input)=>{
  if(actor.kind!=="human")return real.bindChiefConversation(db,actor,input);
  const proof=humanProof(db,recordWorld(db,"nodes",input.chiefNodeId),actor.id??"fixture-human",{type:"chief.bind",objectRef:input.chiefNodeId,
    scope:input.projectSpaceId,targetRevision:null,args:input,causalRefs:["fixture:Human selected frontend"]});
  return real.bindChiefConversation(db,{kind:"human",...proof},input);
};
export const handoffChiefConversation:typeof real.handoffChiefConversation=(db,actor,input)=>{
  if(actor.kind!=="human")return real.handoffChiefConversation(db,actor,input);
  const old=db.prepare("SELECT * FROM chief_conversations WHERE binding_id=?").get(input.expectedBindingId)!;
  const proof=humanProof(db,recordWorld(db,"nodes",String(old.chief_node_id)),actor.id??"fixture-human",{type:"chief.handoff",objectRef:input.expectedBindingId,
    scope:String(old.project_space_id),targetRevision:null,args:input,causalRefs:["fixture:Human selected replacement"]});
  return real.handoffChiefConversation(db,{kind:"human",...proof},input);
};

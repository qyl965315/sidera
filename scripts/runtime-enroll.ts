/** Privileged Human operator entry, never a Node/MCP endpoint. Review first;
 * ADMIT records exact account assertions and the one diagnostic Intent. */
import { randomUUID } from "node:crypto";
import { readFileSync,writeFileSync } from "node:fs";
import { resolve,join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase,withTransaction } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { bindPresenceIdentity,bindFrontendAccount } from "../core/effect-gate.ts";
import { openHumanIngress,explicitHumanStatement,admitHumanAct,consumeHumanAct,type HumanProposal } from "../core/human-admission.ts";

export function enrollmentPlan(db:DatabaseSync,chiefNodeId:string,targetNodeId:string) {
 const world=recordWorld(db,"nodes",chiefNodeId);
 if(recordWorld(db,"nodes",targetNodeId)!==world)throw Error("Target outside World");
 const humans=db.prepare("SELECT human_id FROM world_humans WHERE world_id=?").all(world);
 if(humans.length!==1)throw Error("Exact existing Human principal required");
 const humanId=String(humans[0]!.human_id);
 const binding=db.prepare("SELECT binding_id,conversation_ref FROM chief_conversations WHERE chief_node_id=? AND state='active'").get(chiefNodeId);
 if(!binding)throw Error("Human-selected exact Chief binding required");
 const session=(id:string)=>String(db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(id)?.session_id??"");
 const sessions=[session(chiefNodeId),session(targetNodeId)];
 if(sessions.some(x=>!x))throw Error("Exact active Runtime Sessions required");
 const codexIdentity=randomUUID(),frontendIdentity=randomUUID(),intentId=randomUUID(),sourceRef=`human-runtime-enrollment:${randomUUID()}`;
 const proposals:HumanProposal[]=[];
 const proposal=(type:string,objectRef:string,scope:string,args:Record<string,unknown>)=>proposals.push({type,objectRef,scope,args,targetRevision:null,causalRefs:[sourceRef]});
 // These are Human assertions about Host-owned sign-ins, NOT discovered provider subject IDs.
 for(const [id,subjectRef] of [[codexIdentity,"human-asserted:active-Sidera-Codex-sign-in"],[frontendIdentity,`human-asserted:ChatGPT-sign-in:${binding.conversation_ref}`]])
  proposal("identity.register",humanId,`world/${world}`,{identityId:id,humanId,provider:"openai",externalSubjectRef:subjectRef,provenance:sourceRef});
 for(const sessionId of sessions)proposal("identity.bind_presence",sessionId,`identity/${codexIdentity}`,{worldId:world,sessionId,identityId:codexIdentity});
 proposal("presence.frontend.bind",String(binding.binding_id),`frontend/${binding.binding_id}`,{worldId:world,bindingId:binding.binding_id,identityId:frontendIdentity});
 proposal("intent.create",humanId,`world/${world}`,{intentId,humanId,provenance:sourceRef});
 proposal("intent.revise",intentId,`intent/${intentId}`,{intentId,parentRevisionId:null,
  content:"Prove one minimal read-only current Chief Chat → Codex → same Chief Chat nonce acknowledgement. No repository changes, delegation, retries or other work.",sourceRef});
 return {world,humanId,chiefNodeId,targetNodeId,bindingId:String(binding.binding_id),conversationRef:String(binding.conversation_ref),sessions,codexIdentity,frontendIdentity,intentId,sourceRef,proposals};
}
export function applyEnrollment(db:DatabaseSync,plan:ReturnType<typeof enrollmentPlan>,confirmation:string) {
 if(confirmation!=="ADMIT")throw Error("Explicit Human review not confirmed");
 const binding=db.prepare("SELECT conversation_ref FROM chief_conversations WHERE binding_id=? AND state='active'").get(plan.bindingId);
 if(binding?.conversation_ref!==plan.conversationRef || plan.sessions.some((id,i)=>!db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND node_id=? AND state='active'").get(id,i?plan.targetNodeId:plan.chiefNodeId)))
  throw Error("Binding/Session changed since Human review; review again");
 return withTransaction(db,"runtime_enrollment",()=>{
  const store=new SemanticStore(db,plan.world);
  const source=openHumanIngress(db,{worldId:plan.world,humanId:plan.humanId,presenceRef:`local-terminal:${process.env.COMPUTERNAME??"host"}`,sourceRef:plan.sourceRef});
  let revisionId="";
  for(const [i,p] of plan.proposals.entries()){
   const utteranceId=source.capture(`${plan.sourceRef}:${i}`,explicitHumanStatement(p));
   const proof=admitHumanAct(db,{worldId:plan.world,humanId:plan.humanId,utteranceId,proposal:p});
   const a=p.args;
   if(p.type==="identity.register"){
    consumeHumanAct(db,proof,plan.world,p.type,p.objectRef,p.scope,a);
    store.addExternalIdentity(plan.humanId,String(a.provider),String(a.externalSubjectRef),String(a.provenance),String(a.identityId));
   }else if(p.type==="identity.bind_presence")bindPresenceIdentity(db,proof,a as {worldId:string;sessionId:string;identityId:string});
   else if(p.type==="presence.frontend.bind")bindFrontendAccount(db,proof,a as {worldId:string;bindingId:string;identityId:string});
   else if(p.type==="intent.create"){
    consumeHumanAct(db,proof,plan.world,p.type,p.objectRef,p.scope,a);store.createIntent(plan.humanId,plan.sourceRef,plan.intentId);
   }else if(p.type==="intent.revise")revisionId=store.reviseIntent(plan.intentId,null,String(a.content),plan.sourceRef,proof);
  }
  return {...plan,intentRevisionId:revisionId,admittedAt:new Date().toISOString()};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 if(!process.stdin.isTTY)throw Error("Human-only operator enrollment requires an interactive terminal");
 const root=resolve(import.meta.dirname,".."),data=join(root,".sidera-dev","sol","data");
 const spec=JSON.parse(readFileSync(join(data,"runtime-spec.json"),"utf8"));
 const db=openDatabase(join(data,"sidera.sqlite"));
 try{
  const target=process.argv[2];if(!target||!spec.nodes.some((n:{nodeId:string})=>n.nodeId===target))throw Error('Provide an exact configured worker Node ID');
  const plan=enrollmentPlan(db,spec.chiefNodeId,target);
  console.log("Human account assertions: the active Sidera Codex sign-in and the bound ChatGPT sign-in belong to you. These are account aliases; no credentials or invented provider account IDs are recorded.");
  console.log("Only Chief/Astra Runtime Presence, the exact existing Chief Chat, and ONE read-only diagnostic Intent are included. No Grant, plan, payment, production repository permission, Task or dispatch is created here.");
  console.log(plan.proposals.map(explicitHumanStatement).join("\n\n"));
  process.stdout.write("Review the statements. Type ADMIT to apply, anything else aborts: ");
  const answer=await new Promise<string>(r=>process.stdin.once("data",x=>r(String(x).trim())));
  process.stdin.pause();
  if(answer!=="ADMIT")console.log("Aborted; no enrollment applied.");
  else{const result=applyEnrollment(db,plan,answer);writeFileSync(join(data,"runtime-diagnostic-enrollment.json"),JSON.stringify(result,null,2));console.log("Enrollment admitted and applied. No Task sent; Codex will continue the diagnostic.");}
 }finally{db.close();}
}

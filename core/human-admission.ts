import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { requireWorld } from "./worlds.ts";
import { SideraError } from "./types.ts";

export function canonical(value: unknown): string {
  const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v && typeof v==="object"?
    Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sort(x)])):v;
  return JSON.stringify(sort(value));
}
export interface HumanProposal {
  type: string; objectRef: string; scope: string; targetRevision: string | null;
  args: Record<string,unknown>; causalRefs: string[];
}
/**
 * Provenance for a Human authorization. Exactly one of `actId` (a single exact
 * act) or `packageActId` (an approved Permission Package manifest) is used.
 * A package carries no extra power: it only says which exact item was reviewed.
 */
export interface HumanActProof { id: string; actId?: string; packageActId?: string }
const prefix="SIDERA_HUMAN_ACT_V1\n";
export function explicitHumanStatement(proposal:HumanProposal):string { return prefix+canonical(proposal); }
function validProposal(value:unknown):HumanProposal {
  const p=value as HumanProposal;
  if(!p || typeof p!=="object" || Array.isArray(p) ||
    [p.type,p.objectRef,p.scope].some(v=>typeof v!=="string" || !v.trim()) || !(p.targetRevision===null || typeof p.targetRevision==="string") ||
    !p.args || typeof p.args!=="object" || Array.isArray(p.args) || !Array.isArray(p.causalRefs) || p.causalRefs.some(r=>typeof r!=="string"))
    throw new SideraError("denied","Malformed exact Human act");
  return p;
}

/** Privileged connector/configuration ingress. Never construct this from a Node
 * RPC, model output, or an unverified browser/assistant message. The returned
 * capture closure is not serializable or exposed to Agent tools. */
export function openHumanIngress(db:DatabaseSync,binding:{worldId:string;humanId:string;presenceRef:string;sourceRef:string}) {
  if(!binding.presenceRef.trim() || !binding.sourceRef.trim())throw new SideraError("denied","Attributable Human frontend source required");
  const sourceId=randomUUID();
  db.prepare("INSERT INTO human_frontend_sources VALUES (?,?,?,?,?,1)").run(sourceId,binding.worldId,binding.humanId,binding.presenceRef,binding.sourceRef);
  return {sourceId,capture(externalMessageId:string,body:string,clarificationOf?:string) {
    return withTransaction(db,"human_capture",()=>{
      if(!db.prepare("SELECT 1 FROM human_frontend_sources WHERE source_id=? AND active=1").get(sourceId))throw new SideraError("denied","Human source is inactive");
      if(!externalMessageId || !body)throw new SideraError("denied","Exact Human message identity required");
      const prior=db.prepare("SELECT * FROM human_utterances WHERE source_id=? AND external_message_id=?").get(sourceId,externalMessageId);
      if(prior) {if(prior.body!==body || prior.clarification_of!==(clarificationOf??null))throw new SideraError("conflict","Human message identity already used");return String(prior.utterance_id);}
      if(clarificationOf && !db.prepare(`SELECT 1 FROM human_utterances u JOIN human_frontend_sources s USING(source_id)
        WHERE u.utterance_id=? AND u.world_id=? AND s.human_id=?`).get(clarificationOf,binding.worldId,binding.humanId))throw new SideraError("denied","Clarification is outside Human/World");
      let exact:string|null=null;
      // This bounded deterministic policy admits explicit structured Human input.
      // Ordinary prose remains evidence, not a confidence-based authority decision.
      if(body.startsWith(prefix)) {try{exact=canonical(validProposal(JSON.parse(body.slice(prefix.length))));}catch{ /* unapplied ambiguity */ }}
      const id=randomUUID();
      db.prepare("INSERT INTO human_utterances VALUES (?,?,?,?,?,?,?,?)").run(id,binding.worldId,sourceId,externalMessageId,body,exact,clarificationOf??null,new Date().toISOString());
      return id;
    });
  },captureLiteralIntent(externalMessageId:string,body:string,input:{intentId:string;parentRevisionId:string|null;sourceRef:string}) {
    // This explicit privileged ingress mode records a Human's goal literally.
    // It cannot turn prose into a Grant, package, account binding or other act.
    // The ordinary capture method above continues to leave prose unapplied.
    return withTransaction(db,"human_literal_intent",()=>{
      if(!db.prepare("SELECT 1 FROM human_frontend_sources WHERE source_id=? AND active=1").get(sourceId))throw new SideraError("denied","Human source is inactive");
      if(!externalMessageId || typeof body!=="string" || !body.trim() || typeof input.sourceRef!=="string" || !input.sourceRef.trim() ||
        !(input.parentRevisionId===null || typeof input.parentRevisionId==="string" && input.parentRevisionId.trim()))
        throw new SideraError("denied","Exact literal Human intent and provenance required");
      const intent=db.prepare("SELECT human_id FROM intents WHERE intent_id=? AND world_id=?").get(input.intentId,binding.worldId);
      if(intent?.human_id!==binding.humanId)throw new SideraError("denied","Literal intent is outside the bound Human/World");
      const proposal:HumanProposal={type:"intent.revise",objectRef:input.intentId,scope:`intent/${input.intentId}`,targetRevision:input.parentRevisionId,
        args:{intentId:input.intentId,parentRevisionId:input.parentRevisionId,content:body,sourceRef:input.sourceRef},
        causalRefs:[binding.sourceRef,input.sourceRef,`literal-human-message:${externalMessageId}`]};
      const exact=canonical(proposal);
      const prior=db.prepare("SELECT * FROM human_utterances WHERE source_id=? AND external_message_id=?").get(sourceId,externalMessageId);
      if(prior){
        if(prior.body!==body || prior.explicit_act_json!==exact || prior.clarification_of!==null)
          throw new SideraError("conflict","Human message identity already used with different admission semantics");
        return {utteranceId:String(prior.utterance_id),proposal};
      }
      const utteranceId=randomUUID();
      db.prepare("INSERT INTO human_utterances VALUES (?,?,?,?,?,?,?,?)").run(utteranceId,binding.worldId,sourceId,externalMessageId,body,exact,null,new Date().toISOString());
      return {utteranceId,proposal};
    });
  }};
}
export function recordInterpretation(db:DatabaseSync,input:{worldId:string;nodeId:string;utteranceId?:string;proposal:HumanProposal;confidence?:number;confirmed?:boolean}) {
  requireWorld(db,input.worldId,"nodes",input.nodeId);
  const id=randomUUID();
  db.prepare("INSERT INTO interpretation_claims VALUES (?,?,?,?,?,?,?,?)").run(id,input.worldId,input.nodeId,input.utteranceId??null,
    canonical(input.proposal),input.confidence??null,input.confirmed?1:0,new Date().toISOString()); return id;
}
export function admitHumanAct(db:DatabaseSync,input:{worldId:string;humanId:string;utteranceId?:string;proposal:HumanProposal}) {
  return withTransaction(db,"human_admission",()=>{
    const proposal=validProposal(input.proposal);
    const row=db.prepare(`SELECT u.*,s.human_id,s.active FROM human_utterances u JOIN human_frontend_sources s USING(source_id)
      WHERE u.utterance_id=? AND u.world_id=?`).get(input.utteranceId??"",input.worldId);
    if(!row || row.human_id!==input.humanId || row.active!==1 || row.explicit_act_json!==canonical(proposal))
      throw new SideraError("denied","Insufficient exact Human-origin evidence; interpretation/confirmed/confidence is not authority");
    const policy=db.prepare("SELECT * FROM trust_policy WHERE world_id=?").get(input.worldId)!;
    const prior=db.prepare("SELECT act_id FROM human_semantic_acts WHERE utterance_id=?").get(row.utterance_id);
    if(prior)return {id:input.humanId,actId:String(prior.act_id)};
    validateRevision(db,input.worldId,proposal);
    const id=randomUUID();
    db.prepare("INSERT INTO human_semantic_acts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,input.worldId,input.humanId,row.source_id,row.utterance_id,
      proposal.type,proposal.objectRef,proposal.scope,proposal.targetRevision,canonical(proposal.args),policy.version,policy.epoch,
      canonical([...proposal.causalRefs,String(row.utterance_id),...(row.clarification_of?[String(row.clarification_of)]:[])]),new Date().toISOString());
    return {id:input.humanId,actId:id};
  });
}
function validateRevision(db:DatabaseSync,worldId:string,p:HumanProposal) {
  if(p.type==="intent.revise") {
    const intent=db.prepare("SELECT * FROM intents WHERE intent_id=? AND world_id=?").get(p.objectRef,worldId);
    if(!intent || p.args.intentId!==p.objectRef || (p.args.parentRevisionId??null)!==p.targetRevision)throw new SideraError("denied","Wrong Intent object/basis");
    const leaves=db.prepare(`SELECT revision_id FROM intent_revisions r WHERE intent_id=? AND NOT EXISTS(SELECT 1 FROM intent_revisions c WHERE c.parent_revision_id=r.revision_id)`).all(p.objectRef);
    if(p.targetRevision===null ? leaves.length!==0 : !leaves.some(r=>r.revision_id===p.targetRevision))throw new SideraError("denied","Obsolete Intent revision requires Human clarification");
  }
}
/** Must run inside the same transaction as the semantic mutation. */
export function consumeHumanAct(db:DatabaseSync,proof:HumanActProof,worldId:string,type:string,objectRef:string,scope:string,args:unknown):string {
  const act=db.prepare("SELECT * FROM human_semantic_acts WHERE act_id=? AND world_id=? AND human_id=?").get(proof.actId??"",worldId,proof.id);
  if(!act || act.act_type!==type || act.object_ref!==objectRef || act.scope!==scope || act.args_json!==canonical(args))throw new SideraError("denied","Exact admitted Human act required");
  const policy=db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(worldId)!;
  if(act.policy_epoch!==policy.epoch)throw new SideraError("denied","Human act policy is obsolete");
  // Intent evidence was checked at admission. Two Human acts admitted against
  // the same then-current parent remain concurrent, regardless of apply order.
  // A later proposal against an obsolete parent is rejected by admission above.
  db.prepare("INSERT INTO human_act_applications VALUES (?,?,?,?)").run(act.act_id,type,canonical(args),new Date().toISOString());return String(act.act_id);
}

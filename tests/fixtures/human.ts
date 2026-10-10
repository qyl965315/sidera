import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openHumanIngress,explicitHumanStatement,admitHumanAct,canonical,type HumanProposal,type HumanActProof } from "../../core/human-admission.ts";
import { SemanticStore as Store } from "../../core/semantics.ts";
import { grantSelf } from "./authority.ts";

const proofs=new WeakMap<DatabaseSync,Map<string,HumanActProof>>();
/** Synthetic trusted Human frontend. This helper is never imported by runtime. */
export function humanProof(db:DatabaseSync,worldId:string,humanId:string,proposal:HumanProposal):HumanActProof {
  db.prepare("INSERT OR IGNORE INTO human_principals VALUES (?,?,?,?)").run(humanId,humanId,"synthetic Human test principal",new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO world_humans VALUES (?,?,?)").run(worldId,humanId,"explicit synthetic test membership");
  const key=canonical({worldId,humanId,proposal}),cache=proofs.get(db)??new Map();proofs.set(db,cache);
  if(cache.has(key))return cache.get(key)!;
  const source=openHumanIngress(db,{worldId,humanId,presenceRef:"fixture:primary-human-frontend",sourceRef:`fixture:${randomUUID()}`});
  const utteranceId=source.capture(randomUUID(),explicitHumanStatement(proposal));
  const proof=admitHumanAct(db,{worldId,humanId,utteranceId,proposal});cache.set(key,proof);return proof;
}
export function intentProof(store:Store,intentId:string,parentRevisionId:string|null,content:string,sourceRef:string) {
  const humanId=String(store.db.prepare("SELECT human_id FROM intents WHERE intent_id=?").get(intentId)!.human_id);
  return humanProof(store.db,store.worldId,humanId,{type:"intent.revise",objectRef:intentId,scope:`intent/${intentId}`,targetRevision:parentRevisionId,
    args:{intentId,parentRevisionId,content,sourceRef},causalRefs:[sourceRef]});
}
export class SemanticStore extends Store {
  override registerNode(label:string) {const node=super.registerNode(label);grantSelf(this.db,node);return node;}
  override reviseIntent(intentId:string,parentRevisionId:string|null,content:string,sourceRef:string,proof?:HumanActProof) {
    return super.reviseIntent(intentId,parentRevisionId,content,sourceRef,proof??intentProof(this,intentId,parentRevisionId,content,sourceRef));
  }
}

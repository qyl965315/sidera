import {createHash,randomUUID} from "node:crypto";
import {join} from "node:path";
import {openDatabase,withTransaction} from "./db.ts";
import {SemanticStore} from "./semantics.ts";
import {openHumanIngress,admitHumanAct} from "./human-admission.ts";
export function captureHumanGoal(root:string,body:string,humanId:string,worldId:string,source="local-human-browser:literal-goal") {
  if(!body.trim())throw new Error("Human goal cannot be empty");
  const sourceRef=`${source}#sha256=${createHash("sha256").update(body).digest("hex")}`;
  const db=openDatabase(join(root,".sidera-dev","sol","data","sidera.sqlite"));
  try{
    const admission=withTransaction(db,"operator_literal_intent",()=>{
      if(!db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(worldId,humanId))throw new Error("Human must already belong to the selected World");
      const store=new SemanticStore(db,worldId),intentId=store.createIntent(humanId,sourceRef),externalMessageId=randomUUID();
      const ingress=openHumanIngress(db,{worldId,humanId,presenceRef:"local-human-operator:literal-goal-file",sourceRef});
      const captured=ingress.captureLiteralIntent(externalMessageId,body,{intentId,parentRevisionId:null,sourceRef});
      const proof=admitHumanAct(db,{worldId,humanId,...captured});
      const intentRevisionId=store.reviseIntent(intentId,null,body,sourceRef,proof);
      return {worldId,humanId,intentId,intentRevisionId,utteranceId:captured.utteranceId,contextBasis:[sourceRef,`human-utterance:${captured.utteranceId}`],
        literalHumanGoal:true,authorityGranted:false,taskCreated:false};
    });
    return {body,admission};
  }finally{db.close();}
}


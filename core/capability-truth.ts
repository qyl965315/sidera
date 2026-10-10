import type { DatabaseSync } from "node:sqlite";
import { appendHistory } from "./history.ts";
import { recordWorld } from "./worlds.ts";
import { SideraError } from "./types.ts";
export interface CapabilityTruth { operation:string; availability:"available"|"unavailable"; freshness:"CURRENT"|"UNKNOWN"|"STALE"; sourceRef:string|null; checkedAt:string|null; verifyTaskSuggested:boolean }
/** Host inventory is a discovery hint. Only a successful exact operation is current C. */
export function migrateCapabilityTruth(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS capability_checks(node_ref TEXT NOT NULL,session_ref TEXT NOT NULL,operation TEXT NOT NULL,
    available INTEGER NOT NULL CHECK(available IN(0,1)),source_ref TEXT NOT NULL,checked_at TEXT NOT NULL,expires_at TEXT NOT NULL,
    PRIMARY KEY(node_ref,session_ref,operation));`);
}
/** Privileged adapter observation; not a model-authorable availability setter. */
export function recordCapabilityCheck(db:DatabaseSync,input:{nodeRef:string;sessionRef:string;operation:string;available:boolean;sourceRef:string;checkedAt?:string;expiresAt?:string}) {
  if(!db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND node_id=?").get(input.sessionRef,input.nodeRef))throw new SideraError("denied","Exact owned runtime context required");
  const at=input.checkedAt??new Date().toISOString(),until=input.expiresAt??new Date(Date.parse(at)+60_000).toISOString();
  db.prepare("INSERT INTO capability_checks VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_ref,session_ref,operation) DO UPDATE SET available=excluded.available,source_ref=excluded.source_ref,checked_at=excluded.checked_at,expires_at=excluded.expires_at")
    .run(input.nodeRef,input.sessionRef,input.operation,input.available?1:0,input.sourceRef,at,until);
  appendHistory(db,{kind:"Effect",source:input.sourceRef,nodeRef:input.nodeRef,worldRef:recordWorld(db,"nodes",input.nodeRef),
    executorRef:input.sessionRef,payload:{interface:"CapabilityCheck",operation:input.operation,availability:input.available?"available":"unavailable",checkedAt:at,expiresAt:until}});
}
export function capabilityTruth(db:DatabaseSync,nodeRef:string,sessionRef:string|null,operation:string,localVerified=false,at=Date.now()):CapabilityTruth {
  if(localVerified)return {operation,availability:"available",freshness:"CURRENT",sourceRef:"core:implemented-registry-read",checkedAt:new Date(at).toISOString(),verifyTaskSuggested:false};
  const row=sessionRef?db.prepare("SELECT * FROM capability_checks WHERE node_ref=? AND session_ref=? AND operation=?").get(nodeRef,sessionRef,operation):null;
  const freshness=!row?"UNKNOWN":Date.parse(String(row.expires_at))>at?"CURRENT":"STALE";
  return {operation,availability:row?.available===1&&freshness==="CURRENT"?"available":"unavailable",freshness,
    sourceRef:row?String(row.source_ref):null,checkedAt:row?String(row.checked_at):null,verifyTaskSuggested:freshness!=="CURRENT"};
}

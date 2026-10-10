import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";

/** Continue an already Human-bound external Host identity across an authorized
 * same-Node, same-adapter Session replacement. This is continuity, not a new
 * identity assertion or rebind. A Host/adapter change must use explicit Human
 * admission instead. */
export function continueBoundHostIdentity(db:DatabaseSync,input:{
  fromSessionId:string;toSessionId:string;requestId:string;source:string;
}):boolean {
  const from=db.prepare(`SELECT session_id,node_id,hythe_id,host_kind FROM sessions WHERE session_id=?`)
    .get(input.fromSessionId) as {session_id:string;node_id:string;hythe_id:string;host_kind:string}|undefined;
  const to=db.prepare(`SELECT session_id,node_id,hythe_id,host_kind FROM sessions WHERE session_id=?`)
    .get(input.toSessionId) as {session_id:string;node_id:string;hythe_id:string;host_kind:string}|undefined;
  if(!from||!to)throw new SideraError("not_found","Session identity-continuity endpoint missing");
  if(from.node_id!==to.node_id||from.hythe_id!==to.hythe_id||from.host_kind!==to.host_kind)
    throw new SideraError("denied","External Host identity cannot continue across Node/Hythe/Host change");
  const prior=db.prepare(`SELECT p.world_id,p.identity_id FROM presence_accounts p
    JOIN external_identities i ON i.identity_id=p.identity_id AND i.world_id=p.world_id AND i.state='active'
    WHERE p.session_id=? AND p.knowledge='bound'`).get(input.fromSessionId) as
    {world_id:string;identity_id:string}|undefined;
  if(!prior)return false;
  const existing=db.prepare("SELECT world_id,identity_id,knowledge FROM presence_accounts WHERE session_id=?")
    .get(input.toSessionId) as {world_id:string;identity_id:string|null;knowledge:string}|undefined;
  if(existing){
    if(existing.world_id!==prior.world_id||existing.identity_id!==prior.identity_id||existing.knowledge!=="bound")
      throw new SideraError("conflict","Replacement Session already has a different Presence identity");
    return true;
  }
  db.prepare("INSERT INTO presence_accounts VALUES (?,?,?,'bound')")
    .run(input.toSessionId,prior.world_id,prior.identity_id);
  db.prepare("INSERT INTO events VALUES (?,?,'session.identity_continued',?,?)")
    .run(randomUUID(),from.node_id,JSON.stringify({requestId:input.requestId,nodeId:from.node_id,
      fromSessionId:input.fromSessionId,toSessionId:input.toSessionId,identityId:prior.identity_id,
      source:input.source,rebind:false}),new Date().toISOString());
  return true;
}

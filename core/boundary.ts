import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { effectAwareRoute, type RouteCandidate } from "./control-plane.ts";

export function boundaryEvent(db:DatabaseSync, actor:string|null, kind:string, payload:unknown) {
  const id=randomUUID();
  db.prepare("INSERT INTO events VALUES (?,?,?,?,?)").run(id,actor,kind,JSON.stringify(payload),new Date().toISOString());
  return id;
}
/** Observations are event-derived: failed transport never rewrites organization state. */
export async function observeBoundary(db:DatabaseSync, actor:string, resource:string, operation:string, routes:RouteCandidate[]) {
  if (!/\.(read|observe|status|inspect|locate)$/.test(operation)) throw new Error("Observation requires read semantics");
  const result=await effectAwareRoute(operation,resource,routes), at=new Date().toISOString();
  if(result.status==="PASS") {
    const value={observation:"live",at,selectedRoute:result.route,data:result.effect,rawRouteErrors:result.errors,lastKnown:null,lastKnownAt:null,observationAvailable:true};
    boundaryEvent(db,actor,"boundary.observed",{resource,operation,...value});
    return value;
  }
  const known=db.prepare(`SELECT payload FROM events WHERE kind='boundary.observed' AND actor_node_id=?
    AND json_extract(payload,'$.resource')=? AND json_extract(payload,'$.operation')=? ORDER BY rowid DESC LIMIT 1`)
    .get(actor,resource,operation) as {payload:string}|undefined;
  const last=known?JSON.parse(known.payload):null;
  const value={observation:last?"last-known":"unavailable",at,selectedRoute:null,data:null,
    lastKnown:last?.data??null,lastKnownAt:last?.at??null,observationAvailable:false,rawRouteErrors:result.errors};
  boundaryEvent(db,actor,"boundary.observation_unavailable",{resource,operation,...value});
  return value;
}

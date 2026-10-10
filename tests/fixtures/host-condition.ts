import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {ConditionEvidence} from "../../core/condition.ts";

/** Test-only synthetic exact Host receipt; never a production Presence claim. */
export function recordFixtureHostAvailable(db:DatabaseSync,sessionId:string):string {
 const session=db.prepare("SELECT node_id,hythe_id,locator_ref FROM sessions WHERE session_id=?").get(sessionId) as
   {node_id:string;hythe_id:string;locator_ref:string}|undefined;
 if(!session)throw Error("fixture Session must exist");
 const eventId=randomUUID(),at=new Date().toISOString();
 const evidence:ConditionEvidence={subject:{kind:"host",ref:sessionId,
  generation:session.hythe_id+":"+session.locator_ref},evidenceClass:"HOST_LOCATOR",
  outcome:"AVAILABLE",observedAt:at,validUntil:new Date(Date.parse(at)+90_000).toISOString(),
  evidenceRef:eventId,source:"fixture:verified-host"};
 db.prepare("INSERT INTO events VALUES (?,?,'host.health.observed',?,?)").run(eventId,session.node_id,
  JSON.stringify({targetNodeId:session.node_id,sessionId,locatorRef:session.locator_ref,
    source:"fixture:verified-host",state:"available",conditionEvidence:evidence,replay:false}),at);
 db.prepare(`INSERT INTO session_health VALUES (?,'available',?,?)
    ON CONFLICT(session_id) DO UPDATE SET state='available',event_id=excluded.event_id,updated_at=excluded.updated_at`)
  .run(sessionId,eventId,at);
 return eventId;
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Hythe } from "../hythes/types.ts";
import { withTransaction } from "./db.ts";
import { isExecutorRuntimeSession } from "./executors.ts";
import { projectCondition, type ConditionEvidence, type ObservationOutcome } from "./condition.ts";

export interface HostObservation {
  live: boolean;
  state: "available" | "unavailable" | "unknown";
  observedAt: string;
  reason: string | null;
  evidenceRef?: string;
  outcome?: ObservationOutcome;
}

/** Explicit bounded infrastructure probe; not a passive Inspect operation.
 * A probe is only source evidence. It cannot claim the external resource was
 * destroyed and may NEVER invoke Effect reconciliation or a Task send.
 * Hythe.locate may currently start a Host: G2 will separate that lifecycle
 * effect from the read-only Inspect contract.
 */
export async function probeHostHealth(db: DatabaseSync, hythes: ReadonlyMap<string, Hythe>,
  sessionId: string, source: string, timeoutMs = 10_000): Promise<HostObservation> {
  const session = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId);
  const unknown = (reason: string): HostObservation =>
    ({ live:false, state:"unknown", observedAt:new Date().toISOString(), reason });
  if (!session || session.state !== "active" &&
      !isExecutorRuntimeSession(db, String(session.node_id), sessionId))
    return unknown("Exact context is not current or admitted");

  const hythe = hythes.get(String(session.hythe_id));
  let outcome: ObservationOutcome = "ERROR", reason: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!hythe || hythe.hostKind !== session.host_kind)
      reason = "Exact Host adapter unavailable";
    else {
      outcome = await Promise.race([
        hythe.locate(String(session.locator_ref))
          .then(ok => ok ? "AVAILABLE" as const : "NEGATIVE" as const,
            () => "ERROR" as const),
        new Promise<"TIMEOUT">(resolve => {
          timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
        }),
      ]);
      if (outcome === "AVAILABLE" && hythe.canStartTurn?.() === false)
        outcome = "NEGATIVE";
      if (outcome === "TIMEOUT") reason = "Exact Host probe timed out; resource lifetime unproven";
      else if (outcome === "NEGATIVE") reason = "Exact Host is not currently actionable; lifetime unproven";
      else if (outcome === "ERROR") reason = "Exact Host probe failed; resource lifetime unproven";
    }
  } catch {
    outcome = "ERROR";
    reason = "Exact Host probe failed; resource lifetime unproven";
  } finally { if (timer) clearTimeout(timer); }

  return withTransaction(db, "host_health_probe", () => {
    const current = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId);
    if (!current || current.hythe_id !== session.hythe_id || current.locator_ref !== session.locator_ref ||
      current.node_id !== session.node_id || current.state !== "active" &&
      !isExecutorRuntimeSession(db, String(current.node_id), sessionId))
      return unknown("Exact context changed during the probe");

    const before = db.prepare("SELECT state FROM session_health WHERE session_id=?").get(sessionId);
    const eventId = randomUUID(), at = new Date().toISOString();
    const evidence: ConditionEvidence = {
      subject: {kind:"host",ref:sessionId,generation:`${session.hythe_id}:${session.locator_ref}`},
      evidenceClass:"HOST_LOCATOR", outcome, observedAt:at,
      validUntil:new Date(Date.parse(at) + 90_000).toISOString(),
      evidenceRef:eventId, source,
    };
    const projected = projectCondition(evidence.subject, evidence, Date.parse(at));
    // Compatibility row: unavailable is reserved for a known resource lifecycle
    // event, not a failed network observation. Unknown blocks execution without
    // permanently fencing any MAY_HAVE_EFFECT attempt or Task.
    const state = projected.state === "AVAILABLE" ? "available" : "unknown";
    db.prepare("INSERT INTO events VALUES (?,?,?,?,?)").run(eventId,session.node_id,
      "host.health.observed",
      JSON.stringify({targetNodeId:session.node_id,sessionId,state,source,
        locatorRef:session.locator_ref,evidenceClass:"HOST_LOCATOR",
        conditionEvidence:evidence,previousState:before?.state ?? null,
        reason,replay:false}),at);
    db.prepare(`INSERT INTO session_health VALUES (?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
      state=excluded.state,event_id=excluded.event_id,updated_at=excluded.updated_at`)
      .run(sessionId,state,eventId,at);
    return { live:state==="available",state,observedAt:at,reason,evidenceRef:eventId,outcome };
  });
}

/** Trusted internal receipt producer for an authorized Host Session handoff.
 * Call only AFTER an actual Host resource was created under an Effect boundary
 * and the exact successor passed registry Host locator verification and CAS.
 * No probe, Task or Credential act is started here.
 */
export function recordConfirmedHostHandoff(db:DatabaseSync,sessionId:string,sourceRef:string):HostObservation {
  const session=db.prepare("SELECT node_id,hythe_id,locator_ref,state FROM sessions WHERE session_id=?").get(sessionId) as
    {node_id:string;hythe_id:string;locator_ref:string;state:string}|undefined;
  if(!session || session.state!=="active" || !sourceRef.trim())
    throw new Error("Confirmed exact active Host handoff receipt required");
  return withTransaction(db,"confirmed_host_handoff",()=>{
    const eventId=randomUUID(),at=new Date().toISOString();
    const evidence:ConditionEvidence={
      subject:{kind:"host",ref:sessionId,generation:session.hythe_id+":"+session.locator_ref},
      evidenceClass:"HOST_LOCATOR",outcome:"AVAILABLE",observedAt:at,
      validUntil:new Date(Date.parse(at)+90_000).toISOString(),evidenceRef:eventId,
      source:"authorized-exact-host-handoff",
    };
    db.prepare("INSERT INTO events VALUES (?,?,'host.health.observed',?,?)").run(eventId,session.node_id,
      JSON.stringify({sessionId,targetNodeId:session.node_id,locatorRef:session.locator_ref,
        source:"authorized-exact-host-handoff",sourceRef,conditionEvidence:evidence,
        replay:false,state:"available"}),at);
    db.prepare("INSERT INTO session_health VALUES (?,'available',?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,event_id=excluded.event_id,updated_at=excluded.updated_at")
      .run(sessionId,eventId,at);
    return {live:true,state:"available",observedAt:at,reason:null,evidenceRef:eventId,outcome:"AVAILABLE"};
  });
}

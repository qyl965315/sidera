/**
 * R1 condition semantics: one pure, scoped projection of source evidence.
 * This is NOT an Effect gate, scheduler, authority source or background service.
 * Configuration and a successful gateway probe cannot attest a specific Chat.
 */
export type ConditionSubject =
  | { kind: "host"; ref: string; generation: string }
  | { kind: "edge"; ref: string; generation: string }
  | { kind: "conversation"; ref: string; generation: string }
  | { kind: "route"; ref: string; generation: string };
export type ConditionClass =
  | "CONFIGURED_BINDING" | "HOST_LOCATOR" | "OWNER_TERMINATION"
  | "TRANSPORT_POLL" | "AUTHENTICATED_INGRESS"
  | "EXACT_CONVERSATION" | "RETURN_ROUTE";
export type ObservationOutcome = "AVAILABLE" | "NEGATIVE" | "TIMEOUT" | "ERROR" | "TERMINATED";
export type ConditionState = "AVAILABLE" | "UNKNOWN" | "STALE" | "CONFIRMED_LOST";

export interface ConditionEvidence {
  subject: ConditionSubject;
  evidenceClass: ConditionClass;
  outcome: ObservationOutcome;
  observedAt: string;
  validUntil: string;
  evidenceRef: string;
  source: string;
  /** Required only for authoritative owner death; never synthesized by probes. */
  ownerTermination?: {
    ownerId: string;
    sessionRef: string;
    generation: string;
    witnessRef: string;
  };
}
export interface ConditionProjection {
  subject: ConditionSubject;
  state: ConditionState;
  evidenceClass: ConditionClass | null;
  evidenceRef: string | null;
  observedAt: string | null;
  validUntil: string | null;
  reason: string;
}
const scopedClasses: Record<ConditionSubject["kind"], ReadonlySet<ConditionClass>> = {
  host: new Set(["HOST_LOCATOR", "OWNER_TERMINATION"]),
  edge: new Set(["TRANSPORT_POLL", "AUTHENTICATED_INGRESS"]),
  conversation: new Set(["EXACT_CONVERSATION"]),
  route: new Set(["RETURN_ROUTE"]),
};

export function projectCondition(
  subject: ConditionSubject, evidence: ConditionEvidence | null | undefined, now = Date.now(),
): ConditionProjection {
  const unknown = (reason: string): ConditionProjection => ({
    subject, state: "UNKNOWN", evidenceClass: null, evidenceRef: null,
    observedAt: null, validUntil: null, reason,
  });
  if (!evidence) return unknown("NO_EVIDENCE");
  if (subject.kind !== evidence.subject.kind ||
      subject.ref !== evidence.subject.ref ||
      subject.generation !== evidence.subject.generation)
    return unknown("EVIDENCE_SUBJECT_OR_GENERATION_MISMATCH");
  if (!scopedClasses[subject.kind].has(evidence.evidenceClass))
    return unknown("EVIDENCE_SCOPE_INSUFFICIENT");
  if (!evidence.evidenceRef?.trim() || !evidence.source?.trim())
    return unknown("EVIDENCE_PROVENANCE_MISSING");
  const observed = Date.parse(evidence.observedAt), until = Date.parse(evidence.validUntil);
  if (!Number.isFinite(observed) || !Number.isFinite(until) || observed > now || until <= observed)
    return unknown("EVIDENCE_CLOCK_OR_WINDOW_INVALID");
  const view = (state: ConditionState, reason: string): ConditionProjection => ({
    subject, state, evidenceClass: evidence.evidenceClass,
    evidenceRef: evidence.evidenceRef, observedAt: evidence.observedAt,
    validUntil: evidence.validUntil, reason,
  });
  if (now >= until) return view("STALE", "EVIDENCE_EXPIRED");
  if (evidence.outcome === "AVAILABLE") return view("AVAILABLE", "OBSERVED_EXACT_SCOPE");
  if (evidence.outcome === "TERMINATED" && evidence.evidenceClass === "OWNER_TERMINATION") {
    const proof = evidence.ownerTermination;
    if (proof && proof.ownerId && proof.witnessRef && proof.sessionRef === subject.ref &&
        proof.generation === subject.generation)
      return view("CONFIRMED_LOST", "EXACT_OWNER_TERMINATION");
  }
  return view("UNKNOWN", evidence.outcome === "TERMINATED"
    ? "TERMINATION_PROOF_MISSING"
    : evidence.outcome === "TIMEOUT" ? "PROBE_TIMED_OUT"
    : evidence.outcome === "NEGATIVE" ? "PROBE_NEGATIVE_NOT_LOSS"
    : "PROBE_FAILED");
}

/** Current Host condition is projected from the exact persisted observation,
 * not from a standalone row label. It never probes, executes, or writes.
 * A legacy row with no correlated evidence remains UNKNOWN.
 */
import type { DatabaseSync } from "node:sqlite";

export type SessionHostCondition = {
  sessionId:string;
  state:ConditionState;
  canExecute:boolean;
  evidenceRef:string|null;
  observedAt:string|null;
  freshUntil:string|null;
  reason:string;
  legacyState:string|null;
};
const HOST_OBSERVATION_TTL_MS=90_000;
export function readSessionHostCondition(db:DatabaseSync,sessionId:string,now=Date.now()):SessionHostCondition {
  const base=(state:ConditionState,reason:string,legacyState:string|null=null,evidenceRef:string|null=null,
    observedAt:string|null=null,freshUntil:string|null=null):SessionHostCondition=>
    ({sessionId,state,canExecute:state==="AVAILABLE",evidenceRef,observedAt,freshUntil,reason,legacyState});
  const session=db.prepare("SELECT hythe_id,locator_ref,state FROM sessions WHERE session_id=?").get(sessionId) as
    {hythe_id:string;locator_ref:string;state:string}|undefined;
  if(!session)return base("UNKNOWN","SESSION_NOT_REGISTERED");
  if(session.state==="retired")return base("CONFIRMED_LOST","SESSION_RETIRED");
  const row=db.prepare("SELECT state,event_id,updated_at FROM session_health WHERE session_id=?").get(sessionId) as
    {state:string;event_id:string;updated_at:string}|undefined;
  if(!row)return base("UNKNOWN","HOST_NOT_OBSERVED");
  const legacy=String(row.state);
  const event=db.prepare("SELECT kind,payload,created_at FROM events WHERE event_id=?").get(row.event_id) as
    {kind:string;payload:string;created_at:string}|undefined;
  if(!event)return base("UNKNOWN","HOST_HEALTH_WITHOUT_SOURCE_EVIDENCE",legacy);
  let payload:Record<string,unknown>;
  try{payload=JSON.parse(event.payload) as Record<string,unknown>;}catch{return base("UNKNOWN","INVALID_HOST_EVIDENCE",legacy);}
  if(payload.sessionId!==sessionId)return base("UNKNOWN","HOST_EVIDENCE_SESSION_MISMATCH",legacy);
  // Only an actual exact Host probe may establish ordinary execution availability.
  // Source labels and configuration strings are never proof.
  if(event.kind==="host.health.observed"){
    const typed=payload.conditionEvidence as ConditionEvidence | undefined;
    if(!typed||typed.evidenceRef!==row.event_id||typed.observedAt!==row.updated_at ||
       typed.subject.ref!==sessionId||typed.subject.generation!==session.hythe_id+":"+session.locator_ref)
      return base("UNKNOWN","HOST_EVIDENCE_CORRELATION_MISMATCH",legacy);
    const condition=projectCondition({kind:"host",ref:sessionId,generation:typed.subject.generation},typed,now);
    // The independently stored compatibility state may never override typed evidence.
    if(condition.state==="AVAILABLE"&&legacy!=="available")
      return base("UNKNOWN","HOST_COMPATIBILITY_CONFLICT",legacy);
    return base(condition.state,condition.reason,legacy,condition.evidenceRef,condition.observedAt,condition.validUntil);
  }
  // Explicit self-authorized Host resume was already confirmed and assigned an
  // immutable event ID; this is a bounded compatibility read, not a new action.
  if(event.kind==="host.health.changed"&&payload.source==="authorized-exact-host-resume" &&
     payload.state==="available"&&legacy==="available"&&typeof payload.attemptId==="string"){
    const observed=Date.parse(row.updated_at),validUntil=new Date(observed+HOST_OBSERVATION_TTL_MS).toISOString();
    const current=projectCondition({kind:"host",ref:sessionId,generation:session.hythe_id+":"+session.locator_ref},
      {subject:{kind:"host",ref:sessionId,generation:session.hythe_id+":"+session.locator_ref},
      evidenceClass:"HOST_LOCATOR",outcome:"AVAILABLE",observedAt:row.updated_at,validUntil,
      source:"authorized-exact-host-resume",evidenceRef:row.event_id},now);
    return base(current.state,current.reason,legacy,current.evidenceRef,current.observedAt,current.validUntil);
  }
  // A previous loss event can represent true owner death or an obsolete probe
  // path. Until G2 validates LossProof, refuse new execution but do not claim
  // that the Host has physically vanished.
  return base("UNKNOWN","HOST_EVIDENCE_NOT_VERIFIED",legacy,row.event_id,row.updated_at,null);
}

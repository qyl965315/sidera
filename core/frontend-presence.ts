import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";

/**
 * Durable Human-frontend Presence observation.
 *
 * Runtime readiness must never be decided by launching a browser. Opening the
 * frontend to "check whether the frontend is there" is both a real Effect and
 * the exact path that walks into an anti-bot / CAPTCHA challenge, which is not
 * a retryable engineering path. Presence is therefore an *observation* with a
 * declared evidence class, a source and an expiry - never a side effect.
 *
 * Evidence classes, weakest to strongest:
 *   TRANSPORT_POLL  the local tunnel control plane answered and the circuit is
 *                   closed. Proves authentication and connectivity only. It is
 *                   explicitly NOT proof that a Human dispatched anything.
 *   ROUTE_VERIFIED  exact authenticated inbound or native/protocol conversation
 *                   read. The source must identify the same binding.
 *   UI_ROUTE_VERIFIED  retained historical evidence only. Production never uses
 *                   UI/browser observations to establish exact Chat Presence.
 */
export const PRESENCE_EVIDENCE = ["TRANSPORT_POLL", "ROUTE_VERIFIED", "UI_ROUTE_VERIFIED"] as const;
export type PresenceEvidence = typeof PRESENCE_EVIDENCE[number];
const TTL_MS: Record<PresenceEvidence, number> = {
  TRANSPORT_POLL: 5 * 60_000, ROUTE_VERIFIED: 60 * 60_000, UI_ROUTE_VERIFIED: 60 * 60_000,
};

export function migrateFrontendPresence(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frontend_presence_observations (
      observation_id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      binding_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      evidence_class TEXT NOT NULL CHECK (evidence_class IN ('TRANSPORT_POLL','ROUTE_VERIFIED','UI_ROUTE_VERIFIED')),
      evidence_ref TEXT NOT NULL,
      method TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      fresh_until TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS presence_by_binding
      ON frontend_presence_observations(world_id, binding_id, observed_at);
    CREATE TRIGGER IF NOT EXISTS presence_append_only_update BEFORE UPDATE ON frontend_presence_observations
      BEGIN SELECT RAISE(ABORT,'Presence observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS presence_append_only_delete BEFORE DELETE ON frontend_presence_observations
      BEGIN SELECT RAISE(ABORT,'Presence observations are append-only'); END;
  `);
}
export function recordFrontendPresence(db: DatabaseSync, input: {
  worldId: string; bindingId: string; conversationRef: string;
  evidenceClass: PresenceEvidence; evidenceRef: string; method: string;
  observedAt?: string; ttlMs?: number;
}): string {
  if (!input.evidenceRef?.trim() || !input.method?.trim())
    throw new SideraError("conflict", "Presence evidence needs a source reference and a method");
  const observedAt = input.observedAt ?? new Date().toISOString();
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) throw new SideraError("conflict", "Presence observation time is invalid");
  const freshUntil = new Date(at + (input.ttlMs ?? TTL_MS[input.evidenceClass])).toISOString();
  const id = randomUUID();
  return withTransaction(db, "presence_record", () => {
    // Identical consecutive evidence is coalesced so a polling transport does not
    // grow unbounded history.
    const prior = db.prepare(`SELECT observation_id,evidence_class,evidence_ref,observed_at FROM frontend_presence_observations
      WHERE world_id=? AND binding_id=? ORDER BY observed_at DESC LIMIT 1`)
      .get(input.worldId, input.bindingId) as { observation_id: string; evidence_class: string; evidence_ref: string; observed_at: string } | undefined;
    if (prior && prior.evidence_class === input.evidenceClass && prior.evidence_ref === input.evidenceRef
      && at - Date.parse(prior.observed_at) < TTL_MS[input.evidenceClass] / 2) return prior.observation_id;
    db.prepare("INSERT INTO frontend_presence_observations VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, input.worldId, input.bindingId, input.conversationRef,
        input.evidenceClass, input.evidenceRef, input.method, observedAt, freshUntil);
    if(input.evidenceClass==="ROUTE_VERIFIED")db.prepare("INSERT INTO events VALUES (?,NULL,'frontend.presence_observed',?,?)")
      .run(randomUUID(),JSON.stringify({bindingId:input.bindingId,conversationRef:input.conversationRef,observationId:id}),observedAt);
    return id;
  });
}
export interface PresenceState {
  state: "LIVE" | "STALE" | "UNKNOWN";
  evidenceClass: PresenceEvidence | null;
  observedAt: string | null; freshUntil: string | null; evidenceRef: string | null; method: string | null;
  ageMs: number | null; requiresHumanAction: false;
}
export function latestFrontendPresence(db: DatabaseSync, input: {
  worldId: string; bindingId: string; at?: number; verifiedOnly?: boolean; productionOnly?: boolean;
}): PresenceState {
  const at = input.at ?? Date.now();
  const row = db.prepare(`SELECT * FROM frontend_presence_observations
    WHERE world_id=? AND binding_id=? AND (?=0 OR evidence_class='ROUTE_VERIFIED')
      AND (?=0 OR evidence_class IN ('TRANSPORT_POLL','ROUTE_VERIFIED')) ORDER BY observed_at DESC, rowid DESC LIMIT 1`)
    .get(input.worldId, input.bindingId, input.verifiedOnly?1:0,input.productionOnly?1:0) as Record<string, unknown> | undefined;
  if (!row) return { state: "UNKNOWN", evidenceClass: null, observedAt: null, freshUntil: null,
    evidenceRef: null, method: null, ageMs: null, requiresHumanAction: false };
  const observedAt = String(row.observed_at), freshUntil = String(row.fresh_until);
  const age = at - Date.parse(observedAt);
  return { state: Date.parse(freshUntil) > at ? "LIVE" : "STALE",
    evidenceClass: String(row.evidence_class) as PresenceEvidence,
    observedAt, freshUntil, evidenceRef: String(row.evidence_ref), method: String(row.method),
    ageMs: age, requiresHumanAction: false };
}

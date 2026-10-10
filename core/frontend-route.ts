import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import type { EffectControlProfile } from "./effect-gate.ts";

/**
 * Outbound route preparation. This is deliberately NOT a delivery claim.
 *
 * Four different things were previously collapsed into one `ready` boolean:
 *   1. transport health      - the local tunnel answers and authenticates
 *   2. frontend Presence     - an exact Human Chat was actually reached
 *   3. outbound route        - a declared backend is selected and has a control
 *                              profile, so a governed send is *possible*
 *   4. delivery of a message - a specific message was actually accepted/observed
 *
 * Only (1) can be inferred from a local health poll. (2) needs real inbound or
 * route evidence. (3) is a prepared selection with a declared profile. (4) needs
 * per-message evidence. They are recorded and reported separately.
 *
 * Production preparation and delivery exclude UI routes entirely. The historical
 * enum remains readable; it cannot make browser automation production-eligible.
 */
export interface RouteCandidate {
  routeId: string;
  routeClass: "native" | "protocol" | "ui-fallback";
  supportsSend: boolean;
  controlProfile?: EffectControlProfile;
  /** Declared, non-negotiable requirement this route needs to be usable. */
  requirement?: string | null;
  requirementSatisfied?: boolean;
}
export const ROUTE_RANK: Record<RouteCandidate["routeClass"], number> = { native: 0, protocol: 1, "ui-fallback": 2 };
/** A profile declared by a route that cannot govern a send is not a profile. */
export function selectRoute(candidates: RouteCandidate[]): RouteCandidate | null {
  const usable = candidates.filter(c =>
    c.routeClass!=="ui-fallback" && c.supportsSend && c.controlProfile && (c.requirementSatisfied ?? !c.requirement));
  if (!usable.length) return null;
  return [...usable].sort((a, b) => ROUTE_RANK[a.routeClass] - ROUTE_RANK[b.routeClass]
    || a.routeId.localeCompare(b.routeId))[0]!;
}
export function migrateFrontendRoutes(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frontend_route_preparations (
      preparation_id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      binding_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      route_id TEXT NOT NULL,
      route_class TEXT NOT NULL CHECK (route_class IN ('native','protocol','ui-fallback')),
      control_profile_id TEXT NOT NULL,
      control_profile_json TEXT NOT NULL,
      requirement TEXT,
      evidence_ref TEXT NOT NULL,
      method TEXT NOT NULL,
      prepared_at TEXT NOT NULL,
      invalid_after TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS route_by_binding ON frontend_route_preparations(world_id, binding_id, prepared_at);
    CREATE TRIGGER IF NOT EXISTS route_append_only_update BEFORE UPDATE ON frontend_route_preparations
      BEGIN SELECT RAISE(ABORT,'Route preparations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS route_append_only_delete BEFORE DELETE ON frontend_route_preparations
      BEGIN SELECT RAISE(ABORT,'Route preparations are append-only'); END;
    CREATE TABLE IF NOT EXISTS frontend_route_invalidations (
      invalidation_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      preparation_id TEXT NOT NULL REFERENCES frontend_route_preparations(preparation_id),
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}
export function recordFrontendRoute(db: DatabaseSync, input: {
  worldId: string; bindingId: string; conversationRef: string; candidate: RouteCandidate;
  evidenceRef: string; method: string; preparedAt?: string; ttlMs?: number;
}): string {
  const { candidate } = input;
  if (!candidate.controlProfile) throw new SideraError("conflict", "A route without a control profile cannot be prepared");
  if (!input.evidenceRef?.trim() || !input.method?.trim()) throw new SideraError("conflict", "Route preparation needs a source and a method");
  const preparedAt = input.preparedAt ?? new Date().toISOString();
  const at = Date.parse(preparedAt);
  const invalidAfter = new Date(at + (input.ttlMs ?? 15 * 60_000)).toISOString();
  const id = randomUUID();
  return withTransaction(db, "route_record", () => {
    db.prepare("INSERT INTO frontend_route_preparations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.worldId, input.bindingId, input.conversationRef, candidate.routeId, candidate.routeClass,
        candidate.controlProfile!.id, JSON.stringify(candidate.controlProfile),
        candidate.requirement ?? null, input.evidenceRef, input.method, preparedAt, invalidAfter);
    return id;
  });
}
export interface RouteState {
  state: "USABLE" | "STALE" | "UNKNOWN";
  routeId: string | null; routeClass: string | null;
  controlProfile: EffectControlProfile | null;
  preparedAt: string | null; invalidAfter: string | null;
  evidenceRef: string | null; method: string | null; ageMs: number | null;
}
export function latestFrontendRoute(db: DatabaseSync, input: {
  worldId: string; bindingId: string; at?: number;
}): RouteState {
  const at = input.at ?? Date.now();
  const row = db.prepare(`SELECT * FROM frontend_route_preparations WHERE world_id=? AND binding_id=?
    ORDER BY prepared_at DESC,rowid DESC LIMIT 1`).get(input.worldId, input.bindingId) as Record<string, unknown> | undefined;
  if (!row) return { state: "UNKNOWN", routeId: null, routeClass: null, controlProfile: null,
    preparedAt: null, invalidAfter: null, evidenceRef: null, method: null, ageMs: null };
  const invalidAfter = String(row.invalid_after);
  return {
    state: Date.parse(invalidAfter) > at && !db.prepare("SELECT 1 FROM frontend_route_invalidations WHERE preparation_id=?").get(String(row.preparation_id)) ? "USABLE" : "STALE",
    routeId: String(row.route_id), routeClass: String(row.route_class),
    controlProfile: JSON.parse(String(row.control_profile_json)) as EffectControlProfile,
    preparedAt: String(row.prepared_at), invalidAfter,
    evidenceRef: String(row.evidence_ref), method: String(row.method),
    ageMs: at - Date.parse(String(row.prepared_at)),
  };
}
/** Invalidates a stale preparation without deleting history. */
export function invalidateFrontendRoute(db: DatabaseSync, input: { worldId: string; bindingId: string; reason: string }): void {
  if (!input.reason?.trim()) throw new SideraError("conflict", "Invalidation needs a reason");
  withTransaction(db, "route_invalidate", () => {
    const row = db.prepare(`SELECT preparation_id FROM frontend_route_preparations
      WHERE world_id=? AND binding_id=? ORDER BY prepared_at DESC,rowid DESC LIMIT 1`)
      .get(input.worldId, input.bindingId) as { preparation_id: string } | undefined;
    if (!row) return;
    // Retain preparation evidence; append an invalidation instead of updating
    // the immutable preparation row.
    db.prepare("INSERT INTO frontend_route_invalidations VALUES (?,?,?,?,?,?)")
      .run(randomUUID(),input.worldId,input.bindingId,row.preparation_id,input.reason,new Date().toISOString());
  });
}

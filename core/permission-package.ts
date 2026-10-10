import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { canonical, consumeHumanAct, type HumanActProof } from "./human-admission.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { consumePackageItem, PACKAGE_ACT_TYPE, type PackageActArgs } from "./package-proof.ts";
import { getGrant, issueGrant } from "./authority.ts";

/**
 * Permission Package = one Human review of a bounded, immutable manifest.
 *
 * Product intent: a Human approves a *work package* once, instead of clicking
 * ADMIT for every fine-grained capability. That changes the product grain of
 * Human approval; it does not change what Authority is.
 *
 * Hard properties:
 *  - the package is not an Authority source; every item becomes an ordinary grant
 *  - every grant stays Human-rooted, independently traceable and revocable
 *  - nothing here bypasses the final effect-time gate
 *  - v1 Authority delegation stays DISABLED: every item is non-delegable
 *  - materialization is all-or-nothing; a partial package is never reported as approved
 */
export interface PermissionPackageGrant {
  requestId: string;
  subjectNodeId: string;
  capability: string;
  resourceScope: string;
  delegable?: boolean;
  productScope?: string;
  effectScope?: "admission" | "post_admission_revocable";
  disclosureScope?: string;
  expiresAt?: string | null;
  limit?: number | null;
  riskCeiling?: number | null;
}
export interface PermissionPackageItem { purpose: string; grant: PermissionPackageGrant }
export interface PermissionPackageManifest {
  version: 1; worldId: string; packageId: string; revision: number; label: string;
  items: PermissionPackageItem[];
}

/** Stable identity for the exact reviewed content. Any field change moves it. */
export function packageDigest(manifest: Omit<PermissionPackageManifest, "revision"> & { revision?: number }): string {
  return createHash("sha256").update(canonical({
    version: 1, worldId: manifest.worldId, packageId: manifest.packageId,
    items: manifest.items,
  })).digest("hex");
}
function normalize(manifest: PermissionPackageManifest): PermissionPackageManifest {
  const items = manifest.items.map((item, index) => {
    if (!item?.purpose?.trim()) throw new SideraError("conflict", "Every package item needs a stated purpose");
    const grant = item.grant;
    if (!grant?.subjectNodeId || !grant?.capability || !grant?.resourceScope)
      throw new SideraError("conflict", "Every package item needs subject, capability and resource scope");
    return { purpose: item.purpose.trim(), grant: {
      ...grant,
      // Deterministic idempotency key derived from package identity, never from
      // the caller: re-preparing the same package must yield the same digest and
      // the same request ids, so review and re-verification are stable.
      requestId: `pkg:${manifest.packageId}:r${manifest.revision}:i${index}`,
      // v1: a package can never enable Authority delegation or scope wildcards
      // beyond what the Human literally reviewed.
      delegable: false,
      productScope: grant.productScope ?? "*",
      effectScope: grant.effectScope ?? "admission",
      disclosureScope: grant.disclosureScope ?? "UNKNOWN",
      expiresAt: grant.expiresAt ?? null,
      limit: grant.limit ?? null,
      riskCeiling: grant.riskCeiling ?? null,
    } };
  });
  return { ...manifest, items };
}
export function preparePermissionPackage(input: {
  worldId: string; packageId: string; label: string; revision?: number; items: PermissionPackageItem[];
}): PermissionPackageManifest {
  if (!input.packageId.trim() || !input.label.trim()) throw new SideraError("conflict", "Package needs an id and a label");
  const manifest = normalize({ version: 1, worldId: input.worldId, packageId: input.packageId,
    revision: input.revision ?? 1, label: input.label.trim(), items: input.items });
  if (!manifest.items.length) throw new SideraError("conflict", "An empty package is not approvable");
  return manifest;
}
/** The exact bytes a Human reviews and approves. Digest is over items only, so
 *  re-wording the label cannot silently change what was authorized. */
export function packageActArgs(manifest: PermissionPackageManifest): PackageActArgs {
  return { packageId: manifest.packageId, revision: manifest.revision,
    digest: packageDigest(manifest), worldId: manifest.worldId, label: manifest.label,
    items: manifest.items as unknown as PackageActArgs["items"] };
}
export function packageActScope(manifest: { packageId: string }): string { return `package/${manifest.packageId}`; }

/** Marks the package act applied. Must be called once, with the Human's admitted act. */
export function applyPermissionPackage(db: DatabaseSync, proof: HumanActProof,
  manifest: PermissionPackageManifest): string {
  const worldId = recordWorld(db, "nodes", manifest.items[0]!.grant.subjectNodeId);
  if (worldId !== manifest.worldId) throw new SideraError("denied", "Package World does not match its subjects");
  return consumeHumanAct(db, proof, worldId, PACKAGE_ACT_TYPE, manifest.packageId,
    packageActScope(manifest), packageActArgs(manifest));
}

/**
 * All-or-nothing. Items are issued inside one transaction: if any item fails,
 * nothing is committed and the caller must report the package as NOT established
 * rather than partially approved.
 */
export function materializePermissionPackage(db: DatabaseSync, input: {
  worldId: string; humanId: string; packageActId: string;
}): { packageId: string; grants: Array<{ capability: string; resourceScope: string; grantId: string }>; complete: true } {
  return withTransaction(db, "package_materialize", () => {
    const act = db.prepare(`SELECT args_json FROM human_semantic_acts WHERE act_id=? AND world_id=? AND human_id=? AND act_type=?`)
      .get(input.packageActId, input.worldId, input.humanId, PACKAGE_ACT_TYPE) as { args_json: string } | undefined;
    if (!act) throw new SideraError("denied", "Admitted Permission Package act required");
    const args = JSON.parse(act.args_json) as PackageActArgs;
    const proof: HumanActProof = { id: input.humanId, packageActId: input.packageActId };
    const grants: Array<{ capability: string; resourceScope: string; grantId: string }> = [];
    for (const item of args.items) {
      const grant = issueGrant(db, { kind: "human", ...proof }, item.grant as never);
      grants.push({ capability: grant.capability, resourceScope: grant.resourceScope, grantId: grant.grantId });
    }
    return { packageId: args.packageId, grants, complete: true as const };
  });
}
export function packageStatus(db: DatabaseSync, worldId: string, packageId: string) {
  const act = db.prepare(`SELECT * FROM human_semantic_acts WHERE world_id=? AND act_type=? AND object_ref=? ORDER BY recorded_at DESC LIMIT 1`)
    .get(worldId, PACKAGE_ACT_TYPE, packageId) as Record<string, unknown> | undefined;
  if (!act) return { packageId, state: "NOT_ADMITTED" as const };
  const applied = Boolean(db.prepare("SELECT 1 FROM human_act_applications WHERE act_id=?").get(String(act.act_id)));
  const args = JSON.parse(String(act.args_json)) as PackageActArgs;
  const rows = db.prepare(`SELECT g.grant_id,g.subject_node_id,g.capability,g.resource_scope,g.revoked_at,g.expires_at
    FROM grant_provenance p JOIN grants g USING(grant_id) WHERE p.human_act_id=?`).all(String(act.act_id)) as
    Array<{ grant_id: string; subject_node_id: string; capability: string; resource_scope: string; revoked_at: string | null; expires_at: string | null }>;
  return { packageId, actId: String(act.act_id), digest: args.digest, revision: args.revision,
    label: args.label, state: applied ? "ADMITTED" as const : "RECORDED_NOT_APPLIED" as const,
    itemCount: args.items.length, materialized: rows.length,
    complete: rows.length === args.items.length && applied,
    grants: rows };
}
export const PACKAGE_REVOKE_ACT_TYPE = "authority.revoke_package";
/** Args of the single Human act that ends a package. */
export function packageRevokeActArgs(input: { packageActId: string; requestId: string; reason: string }) {
  return { packageActId: input.packageActId, requestId: input.requestId, reason: input.reason };
}
/**
 * Ending a package is an Authority change, so it needs its own admitted Human
 * act — but ONE act covers the whole package, mirroring how one act established
 * it. Revocation never deletes history; it only stops future effects.
 */
export function revokePermissionPackage(db: DatabaseSync, input: {
  worldId: string; humanId: string; packageActId: string; revokeActId: string;
  requestId: string; reason: string;
}): { revoked: string[]; packageId: string } {
  if (!input.reason?.trim()) throw new SideraError("conflict", "A package revocation needs a stated reason");
  return withTransaction(db, "package_revoke", () => {
    const target = db.prepare("SELECT args_json FROM human_semantic_acts WHERE act_id=? AND world_id=? AND human_id=? AND act_type=?")
      .get(input.packageActId, input.worldId, input.humanId, PACKAGE_ACT_TYPE) as { args_json: string } | undefined;
    if (!target) throw new SideraError("denied", "Unknown Permission Package act");
    const packageId = (JSON.parse(target.args_json) as PackageActArgs).packageId;
    // One Human act authorizes revoking this exact package.
    consumeHumanAct(db, { id: input.humanId, actId: input.revokeActId }, input.worldId,
      PACKAGE_REVOKE_ACT_TYPE, input.packageActId, packageActScope({ packageId }),
      packageRevokeActArgs({ packageActId: input.packageActId, requestId: input.requestId, reason: input.reason }));
    const rows = db.prepare(`SELECT p.grant_id FROM grant_provenance p JOIN grants g USING(grant_id)
      WHERE p.human_act_id=? AND g.revoked_at IS NULL`).all(input.packageActId) as Array<{ grant_id: string }>;
    const at = new Date().toISOString();
    for (const row of rows)
      db.prepare("UPDATE grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL").run(at, row.grant_id);
    return { revoked: rows.map(r => r.grant_id), packageId };
  });
}
/** Structural diff between two revisions of the same package. */
export function packageDiff(before: PermissionPackageItem[], after: PermissionPackageItem[]) {
  const key = (item: PermissionPackageItem) => canonical(item.grant);
  const b = new Map(before.map(i => [key(i), i])), a = new Map(after.map(i => [key(i), i]));
  return {
    added: after.filter(i => !b.has(key(i))),
    removed: before.filter(i => !a.has(key(i))),
    unchanged: after.filter(i => b.has(key(i))),
  };
}
export { consumePackageItem };
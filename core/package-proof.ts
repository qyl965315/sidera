import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";
import { canonical, type HumanActProof } from "./human-admission.ts";

/**
 * A Permission Package is NOT an Authority source. It is an immutable manifest
 * whose exact items a Human reviewed once. Each item still materializes into an
 * ordinary, independently traceable, independently revocable, non-delegable
 * grant that must pass the final effect-time gate on its own.
 *
 * This module only answers one question: "was this exact grant item inside an
 * approved, still-current package manifest?" It grants nothing by itself.
 */
export const PACKAGE_ACT_TYPE = "authority.grant_package";

export interface PackageActArgs {
  packageId: string;
  revision: number;
  digest: string;
  worldId: string;
  label: string;
  items: Array<{ purpose: string; grant: Record<string, unknown> }>;
}

export function consumePackageItem(
  db: DatabaseSync, proof: HumanActProof, worldId: string, grantInput: unknown,
): string {
  const act = db.prepare(`SELECT * FROM human_semantic_acts WHERE act_id=? AND world_id=? AND human_id=?`)
    .get(proof.packageActId ?? "", worldId, proof.id) as Record<string, unknown> | undefined;
  if (!act || act.act_type !== PACKAGE_ACT_TYPE)
    throw new SideraError("denied", "Exact admitted Permission Package act required");
  const applied = db.prepare("SELECT 1 FROM human_act_applications WHERE act_id=?").get(String(act.act_id));
  if (!applied) throw new SideraError("denied", "Permission Package act was never applied");
  const policy = db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(worldId) as { epoch: number };
  if (Number(act.policy_epoch) !== policy.epoch)
    throw new SideraError("denied", "Permission Package policy is obsolete; re-approval required");
  let args: PackageActArgs;
  try { args = JSON.parse(String(act.args_json)) as PackageActArgs; }
  catch { throw new SideraError("denied", "Permission Package manifest is unreadable"); }
  const wanted = canonical(grantInput);
  // Exact item match only. No prefix, pattern, wildcard or fuzzy containment.
  if (!args.items.some(item => canonical(item.grant) === wanted))
    throw new SideraError("denied", "Grant item is not in the approved Permission Package manifest");
  return String(act.act_id);
}
/**
 * Human-run Permission Package console.
 *
 * The product point: the Human reviews ONE bounded manifest and approves it
 * once. Ordinary work inside it then never asks the Human again. Approval grain
 * moves from "one capability" to "one work package"; Authority itself does not
 * change. Not reachable from any Node RPC or MCP tool.
 *
 *   plan        read-only; prints exactly what is missing and its digest
 *   approve     Human-run; records ONE admitted act for the whole manifest
 *   materialize issues every grant in the manifest
 *   status      prints package state and every grant it established
 *   revoke      Human-run; ends the package with one Human act
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { openDatabase } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { canonical, openHumanIngress, explicitHumanStatement, admitHumanAct } from "../core/human-admission.ts";
import { humanRootedFor } from "../core/activation.ts";
import { applyPermissionPackage, materializePermissionPackage, packageActArgs, packageDigest,
  packageStatus, packageRevokeActArgs, preparePermissionPackage, revokePermissionPackage,
  type PermissionPackageItem } from "../core/permission-package.ts";

const root = resolve(import.meta.dirname, "..");
const dataDir = arg("data-dir") ?? join(root, ".sidera-dev", "sol", "data");
const dbPath = arg("db") ?? join(dataDir, "sidera.sqlite");
const evidence = arg("evidence") ?? join(root, ".sidera-dev", "chat-agent-cooperation", "current");
const PACKAGE_ID = "r0-chat-agent-cooperation";
const REVISION = 1;
// Legacy exclusion, if needed for recovery, must be supplied explicitly.
const LEGACY_DSH = arg('exclude-node');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
interface Spec { version: number; chiefNodeId: string; nodes: Array<{ nodeId: string; displayName: string }>; }
function loadSpec(): Spec {
  const spec = JSON.parse(readFileSync(join(dataDir, "runtime-spec.json"), "utf8")) as Spec;
  if (spec.version !== 1 || !spec.chiefNodeId) throw new Error("Human-owned RuntimeSpec v1 required");
  return spec;
}
/** Exactly the Authority the R0 cooperation loop needs. Nothing wildcard-wide. */
function candidates(): PermissionPackageItem[] {
  const spec = loadSpec();
  const agents = spec.nodes.filter(n => n.nodeId !== spec.chiefNodeId && n.nodeId !== LEGACY_DSH).map(n => n.nodeId);
  const items: PermissionPackageItem[] = [];
  const add = (purpose: string, g: Record<string, unknown>) => items.push({
    purpose, grant: { delegable: false, productScope: "*", effectScope: "admission",
      disclosureScope: "handoff_bounded", ...g } as never });
  // --- supervising Chat (the Human's own Chat Node) ---
  add("Chat may return a result to its own Human Chat Presence",
    { subjectNodeId: spec.chiefNodeId, capability: "message.send", resourceScope: `node/${spec.chiefNodeId}` });
  add("Chat may observe effect/uncertainty status while supervising",
    { subjectNodeId: spec.chiefNodeId, capability: "effects.inspect", resourceScope: "session/**" });
  add("Chat may reconcile an uncertain effect in its own supervision",
    { subjectNodeId: spec.chiefNodeId, capability: "effects.reconcile", resourceScope: "session/**" });
  for (const agent of agents) {
    add(`Chat may send supervision/repair work to ${agent}`,
      { subjectNodeId: spec.chiefNodeId, capability: "message.send", resourceScope: `node/${agent}` });
    add(`Chat may open a bounded child Responsibility on ${agent}`,
      { subjectNodeId: spec.chiefNodeId, capability: "responsibility.create", resourceScope: `node/${agent}` });
    add(`Chat may appoint a duty role on ${agent}`,
      { subjectNodeId: spec.chiefNodeId, capability: "role.appoint", resourceScope: `node/${agent}` });
    // --- each Agent ---
    add(`${agent} may return its result to the supervising Chat`,
      { subjectNodeId: agent, capability: "message.send", resourceScope: `node/${spec.chiefNodeId}` });
    add(`${agent} may reconcile its own uncertain result`,
      { subjectNodeId: agent, capability: "effects.reconcile", resourceScope: "session/**" });
    add(`${agent} may observe its own execution/effect status`,
      { subjectNodeId: agent, capability: "effects.inspect", resourceScope: "session/**" });
  }
  return items;
}
/** Only what is genuinely missing: never re-authorize what is already effective. */
function missingItems(db: ReturnType<typeof openDatabase>, worldId: string) {
  return candidates().map(item => ({ item }))
    .filter(({ item }) => !humanRootedFor(db, String(item.grant.subjectNodeId), worldId, {
      capability: String(item.grant.capability), resource: String(item.grant.resourceScope) }))
    .map(({ item }) => item);
}
function planPath(): string { return join(evidence, "permission-package.json"); }

const command = process.argv[2] ?? "plan";
if (command === "plan") {
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const worldId = recordWorld(db, "nodes", spec.chiefNodeId);
  const items = missingItems(db, worldId);
  const manifest = preparePermissionPackage({ worldId, packageId: PACKAGE_ID, revision: REVISION,
    label: "R0 Chat-Agent cooperation", items });
  mkdirSync(evidence, { recursive: true });
  const payload = { preparedAt: new Date().toISOString(),
    localTime: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }) + "+08:00",
    worldId, packageId: PACKAGE_ID, revision: REVISION, digest: packageDigest(manifest),
    missingCount: items.length, manifest };
  writeFileSync(planPath(), JSON.stringify(payload, null, 2));
  process.stdout.write(`World      ${worldId}\nPackage    ${PACKAGE_ID} r${REVISION}\nDigest     ${payload.digest}\n`);
  process.stdout.write(`Missing    ${items.length} grant(s) - everything else is already effective\n\n`);
  for (const item of items) {
    const g = item.grant as unknown as Record<string, unknown>;
    process.stdout.write(`  ${String(g.subjectNodeId).slice(0, 8)}  ${String(g.capability).padEnd(22)} ${String(g.resourceScope)}\n    ${item.purpose}\n`);
  }
  process.stdout.write(`\nReview file: ${planPath()}\n`);
  db.close();
} else if (command === "approve") {
  if (!process.stdin.isTTY) throw new Error("Human approval requires an interactive terminal; refusing non-interactive admission");
  const plan = JSON.parse(readFileSync(planPath(), "utf8")) as { manifest: ReturnType<typeof preparePermissionPackage>; digest: string };
  const manifest = preparePermissionPackage(plan.manifest as never);
  if (packageDigest(manifest) !== plan.digest) throw new Error("Manifest changed since review; re-run plan and review again");
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const worldId = recordWorld(db, "nodes", spec.chiefNodeId);
  const human = (db.prepare("SELECT human_id FROM world_humans WHERE world_id=? ORDER BY human_id LIMIT 1").get(worldId) as { human_id: string } | undefined)?.human_id;
  if (!human) throw new Error("No Human principal in this World; complete onboarding first");
  const proposal = { type: "authority.grant_package", objectRef: manifest.packageId, scope: `package/${manifest.packageId}`,
    targetRevision: null, args: packageActArgs(manifest) as unknown as Record<string, unknown>,
    causalRefs: ["human:local-operator-terminal"] };
  const body = explicitHumanStatement(proposal as never);
  const digestOfReviewed = createHash("sha256").update(body).digest("hex");
  process.stdout.write(`\nYou are approving ${manifest.items.length} grant(s) as ONE bounded package.\n`);
  process.stdout.write(`Package digest : ${plan.digest}\nStatement digest: ${digestOfReviewed}\n`);
  process.stdout.write("Type ADMIT to record this exact approval, anything else aborts: ");
  const answer = String(await new Promise<string>(d => process.stdin.once("data", v => d(String(v))))).trim().toUpperCase();
  if (answer !== "ADMIT") { process.stdout.write("Aborted; no package was approved.\n"); db.close(); }
  else {
    const source = openHumanIngress(db, { worldId, humanId: human,
      presenceRef: `local-terminal:${process.env.COMPUTERNAME ?? "host"}`,
      sourceRef: `human-operator-terminal:${new Date().toISOString().slice(0, 10)}` });
    const utteranceId = source.capture(`pkg:${manifest.packageId}:r${manifest.revision}:${plan.digest.slice(0, 16)}`, body);
    const proof = admitHumanAct(db, { worldId, humanId: human, utteranceId, proposal: proposal as never });
    applyPermissionPackage(db, proof, manifest);
    writeFileSync(join(evidence, "permission-package-approval.json"),
      JSON.stringify({ approvedAt: new Date().toISOString(), worldId, humanId: human,
        packageId: manifest.packageId, revision: manifest.revision, digest: plan.digest,
        actId: proof.actId, itemCount: manifest.items.length, humanApprovals: 1 }, null, 2));
    process.stdout.write(`Approved. ONE Human act ${proof.actId} now covers all ${manifest.items.length} grants.\nRun: materialize\n`);
    db.close();
  }
} else if (command === "materialize") {
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const worldId = recordWorld(db, "nodes", spec.chiefNodeId);
  const approval = JSON.parse(readFileSync(join(evidence, "permission-package-approval.json"), "utf8")) as { actId: string; humanId: string };
  const result = materializePermissionPackage(db, { worldId, humanId: approval.humanId, packageActId: approval.actId });
  writeFileSync(join(evidence, "permission-package-materialized.json"), JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2));
  process.stdout.write(`Materialized ${result.grants.length} grant(s); complete=${result.complete}\n`);
  db.close();
} else if (command === "status") {
  const db = openDatabase(dbPath);
  const worldId = recordWorld(db, "nodes", loadSpec().chiefNodeId);
  process.stdout.write(`${JSON.stringify(packageStatus(db, worldId, PACKAGE_ID), null, 2)}\n`);
  db.close();
} else if (command === "revoke") {
  if (!process.stdin.isTTY) throw new Error("Human revocation requires an interactive terminal");
  const reason = arg("reason") ?? "";
  if (!reason.trim()) throw new Error("A package revocation needs --reason");
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const worldId = recordWorld(db, "nodes", spec.chiefNodeId);
  const human = (db.prepare("SELECT human_id FROM world_humans WHERE world_id=? ORDER BY human_id LIMIT 1").get(worldId) as { human_id: string } | undefined)?.human_id;
  if (!human) throw new Error("No Human principal in this World");
  const approval = JSON.parse(readFileSync(join(evidence, "permission-package-approval.json"), "utf8")) as { actId: string };
  const requestId = `revoke:${approval.actId}`;
  const revokeProposal = { type: "authority.revoke_package", objectRef: approval.actId, scope: `package/${PACKAGE_ID}`,
    targetRevision: null, args: packageRevokeActArgs({ packageActId: approval.actId, requestId, reason }) as unknown as Record<string, unknown>,
    causalRefs: ["human:local-operator-terminal"] };
  const source = openHumanIngress(db, { worldId, humanId: human,
    presenceRef: `local-terminal:${process.env.COMPUTERNAME ?? "host"}`, sourceRef: `human-operator-terminal:${new Date().toISOString().slice(0, 10)}` });
  const utteranceId = source.capture(`pkg-revoke:${PACKAGE_ID}:${requestId}`, explicitHumanStatement(revokeProposal as never));
  const proof = admitHumanAct(db, { worldId, humanId: human, utteranceId, proposal: revokeProposal as never });
  const { revoked, packageId } = revokePermissionPackage(db, { worldId, humanId: human,
    packageActId: approval.actId, revokeActId: proof.actId!, requestId, reason });
  writeFileSync(join(evidence, "revocation-evidence.json"), JSON.stringify({ at: new Date().toISOString(), requestId, reason, packageId, revoked }, null, 2));
  process.stdout.write(`Revoked ${revoked.length} grant(s) from ${packageId}.\n`);
  db.close();
} else if (command === "verify-plan") {
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const worldId = recordWorld(db, "nodes", spec.chiefNodeId);
  const plan = JSON.parse(readFileSync(planPath(), "utf8")) as { digest: string; manifest: unknown };
  const manifest = preparePermissionPackage(plan.manifest as never);
  process.stdout.write(`planDigest=${plan.digest}\nrecomputed=${packageDigest(manifest)}\nstable=${packageDigest(manifest) === plan.digest}\n`);
  process.stdout.write(`stillMissing=${missingItems(db, worldId).length}\n`);
  void canonical;
  db.close();
} else { throw new Error(`Unknown subcommand: ${command}`); }

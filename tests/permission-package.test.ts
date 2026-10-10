import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../core/db.ts";
import { createWorld, recordWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { admitHumanAct, explicitHumanStatement, openHumanIngress, canonical } from "../core/human-admission.ts";
import { effectiveHumanRoot, getGrant, revokeGrant, canUseCapability, issueGrant } from "../core/authority.ts";
import { applyPermissionPackage, materializePermissionPackage, packageActArgs, packageDigest,
  preparePermissionPackage, revokePermissionPackage, packageRevokeActArgs, packageDiff, packageStatus,
  type PermissionPackageItem } from "../core/permission-package.ts";

/**
 * A Permission Package raises the *product grain* of Human approval from one
 * capability to one bounded work package. It must not change what Authority is:
 * every item is still an ordinary, independently revocable, non-delegable,
 * Human-rooted grant that must pass the final effect-time gate.
 */
function fixture(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => { if (db.isOpen) db.close(); });
  const world = createWorld(db, "Package fixture World", "package fixture only");
  const store = new SemanticStore(db, world);
  const human = store.createHuman("Fixture Human", "package fixture principal");
  const chat = store.registerNode("Chat"), agentA = store.registerNode("Agent A"), agentB = store.registerNode("Agent B");
  for (const [id, node] of [["chat", chat], ["a", agentA], ["b", agentB]] as const)
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(`${id}-session`, node, `mock://${node}`);
  const ingress = openHumanIngress(db, { worldId: world, humanId: human,
    presenceRef: "fixture:operator-terminal", sourceRef: "fixture:package-review" });
  const grant = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(), subjectNodeId: chat, capability: "task.dispatch",
    resourceScope: `node/${agentA}`, delegable: false, productScope: "*",
    effectScope: "admission" as const, disclosureScope: "handoff_bounded", ...over });
  const items = (): PermissionPackageItem[] => [
    { purpose: "Chat may dispatch bounded work to Agent A", grant: grant() },
    { purpose: "Agent A may return its result to the supervising Chat",
      grant: grant({ subjectNodeId: agentA, capability: "message.send", resourceScope: `node/${chat}` }) },
    { purpose: "Chat may send the outcome back to its own Human Chat Presence",
      grant: grant({ subjectNodeId: chat, capability: "message.send", resourceScope: `node/${chat}` }) },
  ];
  /** One Human review, one act, whole manifest. */
  const approve = (manifest: ReturnType<typeof preparePermissionPackage>) => {
    const proposal = { type: "authority.grant_package", objectRef: manifest.packageId,
      scope: `package/${manifest.packageId}`, targetRevision: null,
      args: packageActArgs(manifest) as unknown as Record<string, unknown>, causalRefs: ["fixture:human-reviewed-package"] };
    const utteranceId = ingress.capture(`pkg:${manifest.packageId}:${manifest.revision}`, explicitHumanStatement(proposal));
    const proof = admitHumanAct(db, { worldId: world, humanId: human, utteranceId, proposal });
    applyPermissionPackage(db, proof, manifest);
    return proof;
  };
  /** Any single Human act, captured and admitted with exact provenance. */
  const admitAct = (proposal: Record<string, unknown>, messageId: string) => {
    const utteranceId = ingress.capture(messageId, explicitHumanStatement(proposal as never));
    return admitHumanAct(db, { worldId: world, humanId: human, utteranceId, proposal: proposal as never });
  };
  return { db, world, store, human, chat, agentA, agentB, ingress, grant, items, approve, admitAct };
}

test("PP-T01 manifest identity is stable and any field change moves the digest", t => {
  const f = fixture(t);
  const a = preparePermissionPackage({ worldId: f.world, packageId: "pkg", label: "R0", items: f.items() });
  const b = preparePermissionPackage({ worldId: f.world, packageId: "pkg", label: "R0", items: f.items() });
  assert.equal(packageDigest(a), packageDigest(b), "same items => same digest");
  // Re-wording the label is not a permission change.
  assert.equal(packageDigest({ ...a, label: "different label" }), packageDigest(a));
  const widened = f.items();
  widened[0]!.grant.resourceScope = `node/${f.agentB}`;
  assert.notEqual(packageDigest(preparePermissionPackage({ worldId: f.world, packageId: "pkg", label: "R0", items: widened })), packageDigest(a));
});

test("PP-T02 one Human act establishes the whole package", t => {
  const f = fixture(t);
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-one", label: "R0", items: f.items() });
  const before = f.db.prepare("SELECT COUNT(*) AS n FROM human_semantic_acts").get() as { n: number };
  const proof = f.approve(manifest);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM human_semantic_acts").get() as { n: number }).n, before.n + 1,
    "exactly one Human act covers the whole package");
  const result = materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! });
  assert.equal(result.complete, true);
  assert.equal(result.grants.length, 3);
  // Every materialized grant is an ordinary independently Human-rooted grant.
  for (const g of result.grants) {
    const record = getGrant(f.db, g.grantId)!;
    assert.equal(effectiveHumanRoot(f.db, record), true, `${g.capability} must remain Human-rooted`);
    assert.equal(record.delegable, false, "v1 keeps delegation disabled");
    assert.equal((f.db.prepare("SELECT human_act_id FROM grant_provenance WHERE grant_id=?").get(g.grantId) as { human_act_id: string }).human_act_id,
      proof.actId, "provenance points at the single reviewed act");
  }
  const status = packageStatus(f.db, f.world, "pkg-one");
  assert.equal(status.state, "ADMITTED");
  assert.equal(status.materialized, 3);
  assert.equal(status.complete, true);
});

test("PP-T03 a grant outside the manifest is refused even with a valid package act", t => {
  const f = fixture(t);
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-scope", label: "R0", items: f.items() });
  const proof = f.approve(manifest);
  materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! });
  // Same package act, but an item nobody reviewed.

  assert.throws(() => issueGrant(f.db, { kind: "human", id: f.human, packageActId: proof.actId! },
    { subjectNodeId: f.chat, capability: "task.dispatch", resourceScope: `node/${f.agentB}`, delegable: false,
      productScope: "*", effectScope: "admission", disclosureScope: "handoff_bounded" } as never),
    { code: "denied" }, "a widened target is not in the reviewed manifest");
});

test("PP-T04 materialization is all-or-nothing (fail closed)", t => {
  const f = fixture(t);
  const broken = f.items();
  // A genuinely invalid item: the subject Node does not exist, so this grant can never be established.
  broken.push({ purpose: "Names a subject Node that does not exist", grant: f.grant({ subjectNodeId: randomUUID(), resourceScope: `node/${f.agentB}` }) });
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-broken", label: "R0", items: broken });
  const proof = f.approve(manifest);
  const grantsBefore = (f.db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
  assert.throws(() => materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! }));
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, grantsBefore,
    "a partial package must leave no grants behind");
  const status = packageStatus(f.db, f.world, "pkg-broken");
  assert.equal(status.materialized, 0);
  assert.equal(status.complete, false, "never report a half-built package as approved");
});

test("PP-T05 the package is not an effect-gate bypass", t => {
  const f = fixture(t);
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-gate", label: "R0", items: f.items() });
  const proof = f.approve(manifest);
  materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! });
  // In-scope authority is usable...
  assert.equal(canUseCapability(f.db, { subjectNodeId: f.chat, sessionId: "chat-session",
    capability: "task.dispatch", resource: `node/${f.agentA}`, requestId: "r1" }), true);
  // ...and is still revoked independently at the moment of revocation.
  const grants = f.db.prepare(`SELECT grant_id FROM grant_provenance p JOIN grants g USING(grant_id)
    WHERE p.human_act_id=? AND g.capability='task.dispatch'`).all(proof.actId!) as { grant_id: string }[];
  const target = getGrant(f.db, grants[0]!.grant_id)!;
  const revokeRequestId = randomUUID();
  const revokeAct = f.admitAct({ type: "authority.revoke", objectRef: target.grantId,
    scope: target.resourceScope, targetRevision: null,
    args: { requestId: revokeRequestId, grantId: target.grantId }, causalRefs: ["fixture:single-grant-revoke"] },
    "revoke-single-grant");
  revokeGrant(f.db, { kind: "human", id: f.human, actId: revokeAct.actId! },
    { requestId: revokeRequestId, grantId: target.grantId });
  assert.equal(canUseCapability(f.db, { subjectNodeId: f.chat, sessionId: "chat-session",
    capability: "task.dispatch", resource: `node/${f.agentA}`, requestId: "r2" }), false);
});

test("PP-T06 revoking the package revokes every grant it materialized", t => {
  const f = fixture(t);
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-revoke", label: "R0", items: f.items() });
  const proof = f.approve(manifest);
  const built = materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! });
  void issueGrant;
  // Ending the package needs one Human act, covering every grant it established.
  const revokeRequestId = randomUUID();
  const revokeProposal = { type: "authority.revoke_package", objectRef: proof.actId!,
    scope: `package/pkg-revoke`, targetRevision: null,
    args: packageRevokeActArgs({ packageActId: proof.actId!, requestId: revokeRequestId, reason: "Bounded package finished" }) as unknown as Record<string, unknown>,
    causalRefs: ["fixture:human-reviewed-revocation"] };
  const revokeProof = f.admitAct(revokeProposal, "revoke-pkg-revoke");
  const { revoked } = revokePermissionPackage(f.db, { worldId: f.world, humanId: f.human,
    packageActId: proof.actId!, revokeActId: revokeProof.actId!,
    requestId: revokeRequestId, reason: "Bounded package finished" });
  assert.equal(revoked.length, built.grants.length);
  for (const g of built.grants) assert.ok(getGrant(f.db, g.grantId)!.revokedAt, "history retained, grant revoked");
});

test("PP-T07 a package never enables Authority delegation", t => {
  const f = fixture(t);
  const sneaky = f.items();
  sneaky[0]!.grant.delegable = true as never;
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-deleg", label: "R0", items: sneaky });
  const proof = f.approve(manifest);
  const built = materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! });
  for (const g of built.grants) assert.equal(getGrant(f.db, g.grantId)!.delegable, false,
    "a package item can never be delegable in v1");
});

test("PP-T08 policy epoch change invalidates a reviewed package", t => {
  const f = fixture(t);
  const manifest = preparePermissionPackage({ worldId: f.world, packageId: "pkg-epoch", label: "R0", items: f.items() });
  const proof = f.approve(manifest);
  // Any trust-policy advance must invalidate the stale approval.
  f.db.prepare("UPDATE trust_policy SET epoch=epoch+1 WHERE world_id=?").run(f.world);
  assert.throws(() => materializePermissionPackage(f.db, { worldId: f.world, humanId: f.human, packageActId: proof.actId! }),
    { code: "denied" }, "an obsolete package must not materialize");
});

test("PP-T09 packageDiff reports exactly what changed between revisions", t => {
  const f = fixture(t);
  const before = f.items();
  const after = [...before.slice(0, 2), { purpose: "New: Chat may inspect Agent B status",
    grant: f.grant({ resourceScope: `node/${f.agentB}` }) }];
  const diff = packageDiff(before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.unchanged.length, 2);
  assert.match(diff.added[0]!.purpose, /inspect Agent B/);
  assert.equal(canonical(diff.unchanged.map(i => i.grant)).length > 0, true);
});
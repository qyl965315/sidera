import assert from "node:assert/strict";
import { test } from "node:test";
import { planDevelopmentProfile, type DevelopmentProfileInput } from "../core/development-profile.ts";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { openHumanIngress, explicitHumanStatement, admitHumanAct } from "../core/human-admission.ts";
import { applyPermissionPackage, packageActArgs, materializePermissionPackage } from "../core/permission-package.ts";
import { canUseCapability } from "../core/authority.ts";

const input = (mode: DevelopmentProfileInput["mode"]): DevelopmentProfileInput => ({
  worldId: "world", packageId: "development", mode, subjects: [
    { nodeId: "worker", collaboratorNodeIds: ["reviewer", "chat"], productionWorkspaceAccess: "none",
      workspaces: [{ resourceScope: "node/worker/workspace/**", access: "write", kind: "fixture" }] },
    { nodeId: "chat", collaboratorNodeIds: ["worker"], workspaces: [] },
  ],
});

test("development profiles expand stable N:N collaboration scopes without granting Host admin or other sovereignty", () => {
  const normal = planDevelopmentProfile(input("workspace"));
  const grants = normal.manifest.items.map(i => i.grant);
  assert.ok(grants.some(g => g.subjectNodeId === "worker" && g.capability === "task.dispatch" && g.resourceScope === "node/reviewer"));
  assert.ok(grants.some(g => g.subjectNodeId === "chat" && g.capability === "task.dispatch" && g.resourceScope === "node/worker"));
  assert.ok(grants.some(g => g.subjectNodeId === "worker" && g.capability === "self.workspace.write" && g.resourceScope === "node/worker/workspace/**"));
  assert.ok(grants.every(g => g.capability !== "*" && g.capability !== "self.*" && !g.delegable));
  assert.ok(grants.every(g => !/payment|subscription|account|tool.invoke|peregrine.run/.test(g.capability)));
  assert.ok(grants.filter(g => g.capability === "self.subjectivity.write").every(g => g.resourceScope === `node/${g.subjectNodeId}/**`));
  const reordered = input("workspace");
  reordered.subjects.reverse(); reordered.subjects[1].collaboratorNodeIds.reverse();
  assert.equal(planDevelopmentProfile(reordered).digest, normal.digest);
  const readOnly = planDevelopmentProfile(input("read-only"));
  assert.ok(readOnly.manifest.items.every(i => /\.(read|inspect|capabilities|list|status|observe)$/.test(i.grant.capability)));
});

test("fixture-only policies are per Node and reject production workspace access without brand logic", () => {
  const fixtureOnly = input("workspace");
  fixtureOnly.subjects[0].workspaces.push({ resourceScope: "project/application/source/**", access: "read", kind: "production" });
  assert.throws(() => planDevelopmentProfile(fixtureOnly), { code: "denied" });
  fixtureOnly.subjects[0].productionWorkspaceAccess = "read";
  assert.ok(planDevelopmentProfile(fixtureOnly).manifest.items.some(i => i.grant.capability === "project.source.read"));
  fixtureOnly.subjects[0].workspaces[1].access = "write";
  assert.throws(() => planDevelopmentProfile(fixtureOnly), { code: "denied" });
  fixtureOnly.subjects[0].workspaces = [{ resourceScope: "node/chat/workspace/**", access: "write", kind: "fixture" }];
  assert.throws(() => planDevelopmentProfile(fixtureOnly), { code: "denied" });
});

test("Full Access is a plan until the existing exact Human package admission path applies it", t => {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const worldId = createWorld(db, "Development fixture", "test only"), store = new SemanticStore(db, worldId);
  const humanId = store.createHuman("Human", "fixture"), nodeId = store.registerNode("Unbranded worker");
  db.prepare("INSERT INTO sessions VALUES ('session',?,'mock','mock','fixture','active','now')").run(nodeId);
  const planInput: DevelopmentProfileInput = { worldId, packageId: "full-development", mode: "full-access",
    subjects: [{ nodeId, collaboratorNodeIds: [], workspaces: [] }], fullAccessItems: [
      { purpose: "Explicit machine administration in this owned Host", grant: { requestId: "input", subjectNodeId: nodeId,
        capability: "self.host.tool.invoke", resourceScope: `node/${nodeId}/session/**`, disclosureScope: "handoff_bounded" } },
    ] };
  assert.throws(() => planDevelopmentProfile({ ...planInput, mode: "workspace" }), { code: "denied" });
  const plan = planDevelopmentProfile(planInput);
  assert.equal(plan.admission.fullAccessConfirmationRequired, true);
  assert.equal(db.prepare("SELECT count(*) n FROM grants").get()!.n, 0);
  assert.throws(() => materializePermissionPackage(db, { worldId, humanId, packageActId: "not-admitted" }), { code: "denied" });
  const ingress = openHumanIngress(db, { worldId, humanId, presenceRef: "fixture:operator", sourceRef: "fixture:profile-review" });
  const proposal = { type: "authority.grant_package", objectRef: plan.manifest.packageId,
    scope: `package/${plan.manifest.packageId}`, targetRevision: null,
    args: packageActArgs(plan.manifest) as unknown as Record<string, unknown>, causalRefs: ["fixture:human-full-access-review"] };
  const utteranceId = ingress.capture("review-once", explicitHumanStatement(proposal));
  const proof = admitHumanAct(db, { worldId, humanId, utteranceId, proposal });
  applyPermissionPackage(db, proof, plan.manifest);
  const result = materializePermissionPackage(db, { worldId, humanId, packageActId: proof.actId! });
  assert.equal(result.complete, true);
  const action = { subjectNodeId: nodeId, sessionId: "session", requestId: "inspect", capability: "self.host.tool.invoke", resource: `node/${nodeId}/session/current` };
  assert.equal(canUseCapability(db, action), true);
  assert.equal(canUseCapability(db, { ...action, capability: "billing.purchase" }), false);
  assert.equal(materializePermissionPackage(db, { worldId, humanId, packageActId: proof.actId! }).grants.length, result.grants.length);
});

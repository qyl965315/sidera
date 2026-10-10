import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { issueGrant, reserveCapability, revokeGrant } from "./fixtures/authority.ts";
import { openDatabase } from "../core/db.ts";
import { acceptResponsibility, appointRole, completeResponsibility, createResponsibility,
  getResponsibility, listResponsibilities, listResponsibilityEvents, listRoles,
  raiseEscalation, transferResponsibility } from "./fixtures/organization.ts";

function seed(db: ReturnType<typeof openDatabase>): void {
  const now = new Date().toISOString();
  for (const nodeId of ["sol", "astra", "grok", "ds"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)").run(nodeId, nodeId, now);
    db.prepare(`INSERT INTO sessions
      (session_id,node_id,hythe_id,host_kind,locator_ref,state,created_at)
      VALUES (?,?,'test','test',?,'active',?)`)
      .run(`${nodeId}-session`, nodeId, `${nodeId}-locator`, now);
    grantSelf(db,nodeId);
  }
}

test("Derived delegation retains parent provenance; independent Human grants remain bounded", () => {
  const db=openDatabase(":memory:");
  try {seed(db);
    const root=issueGrant(db,{kind:"human",id:"owner"},{subjectNodeId:"sol",capability:"task.dispatch",resourceScope:"node/ds",delegable:true});
    for(const subjectNodeId of ["sol","astra"])assert.equal(issueGrant(db,{kind:"node",nodeId:"sol"},{subjectNodeId,capability:"task.dispatch",resourceScope:"node/ds",parentGrantId:root.grantId}).parentGrantId,root.grantId);
    const input={requestId:"human-grok",subjectNodeId:"grok",capability:"task.dispatch",resourceScope:"node/ds",limit:1,riskCeiling:1};
    const grant=issueGrant(db,{kind:"human",id:"owner"},input);
    assert.equal(issueGrant(db,{kind:"human",id:"owner"},input).grantId,grant.grantId);
    assert.throws(()=>issueGrant(db,{kind:"human",id:"owner"},{...input,resourceScope:"node/astra"}),{code:"conflict"});
    const action={subjectNodeId:"grok",sessionId:"grok-session",capability:"task.dispatch",resource:"node/ds",requestId:"grok-one",riskLevel:1};
    assert.throws(()=>reserveCapability(db,{...action,riskLevel:3}),{code:"denied"});
    assert.throws(()=>reserveCapability(db,{...action,resource:"node/sol"}),{code:"denied"});
    assert.equal(reserveCapability(db,action).grantId,grant.grantId);
    assert.throws(()=>reserveCapability(db,{...action,requestId:"grok-two"}),{code:"denied"});
    assert.throws(()=>revokeGrant(db,{kind:"node",nodeId:"sol"},{requestId:"node-revoke",grantId:grant.grantId}),{code:"denied"});
    assert.ok(revokeGrant(db,{kind:"human",id:"owner"},{requestId:"human-revoke",grantId:grant.grantId}).revokedAt);
    assert.throws(()=>reserveCapability(db,action),{code:"denied"});
  }finally{db.close();}
});

test("role is metadata; responsibility handoff and escalation persist beyond a Host turn", () => {
  const root = join(process.cwd(), ".sidera-dev", "sol", "temp");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "organization-test-"));
  try {
    const file = join(folder, "sidera.sqlite");
    let db = openDatabase(file);
    seed(db);
    issueGrant(db, { kind: "human", id: "owner" }, {
      subjectNodeId: "sol", capability: "role.appoint", resourceScope: "node/astra",
    });
    issueGrant(db, { kind: "human", id: "owner" }, {
      subjectNodeId: "sol", capability: "responsibility.create", resourceScope: "node/astra",
    });
    issueGrant(db, { kind: "human", id: "owner" }, {
      subjectNodeId: "astra", capability: "responsibility.transfer", resourceScope: "node/grok",
    });
    const sol = { kind: "node", nodeId: "sol", sessionId: "sol-session" } as const;
    const astra = { kind: "node", nodeId: "astra", sessionId: "astra-session" } as const;
    const grok = { kind: "node", nodeId: "grok", sessionId: "grok-session" } as const;
    const role = appointRole(db, sol, { requestId: "appoint-astra", subjectNodeId: "astra",
      role: "Supervisor", scope: "integration", label: "Integration Supervisor" });
    assert.equal(listRoles(db, "astra")[0].appointmentId, role.appointmentId);
    assert.throws(() => reserveCapability(db, { subjectNodeId: "astra",
      sessionId: "astra-session", capability: "task.dispatch", resource: "node/grok",
      requestId: "role-is-not-authority" }), { code: "denied" });
    const parent = createResponsibility(db, sol, { requestId: "root-duty",
      title: "Integrate Grok", scope: "grok-build", ownerNodeId: "astra" });
    acceptResponsibility(db, astra, { requestId: "accept-parent", responsibilityId: parent.responsibilityId });
    const child = createResponsibility(db, astra, { requestId: "child-duty",
      title: "Grok implementation", scope: "grok-build/worker", ownerNodeId: "astra",
      parentResponsibilityId: parent.responsibilityId });
    const handed = transferResponsibility(db, astra, { requestId: "handoff",
      responsibilityId: child.responsibilityId, expectedOwnerNodeId: "astra",
      nextOwnerNodeId: "grok" });
    assert.equal(handed.ownerNodeId, "grok");
    acceptResponsibility(db, grok, { requestId: "accept-child", responsibilityId: child.responsibilityId });
    assert.equal(transferResponsibility(db, astra, { requestId: "handoff",
      responsibilityId: child.responsibilityId, expectedOwnerNodeId: "astra",
      nextOwnerNodeId: "grok" }).ownerNodeId, "grok");
    assert.throws(() => transferResponsibility(db, astra, { requestId: "handoff",
      responsibilityId: child.responsibilityId, expectedOwnerNodeId: "astra",
      nextOwnerNodeId: "ds" }), { code: "conflict" });
    const escalation = raiseEscalation(db, grok, { requestId: "need-scope",
      responsibilityId: child.responsibilityId, reason: "scope_expansion",
      details: "Need access to another review artifact" });
    assert.equal(escalation.payload.targetNodeId, "astra");
    db.close();

    db = openDatabase(file);
    assert.equal(getResponsibility(db, child.responsibilityId).ownerNodeId, "grok");
    assert.equal(listResponsibilities(db, { ownerNodeId: "grok", state: "active" }).length, 1);
    const grokEvents = listResponsibilityEvents(db, "grok");
    assert.ok(grokEvents.some(event => event.kind === "responsibility.reassigned"));
    assert.deepEqual(listResponsibilityEvents(db, "grok",
      grokEvents[grokEvents.length - 1].eventId), []);
    assert.ok(listResponsibilityEvents(db, "astra")
      .some(event => event.eventId === escalation.eventId));
    assert.throws(() => completeResponsibility(db, grok, { requestId: "worker-done-claim",
      responsibilityId: child.responsibilityId, expectedOwnerNodeId: "grok" }), { code: "denied" });
    assert.equal(completeResponsibility(db, { kind: "human", id: "owner" }, { requestId: "done",
      responsibilityId: child.responsibilityId, expectedOwnerNodeId: "grok",
      closureBasis: { kind: "human-judgment", reason: "Human reviewed the integration evidence and accepts fulfillment" } }).state,
    "completed");
    db.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

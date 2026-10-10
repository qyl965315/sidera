import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "./fixtures/human.ts";
import { createResponsibility } from "../core/organization.ts";
import { createTask } from "../core/scheduler.ts";
import { ackMessage, deliverMessage, getMessage } from "../core/bus.ts";
import { issueGrant, revokeGrant, canUseCapability } from "./fixtures/authority.ts";
import { mockProfile } from "./fixtures/execution.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";
import { migrateSharedTransfer, registerArtifact, previewContextHandoff, createContextHandoff,
  getContextHandoff, assertContextHandoffDisclosure, type ContextHandoffInput } from "../core/shared-transfer.ts";
import type { Hythe } from "../hythes/types.ts";

function fixture() {
  const db = openDatabase(":memory:"); migrateSharedTransfer(db);
  const worldId = createWorld(db, "Transfer", "synthetic test"), store = new SemanticStore(db, worldId);
  const humanId = store.createHuman("Owner", "synthetic test"), chief = store.registerNode("Chief"), worker = store.registerNode("Worker"), reviewer = store.registerNode("Reviewer");
  for (const node of [chief, worker, reviewer]) {
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active','now')").run(`${node}-session`, node, `${node}-locator`);
    recordFixtureHostAvailable(db, `${node}-session`);
    db.prepare("INSERT INTO presence_accounts VALUES (?,?,NULL,'not_applicable')").run(`${node}-session`, worldId);
  }
  const caller = { nodeId: worker, sessionId: `${worker}-session` }, target = { nodeId: reviewer, sessionId: `${reviewer}-session` };
  const intentId = store.createIntent(humanId, "fixture"), revision = store.reviseIntent(intentId, null, "Review bounded references", "fixture:Human instruction");
  const responsibility = createResponsibility(db, { kind: "node", nodeId: chief, sessionId: `${chief}-session` }, {
    requestId: "responsibility", title: "Bounded review", scope: "workspace", ownerNodeId: chief,
    basis: { intentRevisionId: revision, contextBasis: ["fixture:review"] } });
  const basis = { responsibilityId: responsibility.responsibilityId, intentRevisionId: revision, contextBasis: ["fixture:review"] };
  issueGrant(db, { kind: "human", id: humanId }, { subjectNodeId: chief, capability: "task.dispatch", resourceScope: `node/${worker}` });
  // Permission to invoke the reviewer exists, but discloses no arbitrary context.
  const actGrant = issueGrant(db, { kind: "human", id: humanId }, { subjectNodeId: worker, capability: "message.send", resourceScope: `node/${reviewer}` });
  const task = createTask(db, { requestId: "task", originNodeId: chief, originSessionId: `${chief}-session`,
    centerNodeId: worker, workerNodeIds: [], body: "Review this bounded source", basis });
  const artifact = registerArtifact(db, caller, { requestId: "artifact", taskId: task.task.taskId,
    reference: "fixture://artifacts/review.txt", versionRef: "declared-v1", title: "Review reference",
    sourceRefs: [{ kind: "message", id: task.firstMessage.messageId }], accessibility: { status: "AVAILABLE", sourceRef: "fixture:Node report" } });
  const input: ContextHandoffInput = { requestId: "handoff", targetNodeId: reviewer, basis, purpose: "Independent review",
    selector: "Worker selected one bounded source and its artifact reference", sourceRefs: [
      { kind: "message", id: task.firstMessage.messageId }, { kind: "artifact", id: artifact.artifactId }] };
  const grantExact = (request = input) => {
    const preview = previewContextHandoff(db, caller, request);
    return issueGrant(db, { kind: "human", id: humanId }, { subjectNodeId: worker, capability: "message.send",
      resourceScope: `node/${reviewer}`, disclosureScope: preview.requiredDisclosureScope });
  };
  return { db, worldId, humanId, chief, worker, reviewer, caller, target, task, artifact, input, actGrant, grantExact };
}

test("ArtifactReference preserves provenance; exact admitted Handoff uses canonical delivery and distinct ACK observation", async () => {
  const f = fixture();
  try {
    assert.equal(f.artifact.definition.contentVerified, false);
    assert.equal(f.artifact.definition.accessibility.evidenceClass, "NODE_CLAIM");
    assert.equal(f.artifact.provenance.sourceVersions[0].id, f.task.firstMessage.messageId);
    assert.throws(() => f.db.prepare("UPDATE artifact_references SET definition_json='{}' WHERE artifact_id=?").run(f.artifact.artifactId), /immutable/);
    const grant = f.grantExact(), request = { ...f.input, disclosureGrantId: grant.grantId };
    const handoff = createContextHandoff(f.db, f.caller, request);
    assert.equal(handoff.disclosure.status, "ALLOWED");
    assert.deepEqual([handoff.created, handoff.delivered, handoff.observed], [true, false, false]);
    assert.equal(handoff.state, "CREATED"); assert.equal(getMessage(f.db, handoff.messageId!).kind, "context-handoff");
    assert.throws(() => getContextHandoff(f.db, f.target, handoff.handoffId), { code: "denied" });
    let delivered = 0;
    const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"], locate: async () => true,
      effectProfile: () => mockProfile, async *receive() {},
      invoke: async (locator, operation, _payload, _key, boundary) => boundary!.cross({ product: "fixture", locator, operation }, () => {
        assertContextHandoffDisclosure(f.db, handoff.messageId!); delivered++;
        return { status: "accepted" as const, hostRef: "exact-handoff-turn" };
      }) };
    await deliverMessage(f.db, handoff.messageId!, new Map([["fixture", hythe]]));
    const sent = getContextHandoff(f.db, f.caller, handoff.handoffId);
    assert.deepEqual([sent.created, sent.delivered, sent.observed], [true, true, false]);
    assert.equal(sent.state, "DELIVERED");
    ackMessage(f.db, handoff.messageId!, f.target.sessionId);
    const observed = getContextHandoff(f.db, f.target, handoff.handoffId);
    assert.deepEqual([observed.created, observed.delivered, observed.observed], [true, true, true]);
    assert.equal(createContextHandoff(f.db, f.caller, request).replay, true);
    await deliverMessage(f.db, handoff.messageId!, new Map([["fixture", hythe]]));
    assert.equal(delivered, 1, "The original canonical message cannot be delivered twice");
  } finally { f.db.close(); }
});

test("CanAct never substitutes for exact CanDisclose; changed bytes, recipient and revoked scope fail the final gate", () => {
  const f = fixture();
  try {
    const count = f.db.prepare("SELECT count(*) n FROM messages").get()!.n;
    const unknown = createContextHandoff(f.db, f.caller, { ...f.input, requestId: "unknown", disclosureGrantId: f.actGrant.grantId });
    assert.equal(unknown.disclosure.status, "UNKNOWN"); assert.equal(unknown.state, "BLOCKED");
    assert.equal(unknown.messageId, null); assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()!.n, count);
    const legacy = issueGrant(f.db, { kind: "human", id: f.humanId }, { subjectNodeId: f.worker, capability: "message.send",
      resourceScope: `node/${f.reviewer}`, disclosureScope: "handoff_bounded" });
    assert.equal(createContextHandoff(f.db, f.caller, { ...f.input, requestId: "legacy", disclosureGrantId: legacy.grantId }).disclosure.status, "UNKNOWN");
    const grant = f.grantExact(), handoff = createContextHandoff(f.db, f.caller, { ...f.input, disclosureGrantId: grant.grantId });
    assertContextHandoffDisclosure(f.db, handoff.messageId!);
    f.db.prepare("UPDATE messages SET body='Changed selected content' WHERE message_id=?").run(f.task.firstMessage.messageId);
    assert.throws(() => assertContextHandoffDisclosure(f.db, handoff.messageId!), { code: "denied" });
    f.db.prepare("UPDATE messages SET body=? WHERE message_id=?").run("Review this bounded source", f.task.firstMessage.messageId);
    f.db.prepare("UPDATE grants SET revoked_at='2000-01-01T00:00:00Z' WHERE grant_id=?").run(grant.grantId);
    assert.throws(() => assertContextHandoffDisclosure(f.db, handoff.messageId!), { code: "denied" });
    const replacement = f.grantExact({ ...f.input, requestId: "next-recipient" });
    const next = createContextHandoff(f.db, f.caller, { ...f.input, requestId: "next-recipient", disclosureGrantId: replacement.grantId });
    f.db.prepare("UPDATE sessions SET locator_ref='changed-host-destination' WHERE session_id=?").run(f.target.sessionId);
    assert.throws(() => assertContextHandoffDisclosure(f.db, next.messageId!), { code: "denied" });
    assert.equal(getMessage(f.db, next.messageId!).state, "queued", "Revalidation does not secretly send or reset state");
  } finally { f.db.close(); }
});

test("Revoked disclosure ancestor cannot be laundered through an independent valid message.send Grant",()=>{
  const f=fixture();try{
    const preview=previewContextHandoff(f.db,f.caller,f.input);
    const root=issueGrant(f.db,{kind:"human",id:f.humanId},{subjectNodeId:f.chief,capability:"message.send",resourceScope:`node/${f.reviewer}`,
      delegable:true,disclosureScope:preview.requiredDisclosureScope});
    const leaf=issueGrant(f.db,{kind:"node",nodeId:f.chief},{subjectNodeId:f.worker,capability:"message.send",resourceScope:`node/${f.reviewer}`,parentGrantId:root.grantId});
    const request={...f.input,disclosureGrantId:leaf.grantId},handoff=createContextHandoff(f.db,f.caller,request);
    assert.equal(handoff.disclosure.status,"ALLOWED");assertContextHandoffDisclosure(f.db,handoff.messageId!);
    revokeGrant(f.db,{kind:"human",id:f.humanId},{grantId:root.grantId,requestId:"revoke-disclosure-parent"});
    assert.equal(canUseCapability(f.db,{subjectNodeId:f.worker,sessionId:f.caller.sessionId,capability:"message.send",resource:`node/${f.reviewer}`,requestId:"independent-transport"}),true,
      "Independent CanAct remains granted; it must not become CanDisclose");
    assert.throws(()=>assertContextHandoffDisclosure(f.db,handoff.messageId!),{code:"denied"});
    assert.equal(getMessage(f.db,handoff.messageId!).state,"queued");
    const nextInput={...f.input,requestId:"after-revoke"},nextPreview=previewContextHandoff(f.db,f.caller,nextInput);
    const root2=issueGrant(f.db,{kind:"human",id:f.humanId},{subjectNodeId:f.chief,capability:"message.send",resourceScope:`node/${f.reviewer}`,delegable:true,disclosureScope:nextPreview.requiredDisclosureScope});
    const leaf2=issueGrant(f.db,{kind:"node",nodeId:f.chief},{subjectNodeId:f.worker,capability:"message.send",resourceScope:`node/${f.reviewer}`,parentGrantId:root2.grantId});
    revokeGrant(f.db,{kind:"human",id:f.humanId},{grantId:root2.grantId,requestId:"revoke-before-admission"});
    const blocked=createContextHandoff(f.db,f.caller,{...nextInput,disclosureGrantId:leaf2.grantId});
    assert.equal(blocked.state,"BLOCKED");assert.equal(blocked.messageId,null);
  }finally{f.db.close();}
});

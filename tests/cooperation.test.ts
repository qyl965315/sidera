import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "./fixtures/human.ts";
import { createResponsibility } from "../core/organization.ts";
import { startCooperation, assertCooperationBasis } from "../core/cooperation.ts";
import { deliverMessage, getMessage } from "../core/bus.ts";
import { CoreRuntime, mockProfile } from "./fixtures/execution.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";
import type { Hythe } from "../hythes/types.ts";

function fixture() {
  const db = openDatabase(":memory:"), worldId = createWorld(db, "Cooperation", "synthetic test");
  const store = new SemanticStore(db, worldId), humanId = store.createHuman("Owner", "synthetic test");
  const nodeId = store.registerNode("Supervisor"), otherNodeId = store.registerNode("Other");
  for (const node of [nodeId, otherNodeId]){
    db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active','now')").run(`${node}-session`, node, `${node}-locator`);
    recordFixtureHostAvailable(db,`${node}-session`);
  }
  const caller = { nodeId, sessionId: `${nodeId}-session` };
  const intentId = store.createIntent(humanId, "fixture");
  const revisionId = store.reviseIntent(intentId, null, "Inspect the repository", "fixture:Human instruction");
  const responsibility = createResponsibility(db, { kind: "node", ...caller }, { requestId: "responsibility", title: "Inspect the repository",
    ownerNodeId: nodeId, scope: "workspace", basis: { intentRevisionId: revisionId, contextBasis: ["fixture:repository"] } });
  const input = { requestId: "cooperation-one", goal: "Inspect, delegate an independent review, and report the evidence",
    basis: { responsibilityId: responsibility.responsibilityId, intentRevisionId: revisionId, contextBasis: ["fixture:repository"] } };
  return { db, store, worldId, intentId, nodeId, otherNodeId, caller, input };
}

test("Cooperation queues one exact canonical self message with existing Authority and preserves admitted provenance", () => {
  const f = fixture();
  try {
    const humansBefore = f.db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n;
    const receipt = startCooperation(f.db, f.caller, f.input), message = getMessage(f.db, receipt.messageId);
    assert.equal(receipt.state, "queued"); assert.equal(receipt.replay, false);
    assert.equal(message.fromNodeId, f.nodeId); assert.equal(message.toNodeId, f.nodeId);
    assert.equal(message.targetSessionId, f.caller.sessionId); assert.equal(message.taskId, null);
    assert.equal(message.kind, "cooperation"); assert.match(message.body, /world_inspect.*work_inspect/);
    assert.match(message.body, /nextNodeId/); assert.match(message.body, /Capability presence never grants Authority/);
    const reservation = f.db.prepare("SELECT capability,resource FROM grant_uses WHERE reservation_id=?").get(message.reservationId!);
    assert.equal(reservation?.capability, "self.task.resume");
    assert.equal(reservation?.resource, `node/${f.nodeId}/session/${f.caller.sessionId}`);
    const before = f.db.prepare("SELECT total_changes() n").get()!.n;
    assert.equal(startCooperation(f.db, f.caller, f.input).messageId, receipt.messageId);
    assert.equal(startCooperation(f.db, f.caller, f.input).replay, true);
    assert.equal(f.db.prepare("SELECT total_changes() n").get()!.n, before);
    for (const table of ["tasks", "task_runs", "supervisions"])
      assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM human_semantic_acts").get()!.n, humansBefore);
    const event = JSON.parse(String(f.db.prepare("SELECT payload FROM events WHERE event_id=?").get(receipt.eventId)!.payload));
    assert.deepEqual(event.basis, f.input.basis);
    f.db.prepare("UPDATE messages SET state='uncertain' WHERE message_id=?").run(receipt.messageId);
    assert.equal(startCooperation(f.db, f.caller, f.input).state, "uncertain", "Replay must not reset or resend an uncertain effect");
    assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()!.n, 1);
    assert.throws(() => startCooperation(f.db, f.caller, { ...f.input, goal: "Different work" }), { code: "conflict" });
  } finally { f.db.close(); }
});

test("Cooperation rejects borrowed ownership, wrong Session, changed basis, stale Intent and missing self Authority without creating work", () => {
  const f = fixture();
  try {
    assert.throws(() => startCooperation(f.db, { nodeId: f.otherNodeId, sessionId: `${f.otherNodeId}-session` }, f.input), { code: "denied" });
    assert.throws(() => startCooperation(f.db, { ...f.caller, sessionId: `${f.otherNodeId}-session` }, f.input), { code: "denied" });
    assert.throws(() => startCooperation(f.db, f.caller, { ...f.input, basis: { ...f.input.basis, contextBasis: ["invented"] } }), { code: "conflict" });
    f.db.prepare("UPDATE grants SET revoked_at='2000-01-01T00:00:00Z' WHERE subject_node_id=?").run(f.nodeId);
    assert.throws(() => startCooperation(f.db, f.caller, f.input), { code: "denied" });
    f.store.reviseIntent(f.intentId, f.input.basis.intentRevisionId, "Changed Human intent", "fixture:next Human instruction");
    assert.throws(() => startCooperation(f.db, f.caller, f.input), { code: "conflict" });
    assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE kind='cooperation.started'").get()!.n, 0);
  } finally { f.db.close(); }
});

test("A new kickoff cannot overlap a queued or accepted standalone turn; the original receipt stays readable",()=>{
  const f=fixture();try{
    const receipt=startCooperation(f.db,f.caller,f.input);
    for(const state of ["queued","delivered","uncertain"]){
      f.db.prepare("UPDATE messages SET state=? WHERE message_id=?").run(state,receipt.messageId);
      assert.throws(()=>startCooperation(f.db,f.caller,{...f.input,requestId:`overlap-${state}`}),{code:"unavailable"});
      assert.equal(startCooperation(f.db,f.caller,f.input).messageId,receipt.messageId);
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()!.n,1);
  }finally{f.db.close();}
});

test("Cooperation final guard rejects post-admission content/basis changes without replay or synthetic Run", async () => {
  const f = fixture();
  try {
    const receipt = startCooperation(f.db, f.caller, f.input);
    const original = getMessage(f.db, receipt.messageId);
    assert.deepEqual(assertCooperationBasis(f.db, receipt.messageId).basis, f.input.basis);
    f.db.prepare("UPDATE messages SET body='Changed work' WHERE message_id=?").run(receipt.messageId);
    assert.throws(() => assertCooperationBasis(f.db, receipt.messageId), { code: "denied" });
    f.db.prepare("UPDATE messages SET body=? WHERE message_id=?").run(original.body, receipt.messageId);
    let actualSends = 0;
    const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"], locate: async () => true,
      effectProfile: () => mockProfile, async *receive() {},
      invoke: async (locator, operation, _payload, _key, boundary) => {
        // The admitted immutable goal becomes stale while the adapter prepares.
        f.store.reviseIntent(f.intentId, f.input.basis.intentRevisionId, "Changed Human intent after enqueue", "fixture:changed while adapter awaited");
        return boundary!.cross({ product: "fixture", locator, operation }, () => {
          actualSends++; return { status: "accepted" as const, hostRef: "must-not-send" };
        });
      } };
    const blocked = await deliverMessage(f.db, receipt.messageId, new Map([["fixture", hythe]]));
    assert.equal(blocked.state, "failed"); assert.equal(actualSends, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM effect_audit WHERE kind='send.initiated'").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM effect_attempt_state WHERE state='uncertain'").get()!.n, 0,
      "A rejected local final check is not an uncertain external effect");
    assert.throws(() => assertCooperationBasis(f.db, receipt.messageId), { code: "conflict" });
    assert.equal(startCooperation(f.db, f.caller, f.input).messageId, receipt.messageId, "Historical receipt remains readable; it cannot pass the send gate");
    assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM task_runs").get()!.n, 0);
  } finally { f.db.close(); }
});

test("A fast standalone completion waits for the original send settlement without another invocation",async()=>{
  const f=fixture();let runtime:CoreRuntime|undefined,completion:Promise<unknown>|undefined,sends=0;
  try {
    const hythe:Hythe={hytheId:"fixture",hostKind:"fixture",capabilities:()=>["message.receive"],locate:async()=>true,
      effectProfile:()=>mockProfile,async *receive(){},invoke:async(locator,operation,payload,_key,boundary)=>
        boundary!.cross({product:"fixture",locator,operation},async()=>{
          sends++;const messageId=(payload as {messageId:string}).messageId;
          completion=runtime!.ingest(f.caller.sessionId,{observedMessageId:messageId,hostRef:"fast-turn",body:"finished",outcome:"completed"});
          await new Promise<void>(resolve=>setImmediate(resolve));
          assert.equal(getMessage(f.db,messageId).state,"sending");
          return {status:"accepted" as const,hostRef:"fast-turn"};
        })};
    const hythes=new Map([["fixture",hythe]]);runtime=new CoreRuntime(f.db,hythes);
    const receipt=startCooperation(f.db,f.caller,f.input);
    const first=deliverMessage(f.db,receipt.messageId,hythes),duplicate=deliverMessage(f.db,receipt.messageId,hythes);
    assert.equal(first,duplicate);await first;await completion;
    assert.equal(getMessage(f.db,receipt.messageId).state,"observed");assert.equal(sends,1);
    assert.equal(f.db.prepare("SELECT state FROM effect_attempt_state").get()?.state,"completed");
  }finally{await runtime?.close();f.db.close();}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { controlHost } from "./fixtures/host-control.ts";
import { GptReturnHythe } from "../hythes/gpt-return.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";
import type { Hythe } from "../hythes/types.ts";

function setup() {
  const db = openDatabase(":memory:");
  for (const id of ["sol", "astra"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', 'now')").run(id, id);
    db.prepare("INSERT INTO sessions VALUES (?, ?, 'native', 'test', ?, 'active', 'now')")
      .run(`${id}-session`, id, `${id}-exact-locator`);
    recordFixtureHostAvailable(db,`${id}-session`);
  }
  let calls = 0;
  let fail = false;
  let outcome: Record<string, unknown> = { turnId: "real-host-turn" };
  const native: Hythe = { hytheId: "native", hostKind: "test",
    capabilities: () => [], controls: () => ["conversation.steer"],
    locate: async () => true, invoke: async () => ({ status: "rejected", reason: "unused" }),
    async *receive() {},
    control: async locator => {
      calls++; assert.equal(locator, "astra-exact-locator");
      if (fail) throw new Error("Disconnected after possible acceptance");
      return outcome;
    },
  };
  const grant = () => issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "sol", capability: "host.conversation.steer",
    resourceScope: "node/astra/session/astra-session",
  });
  const invoke = (requestId: string, input = {}) => controlHost(db, new Map([["native", native]]),
    { nodeId: "sol", sessionId: "sol-session" },
    { requestId, targetSessionId: "astra-session", operation: "conversation.steer", input });
  return { db, grant, invoke, calls: () => calls, outcome: (value: Record<string, unknown>) => { outcome = value; }, disconnect: () => { fail = true; } };
}

test("Host control preserves notification admission, acceptance, rejection and uncertainty", async () => {
  const s = setup();
  try {
    s.grant();
    for (const status of ["transport_admitted", "accepted"]) {
      s.outcome({ status });
      const result = await s.invoke(status);
      assert.equal(result.status, status);
      assert.equal(result.agentTurnCompleted, null); assert.equal(result.humanPresentationObserved, null);
      assert.deepEqual(await s.invoke(status), result);
    }
    s.outcome({status:"rejected"});
    await assert.rejects(s.invoke("rejected-after-boundary"),{code:"uncertain"});
    s.outcome({ status: "uncertain" });
    await assert.rejects(s.invoke("explicit-uncertain"), { code: "uncertain" });
    await assert.rejects(s.invoke("explicit-uncertain"), { code: "uncertain" });
    assert.equal(s.calls(), 4);
  } finally { s.db.close(); }
});

test("host controls authorize exact Session before I/O and persist replay without another call", async () => {
  const s = setup();
  try {
    await assert.rejects(s.invoke("denied"), { code: "denied" });
    assert.equal(s.calls(), 0);
    s.grant();
    const confirmed = await s.invoke("one");
    assert.equal(confirmed.status, "host_confirmed");
    assert.deepEqual(await s.invoke("one"), confirmed);
    assert.equal(s.calls(), 1);
    await assert.rejects(s.invoke("one", { body: "changed" }), { code: "conflict" });
    assert.equal(s.db.prepare("SELECT status FROM grant_uses").get()?.status, "consumed");
  } finally { s.db.close(); }
});

test("uncertain native side effect remains reserved and cannot be blindly resent", async () => {
  const s = setup();
  try {
    s.grant(); s.disconnect();
    await assert.rejects(s.invoke("uncertain"), { code: "uncertain" });
    await assert.rejects(s.invoke("uncertain"), { code: "uncertain" });
    assert.equal(s.calls(), 1);
    assert.equal(s.db.prepare("SELECT status FROM grant_uses").get()?.status, "reserved");
  } finally { s.db.close(); }
});

test("a live GPT return channel must not claim it can wake GPT for a new task", async () => {
  const gpt = new GptReturnHythe("origin", () => true);
  assert.equal((await gpt.invoke("origin", "message.receive",
    { messageId: "new-task", kind: "task" }, "one")).status, "rejected");
  assert.equal((await gpt.invoke("origin", "message.receive",
    { messageId: "result", kind: "result" }, "two")).status, "accepted");
});

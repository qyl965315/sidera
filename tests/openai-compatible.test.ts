import { protocolTestBoundary } from "./fixtures/execution.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { OpenAICompatibleHythe } from "../hythes/openai-compatible.ts";
import { initializeNodeSovereignty } from "../core/sovereignty-store.ts";

test("a second compatible provider uses its own endpoint, model and provider ID", async () => {
  const db = openDatabase(":memory:");
  const at = new Date().toISOString();
  db.prepare("INSERT INTO nodes VALUES ('node-a','Agent A','active',?)").run(at);
  db.prepare("INSERT INTO sessions VALUES ('session-a','node-a','api:fixture-gateway'," +
    "'generic-api','fixture-locator','active',?)").run(at);
  db.prepare("INSERT INTO model_bindings VALUES ('binding-a','node-a','fixture-gateway'," +
    "'fixture-model','{\"effort\":\"none\"}',?,NULL,NULL)").run(at);
  db.prepare("INSERT INTO messages (message_id,request_id,from_node_id,to_node_id," +
    "target_session_id,sequence,kind,body,state,created_at) VALUES " +
    "('message-a','request-a','node-a','node-a','session-a',1,'task','test','observed',?)")
    .run(at);
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  initializeNodeSovereignty(db, "node-a", { description: "current D", explanation: "causal Exp" });
  // Seed historical poison before enabling the archive locks in this synthetic fixture.
  const locks=db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('freeze_self_state','freeze_sovereign_memory_insert')").all() as {sql:string}[];
  db.exec("DROP TRIGGER freeze_self_state; DROP TRIGGER freeze_sovereign_memory_insert");
  try {
  db.prepare("UPDATE node_identity SET self_state='legacy self poison' WHERE node_id='node-a'").run();
  db.prepare("INSERT INTO sovereign_memory VALUES ('node-a','legacy','\"legacy memory poison\"',?)").run(at);
  } finally {for(const lock of locks)db.exec(lock.sql);}
  db.prepare("INSERT INTO api_session_history VALUES ('session-a',?,?)")
    .run(JSON.stringify([{ role: "assistant", content: "old transcript poison" }]), at);
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"fixture reply"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'));
      controller.close();
    } }), { status: 200 });
  };
  try {
    const hythe = new OpenAICompatibleHythe({ db,
      provider: { providerId: "fixture-gateway", baseUrl: "https://fixture.invalid/v1/",
        credentialRef: "fixture:credential" },
      resolveCredential: ref => ref === "fixture:credential" ? "secret-not-persisted" : undefined,
      fetchImpl: fakeFetch, nodeId: "node-a", sessionId: "session-a",
      locatorRef: "fixture-locator", astraNodeId: "node-a",
      core: { port: 0, token: "unused" } });
    assert.equal(await hythe.verifyProvider(), true);
    const accepted = await hythe.invoke("fixture-locator", "message.receive", {
      messageId: "message-a", taskId: "task-a", runId: "run-a",
      fromNodeId: "node-a", targetSessionId: "session-a", body: "Say hello",
    }, "request-a",protocolTestBoundary);
    assert.equal(accepted.status, "accepted");
    const result = await hythe.receive("fixture-locator")[Symbol.asyncIterator]().next();
    assert.equal(result.value?.body, "fixture reply");
    assert.equal(calls[0]?.url, "https://fixture.invalid/v1/models");
    assert.equal(calls[1]?.url, "https://fixture.invalid/v1/chat/completions");
    assert.equal(calls[1]?.body?.model, "fixture-model");
    const hydrated = JSON.stringify(calls[1]?.body?.messages);
    assert.match(hydrated, /current D/); assert.match(hydrated, /causal Exp/); assert.match(hydrated, /lineageRef/);
    assert.equal(hydrated.includes("poison"), false);
    assert.equal(JSON.stringify(db.prepare("SELECT messages_json FROM api_session_history").get()).includes("old transcript poison"), true);
    assert.equal("thinking" in (calls[1]?.body ?? {}), false);
    assert.deepEqual({ ...db.prepare("SELECT provider_id,model_id,state FROM api_calls").get() },
      { provider_id: "fixture-gateway", model_id: "fixture-model", state: "completed" });
    assert.equal(JSON.stringify(db.prepare("SELECT messages_json FROM api_session_history").get())
      .includes("secret-not-persisted"), false);
  } finally { db.close(); }
});

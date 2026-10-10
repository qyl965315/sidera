import { protocolTestBoundary } from "./fixtures/execution.ts";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { GrokHythe } from "../hythes/grok.ts";

test("Grok ACP binds exact Session and separates acceptance from completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "sidera-grok-acp-"));
  const fixture = join(root, "agent.mjs");
  writeFileSync(fixture, `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
let prompt;
for await (const line of lines) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize")
    send({ id: msg.id, result: { authMethods: [{ id: "cached_token" }] } });
  if (msg.method === "authenticate") send({ id: msg.id, result: {} });
  if (msg.method === "session/new") {
    const server = msg.params.mcpServers?.find(x => x.name === "sidera");
    const env = server?.env ?? [];
    if (!server || !env.some(x => x.name === "SIDERA_NODE_CORE_TOKEN") || !env.some(x => x.name === "SIDERA_CORE_PORT"))
      send({ id: msg.id, error: { message: "canonical Sidera MCP server missing" } });
    else send({ id: msg.id, result: {
      sessionId: "exact-grok-session", models: { currentModelId: "available-test-model" } } });
  }
  if (msg.method === "session/load") send({ id: msg.id, result: {
    models: { currentModelId: "available-test-model" } } });
  if (msg.method === "session/prompt") {
    prompt = msg;
    // Independent server request namespace deliberately reuses the pending prompt ID.
    send({ id: msg.id, method: "session/request_permission", params: {
      sessionId: msg.params.sessionId,
      toolCall: { title: "mcp__sidera__session_active" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" }
      ]
    } });
  }
  if (!msg.method && prompt && msg.id === prompt.id && msg.result?.outcome?.outcome === "selected") {
    if (msg.result.outcome.optionId !== "allow-once") throw new Error("wrong permission option");
    send({ method: "session/update", params: { sessionId: prompt.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
  }
  if (!msg.method && prompt && msg.id === prompt.id && msg.result?.outcome?.outcome === "cancelled")
    send({ id: prompt.id, result: { stopReason: "cancelled" } });
  if (msg.method === "session/cancel") send({ id: prompt.id, result: { stopReason: "end_turn" } });
}
`);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (event_id TEXT,actor_node_id TEXT,kind TEXT,payload TEXT,created_at TEXT)");
  const hythe = new GrokHythe({ executable: process.execPath,
    launchArgs: [fixture], home: join(root, "home"),
    workspace: join(root, "workspace"), coreToken: randomUUID(), corePort: 8765,
    mcpEntry: fixture, db });
  try {
    const locator = await hythe.createSession();
    assert.equal(locator, "exact-grok-session");
    assert.equal(hythe.modelId(), "available-test-model");
    assert.equal(await hythe.locate(locator), true);
    const receive = hythe.receive(locator)[Symbol.asyncIterator]();
    // A retired Session observer must never consume a current Session's result.
    void hythe.receive("old-retired-session")[Symbol.asyncIterator]().next();
    const observed = receive.next();
    const messageId = randomUUID();
    const dispatched = await hythe.invoke(locator, "message.receive",
      { messageId, body: "One Sidera task" }, randomUUID(),protocolTestBoundary);
    assert.equal(dispatched.status, "accepted");
    assert.equal(dispatched.status === "accepted" && dispatched.hostRef.length > 0, true);
    assert.equal(hythe.canStartTurn(), false);
    await assert.rejects(hythe.createSession(), { code: "conflict" });
    assert.equal(await hythe.locate("different-session"), false);
    const cancel = await hythe.control(locator, "conversation.interrupt", {
      turnId: dispatched.status === "accepted" ? dispatched.hostRef : "" },protocolTestBoundary);
    assert.equal(cancel.status, "transport_admitted"); assert.equal(cancel.interrupted, false);
    const result = await observed;
    assert.equal(result.value?.observedMessageId, messageId);
    assert.equal(result.value?.hostRef, dispatched.status === "accepted" ? dispatched.hostRef : "");
    assert.equal(result.value?.body, "done");
    assert.equal(result.value?.outcome, "completed");
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='host.permission.intent'").get()?.n,1);
  } finally { await hythe.close(); db.close(); }
});

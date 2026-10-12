import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { startGptHythe } from "../hythes/gpt-mcp.ts";

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

function request(base: string, value: unknown, authorization?: string, origin?: string) {
  return fetch(base + "/mcp", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}),
  }, body: JSON.stringify(value) });
}

async function mcpResponse(response: Response): Promise<{ result?: { tools?: Array<{ name?: string }> } }> {
  const body = await response.text();
  const json = body.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice("data: ".length) ?? body;
  return JSON.parse(json) as { result?: { tools?: Array<{ name?: string }> } };
}

test("ChatGPT-origin Streamable HTTP witness reports listener, ingress and HOLD without accepting origin as identity", async () => {
  const server = await startGptHythe({ core: { port: 1, token: "isolated-core-token" },
    httpToken: "isolated-chatgpt-boundary-token", port: 0,
    readiness: () => ({ ready: true, fixture: "isolated" }) });
  const base = `http://127.0.0.1:${portOf(server)}`;
  try {
    const initial = await fetch(base + "/edge-healthz");
    assert.equal(initial.status, 200);
    const before = await initial.json() as { schema: string; listener: { endpoint: string; methods: string[] };
      authentication: { required: string; tokenExposed: boolean }; ingress: { authenticatedMcpRequests: number };
      exactChat: { connectorE2E: string } };
    assert.equal(before.schema, "sidera.chatgpt-edge-health/1");
    assert.deepEqual(before.listener, { state: "LISTENING", transport: "streamable-http", endpoint: "/mcp", methods: ["POST"] });
    assert.deepEqual(before.authentication, { required: "bearer", tokenExposed: false });
    assert.equal(before.ingress.authenticatedMcpRequests, 0);
    assert.equal(before.exactChat.connectorE2E, "HOLD");

    // This is deliberately a local, isolated protocol witness. The Origin is
    // recorded only as an untrusted header observation, not as product identity.
    const response = await request(base, { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "chatgpt-origin-witness", version: "1" } } },
    "Bearer isolated-chatgpt-boundary-token", "https://chatgpt.com");
    assert.equal(response.status, 200);
    const listed = await request(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      "Bearer isolated-chatgpt-boundary-token", "https://chatgpt.com");
    assert.equal(listed.status, 200);
    const listedBody = await mcpResponse(listed);
    assert.ok(listedBody.result?.tools?.some(tool => tool.name === "chief_dispatch_status"),
      "the Chief-compatible listener exposes the existing Chief tool surface");
    const after = await (await fetch(base + "/edge-healthz")).json() as { ingress: {
      authenticatedMcpRequests: number; lastAuthenticatedAt: string | null; chatGptWebOriginHeaderSeen: boolean; originHeaderIsIdentityProof: boolean } };
    assert.equal(after.ingress.authenticatedMcpRequests, 2);
    assert.ok(after.ingress.lastAuthenticatedAt);
    assert.equal(after.ingress.chatGptWebOriginHeaderSeen, true);
    assert.equal(after.ingress.originHeaderIsIdentityProof, false);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("ChatGPT-looking Origin cannot bypass bearer authentication, and legacy SSE receives a precise non-Core diagnosis", async () => {
  const server = await startGptHythe({ core: { port: 1, token: "isolated-core-token" },
    httpToken: "isolated-chatgpt-boundary-token", port: 0 });
  const base = `http://127.0.0.1:${portOf(server)}`;
  try {
    const denied = await request(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, undefined, "https://chatgpt.com");
    assert.equal(denied.status, 401);
    const sse = await fetch(base + "/sse", { headers: { origin: "https://chatgpt.com" } });
    assert.equal(sse.status, 410);
    const diagnosis = await sse.json() as { code: string; expected: { endpoint: string; method: string }; coreState: string; connectorE2E: string };
    assert.equal(diagnosis.code, "LEGACY_SSE_ENDPOINT_UNSUPPORTED");
    assert.deepEqual(diagnosis.expected, { transport: "streamable-http", endpoint: "/mcp", method: "POST" });
    assert.equal(diagnosis.coreState, "NOT_PROBED");
    assert.equal(diagnosis.connectorE2E, "HOLD");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("authenticated SDK tool callback observes only bounded, redacted OpenAI session metadata", async () => {
  const traces: Array<Record<string, unknown>> = [];
  const server = await startGptHythe({ core: { port: 1, token: "isolated-core-token" },
    httpToken: "isolated-chatgpt-boundary-token", port: 0, trace: entry => traces.push(entry) });
  const base = `http://127.0.0.1:${portOf(server)}`;
  const call = (id: number, meta: unknown, arguments_: Record<string, unknown> = {}) => request(base, {
    jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "chief_dispatch_status", arguments: arguments_, ...(meta === undefined ? {} : { _meta: meta }),
    },
  }, "Bearer isolated-chatgpt-boundary-token");
  try {
    // Core is deliberately unreachable in this local witness. A 200 MCP envelope
    // proves a metadata-free client still reaches the existing tool callback.
    for (const response of await Promise.all([
      call(1, { "openai/session": "session-A", "openai/subject": "subject-A" }),
      call(2, { "openai/session": "session-A", "openai/subject": "subject-A" }),
      call(3, { "openai/session": "session-B", "openai/subject": "subject-A" }),
      call(4, undefined),
      call(5, { "openai/session": 7 }),
      call(6, { "openai/session": "x".repeat(513) }),
      call(7, { "openai/session": "line\nbreak" }),
    ])) assert.equal(response.status, 200);

    const spoofed=await mcpResponse(await call(8,undefined,{"openai/session":"argument-spoof"}));
    assert.equal((spoofed.result as {isError?:boolean})?.isError,true,
      "unknown tool arguments are rejected before the SDK callback");

    const observed = traces.filter(entry => entry.event === "openai.session-correlation") as Array<{
      correlation: { metadataState: string; sessionFingerprint?: string; authority: string; humanAct: boolean; effect: boolean; claimUsable: boolean };
    }>;
    assert.equal(observed.length, 7, "the observer runs in the actual MCP SDK tool callback");
    assert.equal(observed[0].correlation.metadataState, "usable");
    assert.equal(observed[0].correlation.sessionFingerprint, observed[1].correlation.sessionFingerprint);
    assert.notEqual(observed[0].correlation.sessionFingerprint, observed[2].correlation.sessionFingerprint);
    assert.equal(observed[3].correlation.metadataState, "absent", "tool arguments cannot spoof SDK extra._meta");
    assert.equal(observed[4].correlation.metadataState, "rejected");
    assert.equal(observed[5].correlation.metadataState, "rejected", "oversize opaque identifiers are rejected");
    assert.equal(observed[6].correlation.metadataState, "rejected", "control characters are rejected");
    for (const event of observed) {
      assert.equal(event.correlation.authority, "NOT_A_GRANT");
      assert.equal(event.correlation.humanAct, false);
      assert.equal(event.correlation.effect, false);
      assert.equal(event.correlation.claimUsable, false);
    }
    assert.equal(JSON.stringify(observed).includes("session-A"), false);
    assert.equal(JSON.stringify(observed).includes("subject-A"), false);

    const health = await (await fetch(base + "/edge-healthz")).json() as { ingress: { openAiSessionCorrelation: {
      usable: number; absent: number; rejected: number; claimsMayUseMetadata: boolean;
    } } };
    assert.deepEqual(health.ingress.openAiSessionCorrelation, {
      usable: 3, absent: 1, rejected: 3, claimsMayUseMetadata: false,
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

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

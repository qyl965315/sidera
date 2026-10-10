import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { grantSelf } from "./fixtures/authority.ts";
import type { Hythe } from "../hythes/types.ts";
import { hostFactories } from "../hythes/host-factories.ts";
import { ExternalMcpClientHythe } from "../hythes/external-mcp-client.ts";
import { buildEdge, startGatewayHttp, type GatewayWorkspaceConfig } from "../hythes/mcp-gateway.ts";
import { reconcileSpecs } from "../core/onboarding.ts";
import { explicitHumanStatement, openHumanIngress, admitHumanAct } from "../core/human-admission.ts";
import { canUseCapability, issueGrant } from "../core/authority.ts";
import { createHash } from "node:crypto";

const EDGE = "grok-chat";
const NODE = "4c5f3b7a-70e5-4b33-b67a-2a01dc228453";
const SESSION = "external-session-grok-chat";
const HYTHE = "external-grok-chat";
const CORE_TOKEN = "external-grok-chat-core-token";
const LOCATOR = `gateway-edge://${EDGE}`;

function externalSpec(overrides: Partial<{ nodeId: string; sessionId: string; hytheId: string; locatorRef: string }> = {}) {
  return { nodeId: overrides.nodeId ?? NODE, displayName: "Grok Chat",
    sessionId: overrides.sessionId ?? SESSION, locatorRef: overrides.locatorRef ?? LOCATOR,
    hostKind: "external-mcp-client", hytheId: overrides.hytheId ?? HYTHE,
    coreToken: CORE_TOKEN, options: { edgeId: EDGE, gatewayEndpoint: "http://127.0.0.1:8788/mcp" } };
}

function externalHost(locatorRef = LOCATOR, edgeId = EDGE, hytheId = HYTHE) {
  return new ExternalMcpClientHythe(hytheId, { edgeId, locatorRef,
    gatewayEndpoint: "http://127.0.0.1:8788/mcp" });
}

function fixture() {
  const project = mkdtempSync(join(tmpdir(), "sidera-external-"));
  const db = openDatabase(join(project, "sidera.sqlite"));
  db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(NODE, "Grok Chat", new Date().toISOString());
  grantSelf(db, NODE);
  const world = recordWorld(db, "nodes", NODE);
  const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"],
    locate: async () => true, invoke: async () => ({ status: "accepted", hostRef: "fixture" }), async *receive() {} };
  const runtime = new CoreRuntime(db, new Map([["fixture", hythe]]), undefined, { observationOnly: true });
  const rpc = new CoreRpcServer(db, runtime, new Map([["fixture", hythe]]),
    { authenticate: token => token === CORE_TOKEN ? { kind: "node", nodeId: NODE, sessionId: SESSION } : null },
    undefined, project);
  return { project, db, world, runtime, rpc, close: async () => { runtime.close(); await rpc.close(); db.close(); } };
}

test("X-T01 the external MCP client Host is generic: no product branch, honest inbound-only capability", () => {
  const a = externalHost(LOCATOR, "grok-chat", "external-grok-chat");
  const b = externalHost("gateway-edge://gemini-chat", "gemini-chat", "external-gemini-chat");
  assert.equal(a.hostKind, b.hostKind, "one adapter serves every external product edge");
  assert.equal(a.hostKind, "external-mcp-client");
  assert.deepEqual([...a.capabilities()], [], "no invented proactive capability");
  assert.equal(a.canStartTurn(), false, "Sidera cannot start a turn in the product");
  assert.deepEqual([...a.controls()], [], "no invented Host controls");
  const manifest = a.manifest();
  assert.ok(!manifest.transportCapabilities.includes("message.receive"),
    "an inbound-only edge must not advertise proactive receive");
  assert.ok(!manifest.transportCapabilities.includes("session.locate"), "configured edge cannot attest exact conversation Presence");
  assert.ok(!manifest.operations.some(operation => operation.supported && operation.backendOperation === "conversation.send"),
    "no proactive send operation may be claimed");
});

test("X-T02 declared edge binding cannot be promoted into proactively verified Presence", async () => {
  const host = externalHost();
  assert.equal(await host.locate(LOCATOR), false);
  assert.equal(await host.locate("gateway-edge://gemini-chat"), false);
  assert.equal(await host.locate(""), false);
});

test("X-T03 an inbound-only Host refuses proactive invocation and yields no fabricated result", async () => {
  const host = externalHost();
  const invoked = await host.invoke();
  assert.equal(invoked.status, "rejected");
  assert.match((invoked as { reason: string }).reason, /inbound-only/);
  const received: unknown[] = [];
  for await (const message of host.receive()) received.push(message);
  assert.deepEqual(received, [], "no fabricated Host progress");
});

test("X-T04 the adapter is reachable through the standard factory with no per-product code", () => {
  const spec = externalSpec();
  const hythe = hostFactories["external-mcp-client"]!(spec as never, null as never, 8765);
  assert.equal(hythe.hytheId, HYTHE);
  assert.equal(hythe.hostKind, "external-mcp-client");
  assert.ok(!hythe.capabilities().includes("message.receive"));
});

test("X-T05 declaring the Session creates no model binding and preserves the existing Node identity", () => {
  const f = fixture();
  try {
    const hythe = externalHost();
    reconcileSpecs(f.db, [externalSpec() as never], new Map([[HYTHE, hythe]]));
    const node = f.db.prepare("SELECT node_id,display_name,lifecycle FROM nodes WHERE node_id=?").get(NODE) as
      { node_id: string; display_name: string; lifecycle: string };
    assert.equal(node.node_id, NODE, "the existing Node identity is unchanged");
    assert.equal(node.display_name, "Grok Chat");
    assert.equal(node.lifecycle, "active");
    const sessions = f.db.prepare("SELECT session_id, node_id, hythe_id, host_kind FROM sessions WHERE node_id=? AND state='active'")
      .all(NODE) as Array<{ session_id: string; node_id: string; hythe_id: string; host_kind: string }>;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.session_id, SESSION);
    assert.equal(sessions[0]!.host_kind, "external-mcp-client");
    const bindings = f.db.prepare("SELECT count(*) n FROM model_bindings WHERE node_id=?").get(NODE) as { n: number };
    assert.equal(bindings.n, 0, "no model binding may be fabricated for an external edge");
    const manifest = f.db.prepare("SELECT manifest_json FROM capability_manifests WHERE node_id=?").get(NODE) as
      { manifest_json: string };
    assert.ok(!(JSON.parse(manifest.manifest_json) as { transportCapabilities: string[] })
      .transportCapabilities.includes("message.receive"));
  } finally { void f.close(); }
});

test("X-T06 an inbound Gateway request resolves to the exact bound Node principal", async () => {
  const f = fixture();
  // Declare the Session exactly as the runtime configuration does, so the edge's
  // Core principal has a real active Session to authenticate.
  reconcileSpecs(f.db, [externalSpec() as never], new Map([[HYTHE, externalHost()]]));
  const port = await f.rpc.listen();
  const config: GatewayWorkspaceConfig = { version: 1, corePort: port, gatewayPort: 0, host: "127.0.0.1", edges: [] };
  const edge = buildEdge(config, { id: "grok-chat", boundNodeId: NODE, coreToken: CORE_TOKEN,
    token: "grok-chat-boundary-credential" });
  const listener = await startGatewayHttp([edge], { port: 0 });
  try {
    const client = new Client({ name: "external-edge", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer grok-chat-boundary-credential" } } }));
    const result = await client.callTool({ name: "sidera_invoke", arguments: { operation: "session.active", arguments: {} } });
    const session = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as
      { nodeId?: string; hostKind?: string };
    assert.equal(session.nodeId, NODE, "the edge credential decides identity, not the product name or tunnel");
    assert.equal(session.hostKind, "external-mcp-client");
    await client.close();
    const wrong = await fetch(`http://127.0.0.1:${listener.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-the-edge-credential" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(wrong.status, 401, "a request may not borrow another edge's identity");
  } finally { await listener.close(); await f.close(); }
});

/** The Human-admission path the operator runs to give an external Node its own
 * standing grant. The test exercises the same functions the canonical
 * onboarding command does, so the remaining Human step is proven executable. */
test("X-T07 the Human-rooted self grant makes the external Node a real actor", async () => {
  const f = fixture();
  try {
    // A grant is only usable through an active Session of the same Node.
    reconcileSpecs(f.db, [externalSpec() as never], new Map([[HYTHE, externalHost()]]));
    const human = "fixture-standing-owner";
    const source = openHumanIngress(f.db, { worldId: f.world, humanId: human,
      presenceRef: "test:local-operator-terminal", sourceRef: "external-mcp-client-test" });
    const input = { requestId: `human-root:self:${NODE}`, subjectNodeId: NODE, capability: "self.*",
      resourceScope: `node/${NODE}/**`, delegable: false, productScope: "*", effectScope: "admission",
      disclosureScope: "self_sovereign" };
    const proposal = { type: "authority.grant", objectRef: NODE, scope: input.resourceScope,
      targetRevision: null, args: input as unknown as Record<string, unknown>,
      causalRefs: ["human:local-operator-terminal"] };
    const body = explicitHumanStatement(proposal);
    const utteranceId = source.capture(`x-t07:${createHash("sha256").update(body).digest("hex").slice(0, 24)}`, body);
    const act = admitHumanAct(f.db, { worldId: f.world, humanId: human, utteranceId, proposal });
    issueGrant(f.db, { kind: "human", id: human, actId: act.actId }, input as never);
    const grant = f.db.prepare("SELECT capability, resource_scope, issuer, revoked_at FROM grants WHERE subject_node_id=?")
      .get(NODE) as { capability: string; resource_scope: string; issuer: string; revoked_at: string | null };
    assert.equal(grant.capability, "self.*");
    assert.equal(grant.resource_scope, `node/${NODE}/**`);
    assert.equal(grant.issuer, `human:${human}`, "the grant is Human-rooted, never Node-minted");
    assert.equal(grant.revoked_at, null);
    // The grant is exactly the authority the Resource publish path checks.
    assert.equal(canUseCapability(f.db, { subjectNodeId: NODE, sessionId: SESSION,
      capability: "self.resource.publish", resource: `node/${NODE}`, requestId: "x-t07-check" }), true);
  } finally { void f.close(); }
});

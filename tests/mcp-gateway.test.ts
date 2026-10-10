import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { openDatabase } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { grantSelf } from "./fixtures/authority.ts";
import type { Hythe } from "../hythes/types.ts";
import { buildEdge, buildOperationRegistry, capabilityCatalog, createGatewayServer, generateEdgeProfiles,
  GATEWAY_TOOL_NAMES, operationEnvelope, renderMatrix, startGatewayHttp, TARGET_EDGES,
  type GatewayWorkspaceConfig, type GatewayEdge } from "../hythes/mcp-gateway.ts";
import { canonicalToolNames } from "../hythes/canonical-mcp.ts";
import { canonicalOperationForTool } from "../hythes/tool-catalog.ts";


function fixture() {
  const project = mkdtempSync(join(tmpdir(), "sidera-gateway-"));
  const db = openDatabase(join(project, "sidera.sqlite"));
  for (const id of ["frame", "worker", "other"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,\'active\',?)").run(id, id, new Date().toISOString());
    db.prepare("INSERT INTO sessions VALUES (?,?,\'fixture\',\'fixture\',?,\'active\',?)")
      .run(`${id}-session`, id, `${id}-locator`, new Date().toISOString());
  }
  grantSelf(db, "worker");
  grantSelf(db, "other");
  const world = recordWorld(db, "nodes", "frame");
  const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture",
    capabilities: () => ["message.receive"], locate: async () => true,
    invoke: async () => ({ status: "accepted", hostRef: "fixture-host" }), async *receive() {} };
  const runtime = new CoreRuntime(db, new Map([["fixture", hythe]]), undefined, { observationOnly: true });
  const rpc = new CoreRpcServer(db, runtime, new Map([["fixture", hythe]]),
    { authenticate: token => {
      const match = Object.values(CORE_TOKENS).find(candidate => candidate.token === token);
      return match ? { kind: "node", nodeId: match.nodeId, sessionId: `${match.nodeId}-session` } : null;
    } }, undefined, project);
  return { project, db, world, runtime, rpc,
    close: async () => { runtime.close(); await rpc.close(); db.close(); } };
}

/** Two Nodes with two distinct Core credentials, so identity borrowing is testable. */
const CORE_TOKENS: Record<string, { nodeId: string; token: string }> = {
  worker: { nodeId: "worker", token: "worker-core-token" },
  other: { nodeId: "other", token: "other-core-token" },
};

/** Write the Human-owned runtime configuration the CLI resolves Node credentials from. */
function writeRuntimeSpec(project: string, corePort: number): void {
  writeFileSync(join(project, "runtime-spec.json"), JSON.stringify({ version: 1, corePort,
    chiefNodeId: "frame", nodes: Object.values(CORE_TOKENS).map(candidate => ({ nodeId: candidate.nodeId,
      displayName: candidate.nodeId, coreToken: candidate.token })) }));
}

const baseConfig = (project: string, corePort: number): GatewayWorkspaceConfig =>
  ({ version: 1, corePort, gatewayPort: 0, host: "127.0.0.1", edges: [] });

function edgeFor(target: "codex" | "dsh" | "grok-build", corePort: number,
  node: "worker" | "other", boundaryToken: string): GatewayEdge {
  return buildEdge(baseConfig("fixture", corePort), { id: target, boundNodeId: node,
    coreToken: CORE_TOKENS[node]!.token, token: boundaryToken });
}

async function connect(url: string, token: string) {
  const client = new Client({ name: "gateway-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test("N-T01 the gateway advertises one small stable surface regardless of internal capability count", () => {
  const registry = buildOperationRegistry({ port: 1, token: "schema-only" });
  assert.deepEqual([...GATEWAY_TOOL_NAMES], ["sidera_status", "sidera_capabilities", "sidera_read", "sidera_invoke", "sidera_work", "sidera_resource"]);
  const server = createGatewayServer({ port: 1, token: "schema-only" }, { registry }) as unknown as
    { _registeredTools: Record<string, unknown> };
  assert.deepEqual(Object.keys(server._registeredTools).sort(), [...GATEWAY_TOOL_NAMES].sort(),
    "the external surface must not grow with internal capability");
  assert.ok(registry.size >= 40, "the registry carries the internal capability");
});

test("N-T02 discovery answers from the registry and marks unregistered names instead of failing open", () => {
  const registry = buildOperationRegistry({ port: 1, token: "schema-only" });
  const catalog = capabilityCatalog(registry) as { registered: number;
    groups: Record<string, Array<{ operation: string; registered: boolean }>>;
    operations: Array<{ operation: string; registered: boolean }> };
  assert.equal(catalog.registered, registry.size);
  assert.equal(catalog.operations.length, registry.size, "the catalog lists exactly the registered operations");
  const resource = catalog.groups.resource!;
  assert.ok(resource.every(entry => entry.registered), "every resource operation must be registered in this build");
  assert.ok(catalog.groups.task!.some(entry => entry.operation === "task.dispatch" && entry.registered));
  // P0-A regression: the registry is derived from canonical registration, so the
  // constitutional operations Core already serves are dispatchable through the gateway.
  for (const operation of ["history.list", "omega.inspect", "rules.list", "rules.propose", "executor.list",
    "executor.assign", "chief.conversation_role", "node.ontology", "consequence.apply", "consequence.review_object",
    "conflict.resolve", "conflict.review_object", "claim.publish", "responsibility.trace", "grant.from_rules"])
    assert.ok(registry.has(operation), `Gateway registry must expose ${operation}`);
});

test("N-T02b the registry is exactly the canonical registration; no hand list can drift", () => {
  const registry = buildOperationRegistry({ port: 1, token: "schema-only" });
  const canonical = canonicalToolNames();
  assert.ok(canonical.length >= 70, "the canonical surface carries the internal capability");
  for (const tool of canonical) {
    const operation = canonicalOperationForTool(tool);
    assert.ok(registry.has(operation), `${tool} -> ${operation} must be registered`);
  }
  assert.equal(registry.size, canonical.length, "one operation per registered canonical tool");
  for(const operation of ["node.rename","project.source_read","history.event_get","chief.presentation_observe","chief.presentation_correct"])
    assert.ok(registry.has(operation),operation);
  assert.ok(!registry.has("node.unregistered"),"unregistered operations are not invented by the gateway");
});

test("N-T03 uncertain outcomes are never presented as retryable, and denials stay denials", () => {
  const uncertain = operationEnvelope("capability.invoke", {
    isError: true, content: [{ text: "uncertain: Core response timed out; do not resend" }] });
  const payload = JSON.parse((uncertain as { content: Array<{ text: string }> }).content[0]!.text) as
    { ok: boolean; outcome: string; recovery?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.outcome, "DENIED_OR_BLOCKED");
  const completed = operationEnvelope("resource.put", { resourceId: "r1" });
  const completedView=JSON.parse((completed as { content: Array<{ text: string }> }).content[0]!.text);
  assert.equal(completedView.ok,true);
  assert.equal(completedView.resendSafe,false,"An accepted or successful write is never replay permission");
});

test("N-T04 one listener authenticates every edge and maps each credential to its own Node", async () => {
  const f = fixture();
  const port = await f.rpc.listen();
  const listener = await startGatewayHttp([
    edgeFor("codex", port, "worker", "gateway-edge-token"),
    edgeFor("dsh", port, "other", "second-edge-token")], { port: 0 });
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${listener.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(unauthorized.status, 401, "an edge credential is required");
    const unknown = await fetch(`http://127.0.0.1:${listener.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-configured-edge" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(unknown.status, 401, "an unknown credential is refused before any Core call");

    const health = await fetch(`http://127.0.0.1:${listener.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { edges: number }).edges, 2, "one listener serves every HTTP edge");

    // Each boundary credential must resolve to its own bound Node principal on the
    // same endpoint. No edge may borrow another edge's identity.
    const first = await connect(`http://127.0.0.1:${listener.port}/mcp`, "gateway-edge-token");
    const firstSession = textOf(await first.callTool({ name: "sidera_invoke", arguments: {
      operation: "session.active", arguments: {} } }));
    assert.equal((firstSession as { nodeId?: string }).nodeId, "worker",
      "the Codex credential resolves to the worker Node");
    await first.close();

    const second = await connect(`http://127.0.0.1:${listener.port}/mcp`, "second-edge-token");
    const secondSession = textOf(await second.callTool({ name: "sidera_invoke", arguments: {
      operation: "session.active", arguments: {} } }));
    assert.equal((secondSession as { nodeId?: string }).nodeId, "other",
      "the DSH credential resolves to its own Node, not to the first edge's");
    await second.close();
  } finally { await listener.close(); await f.close(); }
});

test("N-T05 a real MCP client discovers and invokes operations through the stable surface", async () => {
  const f = fixture();
  const port = await f.rpc.listen();
  const listener = await startGatewayHttp([edgeFor("codex", port, "worker", "gateway-edge-token")], { port: 0 });
  try {
    const client = await connect(`http://127.0.0.1:${listener.port}/mcp`, "gateway-edge-token");
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...GATEWAY_TOOL_NAMES].sort());
    const discovery = textOf(await client.callTool({ name: "sidera_capabilities", arguments: { group: "resource" } }));
    const registry = buildOperationRegistry({ port, token: "worker-core-token" });
    assert.equal(discovery.registered, registry.size);
    assert.ok(registry.has("task.reconcile_result"), "Gateway must expose non-replaying Task result reconciliation");
    const self = textOf(await client.callTool({ name: "sidera_read", arguments: {
      operation: "session.active", arguments: {} } }));
    assert.equal(self.nodeId, "worker", "read-only stable invocation preserves exact edge principal");
    const refusedWrite = await client.callTool({ name: "sidera_read", arguments: {
      operation: "task.dispatch", arguments: {} } });
    assert.equal((refusedWrite as { isError?: boolean }).isError, true,
      "read-only stable tool must refuse mixed/write operations before Core");
    const status = textOf(await client.callTool({ name: "sidera_status", arguments: { include: ["runtime"] } }));
    assert.equal(status.operation, "sidera.status");
    assert.equal((status.runtime as { ready: boolean }).ready, true, "status resolves through the registry, not an invented RPC name");
    await client.close();
  } finally { await listener.close(); await f.close(); }
});

test("N-T06 Resource handoff round-trips bytes through the same cooperation system", async () => {
  const f = fixture();
  const port = await f.rpc.listen();
  const listener = await startGatewayHttp([edgeFor("codex", port, "worker", "gateway-edge-token")], { port: 0 });
  try {
    const client = await connect(`http://127.0.0.1:${listener.port}/mcp`, "gateway-edge-token");
    const publication = textOf(await client.callTool({ name: "sidera_resource", arguments: {
      operation: "put", arguments: { requestId: crypto.randomUUID(), name: "translation-input.txt",
        mediaType: "text/plain", origin: "human", sourceRef: "chat-attachment-1",
        dataText: "hello from a Chat attachment" } } }));
    assert.equal(publication.ok, true, JSON.stringify(publication));
    const record = (publication as { resource: { resourceId: string; sha256: string; byteSize: number } }).resource;
    assert.equal(record.byteSize, Buffer.byteLength("hello from a Chat attachment"), "exact bytes round-trip");
    assert.equal(record.sha256.length, 64, "the Resource is content-addressed");

    const readBack = textOf(await client.callTool({ name: "sidera_resource", arguments: {
      operation: "get", arguments: { resourceId: record.resourceId } } }));
    assert.equal(readBack.ok, true);
    assert.equal((readBack as { data: string }).data, "hello from a Chat attachment");

    const listed = textOf(await client.callTool({ name: "sidera_resource", arguments: {
      operation: "list", arguments: {} } }));
    assert.ok((listed as { resources: unknown[] }).resources.length >= 1);
    await client.close();
  } finally { await listener.close(); await f.close(); }
});

test("N-T07 resource reads are scoped: another Node cannot read what it was not given", async () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO nodes VALUES (?,?,\'active\',?)").run("outsider", "outsider", new Date().toISOString());
    f.db.prepare("INSERT INTO sessions VALUES (?,?,\'fixture\',\'fixture\',?,\'active\',?)")
      .run("outsider-session", "outsider", "outsider-locator", new Date().toISOString());
    grantSelf(f.db, "outsider");
    const { putResource, readResource, scopeResource } = await import("../core/resources.ts");
    const published = putResource(f.db, f.project, { nodeId: "worker", sessionId: "worker-session" },
      { requestId: crypto.randomUUID(), name: "private.txt", dataText: "private bytes", origin: "human" });
    assert.throws(() => readResource(f.db, f.project, { nodeId: "outsider", sessionId: "outsider-session" },
      published.resource.resourceId), (error: Error) => /denied|authorized scope/.test(error.message),
        "existence must not imply visibility");
    scopeResource(f.db,{nodeId:"worker",sessionId:"worker-session"},{requestId:crypto.randomUUID(),
      resourceId:published.resource.resourceId,targetNodeId:"outsider",basis:"explicit test handoff"});
    assert.equal(readResource(f.db,f.project,{nodeId:"outsider",sessionId:"outsider-session"},
      published.resource.resourceId).data,"private bytes",
      "a denied safe read must remain retryable after an explicit later scope");
  } finally { await f.close(); }
});

test("N-T08 every release target has an explicit import path and its own edge health", () => {
  const config: GatewayWorkspaceConfig = { version: 1, corePort: 8765, gatewayPort: 8788, host: "127.0.0.1",
    coreToken: "core-token", edges: TARGET_EDGES.map(edge => ({ id: edge.id, boundNodeId: `${edge.id}-node`,
      token: `${edge.id}-edge-token` })) };
  const registry = buildOperationRegistry({ port: 1, token: "schema-only" });
  const { profiles, markdown } = generateEdgeProfiles(config, { registry });
  assert.equal(profiles.length, 7);
  assert.deepEqual(profiles.map(profile => profile.id), [...TARGET_EDGES].map(edge => edge.id));
  for (const profile of profiles) {
    assert.ok(profile.importConfig, `${profile.id} must have a concrete import configuration`);
    assert.ok(profile.humanSteps.length >= 0);
    assert.match(markdown, new RegExp(profile.product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const chatGpt = profiles.find(profile => profile.id === "chatgpt")!;
  assert.equal(chatGpt.transport, "network-http");
  assert.match(JSON.stringify(chatGpt.importConfig), /streamable-http/);
  const codex = profiles.find(profile => profile.id === "codex")!;
  assert.equal(codex.transport, "loopback-http");
  assert.notEqual(codex.edgeHealth, "ONLINE", "no edge may claim ONLINE from configuration alone");
  const spark = profiles.find(profile => profile.id === "gemini-spark")!;
  assert.notEqual(spark.boundNodeId, chatGpt.boundNodeId, "Chat and Spark keep separate Node identity");
  assert.match(renderMatrix(profiles), /\| ChatGPT \| chat \|/);
});

/** The stdio transport is the same gateway server: a local client that launches
 * Sidera as a subprocess gets identical operations and identical authority. */
test("N-T09 stdio transport serves the same stable surface as HTTP", async () => {
  const f = fixture();
  const port = await f.rpc.listen();
  writeRuntimeSpec(f.project, port);
  const stdioConfig = join(f.project, "gateway.json");
  writeFileSync(stdioConfig, JSON.stringify({ version: 1, corePort: port, gatewayPort: 0, host: "127.0.0.1",
    edges: [{ id: "codex", boundNodeId: "worker", coreToken: CORE_TOKENS.worker!.token, token: "std" }] }));
  const stdioEnv = { ...process.env, SIDERA_CORE_PORT: String(port), SIDERA_GATEWAY_CONFIG: stdioConfig };
  const child: ChildProcess = spawn(process.execPath, ["hythes/mcp-gateway-cli.ts", "stdio"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env: stdioEnv, stdio: ["pipe", "pipe", "pipe"] });
  const client = new Client({ name: "stdio-client", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["hythes/mcp-gateway-cli.ts", "stdio"],
      env: stdioEnv }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...GATEWAY_TOOL_NAMES].sort());
    const publication = textOf(await client.callTool({ name: "sidera_resource", arguments: {
      operation: "put", arguments: { requestId: crypto.randomUUID(), name: "spark-media-input.bin",
        dataBase64: Buffer.from([0, 1, 2, 3, 250]).toString("base64"), mediaType: "application/octet-stream" } } }));
    const record = (publication as { resource: { resourceId: string; byteSize: number } }).resource;
    assert.equal(record.byteSize, 5);
    const readBack = textOf(await client.callTool({ name: "sidera_resource", arguments: {
      operation: "get", arguments: { resourceId: record.resourceId, asBase64: true } } }));
    assert.equal((readBack as { data: string }).data, Buffer.from([0, 1, 2, 3, 250]).toString("base64"),
      "binary round-trips byte-exactly over stdio");
    await client.close();
  } finally {
    await client.close().catch(() => {});
    child.kill();
    await f.close();
  }
});

/** End-to-end operator path: boot the real CLI gateway and use it through a
 * real MCP client. No tunnel, no browser, no product-side account. */
test("N-T10 the CLI boots a live edge that serves the stable surface", async () => {
  const f = fixture();
  const port = await f.rpc.listen();
  const gatewayPort = 8801 + (process.pid % 60);
  const configPath = join(f.project, "gateway.json");
  writeRuntimeSpec(f.project, port);
  writeFileSync(configPath, JSON.stringify({ version: 1, corePort: port, gatewayPort, host: "127.0.0.1",
    edges: [{ id: "codex", boundNodeId: "worker", coreToken: CORE_TOKENS.worker!.token, token: "codex-edge-token" }] }));
  const env = { ...process.env, SIDERA_GATEWAY_CONFIG: configPath, SIDERA_CORE_PORT: String(port),
    SIDERA_GATEWAY_PORT: String(gatewayPort) };
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["hythes/mcp-gateway-cli.ts", "serve"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { ready = (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok; } catch { /* still starting */ }
    }
    assert.ok(ready, "the gateway must come up from the real CLI without a tunnel");
    const client = await connect(`http://127.0.0.1:${gatewayPort}/mcp`, "codex-edge-token");
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...GATEWAY_TOOL_NAMES].sort());
    const status = textOf(await client.callTool({ name: "sidera_status", arguments: { include: ["edges"] } }));
    const edges = status.edges as Array<{ health: string; status: string }>;
    assert.equal(edges.length, 7, "all seven release targets are reported");
    assert.ok(edges.every(edge => edge.health !== "ONLINE"), "no edge claims ONLINE without a real round trip");
    await client.close();
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); setTimeout(resolve, 1500); });
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    await f.close();
  }
});

test("N-T11 release profiles generate per-edge import configuration", () => {
  const f = fixture();
  try {
    const port = 8765;
    const config: GatewayWorkspaceConfig = { version: 1, corePort: port, gatewayPort: 8788, host: "127.0.0.1",
      coreToken: "worker-core-token", edges: TARGET_EDGES.map(edge => ({ id: edge.id, boundNodeId: `${edge.id}-node`,
        token: `${edge.id}-token` })) };
    const registry = buildOperationRegistry({ port, token: "worker-core-token" });
    const { profiles, markdown } = generateEdgeProfiles(config, { registry });
    for (const profile of profiles) {
      assert.ok(profile.importConfig, `${profile.id} must have a concrete import configuration`);
      assert.match(markdown, new RegExp(profile.product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${profile.id} must appear in the compatibility matrix`);
    }
    const byId = new Map(profiles.map(profile => [profile.id, profile]));
    assert.equal(byId.get("chatgpt")!.transport, "network-http");
    assert.match(JSON.stringify(byId.get("chatgpt")!.importConfig), /streamable-http/);
    assert.equal(byId.get("codex")!.transport, "loopback-http");
    assert.notEqual(byId.get("codex")!.boundNodeId, byId.get("gemini-spark")!.boundNodeId,
      "a shared connector mechanism never merges Node identity");
    assert.ok(profiles.every(profile => profile.edgeHealth !== "ONLINE"));
  } finally { void f.close(); }
});

/** The real import failure modes: an unresolvable Node must fail loudly, and a
 * product must never receive a Core credential. */
test("N-T12 an unresolvable bound Node fails the listener instead of falling back to another identity", async () => {
  const f = fixture();
  const port = await f.rpc.listen();
  // A runtime spec that declares only worker. An edge bound to "other" must not
  // silently become worker or the workspace default.
  writeFileSync(join(f.project, "runtime-spec.json"), JSON.stringify({ version: 1, corePort: port,
    chiefNodeId: "worker", nodes: [{ nodeId: "worker", displayName: "worker", coreToken: CORE_TOKENS.worker!.token }] }));
  const configPath = join(f.project, "gateway.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, corePort: port, gatewayPort: 8809, host: "127.0.0.1",
    edges: [{ id: "dsh", boundNodeId: "other", coreToken: undefined, token: "dsh-edge-token" }] }));
  const env = { ...process.env, SIDERA_GATEWAY_CONFIG: configPath, SIDERA_CORE_PORT: String(port) };
  const child = spawn(process.execPath, ["hythes/mcp-gateway-cli.ts", "serve"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>(resolve => {
    child.once("exit", code => resolve(code));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, 8000);
  });
  assert.notEqual(exitCode, 0, "serve must refuse to start with an unresolved Node");
  assert.match(stderr, /Cannot resolve Node other/, "the failure must name the unresolvable Node");
  assert.match(stderr, /Refusing to fall back|will not fall back|not declared/,
    "the failure must say that no fallback identity is used");
  await f.close();
});

test("N-T13 generated product configuration carries only the boundary credential", () => {
  const config: GatewayWorkspaceConfig = { version: 1, corePort: 8765, gatewayPort: 8788, host: "127.0.0.1",
    edges: [{ id: "codex", boundNodeId: "worker", coreToken: "SECRET-core-principal-token",
      token: "boundary-token-for-product" }] };
  const { profiles } = generateEdgeProfiles(config, { registry: buildOperationRegistry({ port: 1, token: "x" }) });
  for (const profile of profiles) {
    const serialized = JSON.stringify(profile);
    assert.ok(!serialized.includes("SECRET-core-principal-token"),
      `${profile.id} must never expose a Core credential to the product`);
    if (profile.importConfig) {
      assert.ok(!JSON.stringify(profile.importConfig).includes("SECRET-core-principal-token"));
      assert.ok(!/(coreToken|SIDERA_GATEWAY_CORE_TOKEN)/.test(JSON.stringify(profile.importConfig)),
        `${profile.id} import config must not mention Core credentials at all`);
    }
  }
});

test("Gateway validates canonical input before a callback can discard a Sovereignty selector",async()=>{
 const registry=buildOperationRegistry({port:1,token:"schema-only"});
 for(const key of ["nodeId","nodeRef","targetNodeId","subjectNodeId","operatorNodeRef"])
  for(const value of ["other",null])await assert.rejects(registry.get("subjectivity.get")!.invoke({[key]:value}),/Unrecognized key/);
 await assert.rejects(registry.get("subjectivity.revise")!.invoke({requestId:randomUUID(),expectedRevision:0,description:"D",explanation:"E",nodeId:"other"}),/Unrecognized key/);
});

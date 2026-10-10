import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { openDatabase } from "../core/db.ts";
import type { ChiefBinding } from "../core/chief.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";
import { FrontendAdapterRegistry } from "../hythes/frontend-registry.ts";
import { frontendFactory } from "../hythes/frontend-factory.ts";
import { McpFrontendRoute } from "../hythes/mcp-frontend.ts";
import { hostManifest } from "../hythes/manifest.ts";
import { providerAdmissionProfile } from "../hythes/effect-control.ts";
import { effectAwareRoute } from "../core/control-plane.ts";
import { HumanBoundary } from "../hythes/human-boundary.ts";
import { bindChiefConversation } from "./fixtures/chief.ts";

function binding(frontendKind: string): ChiefBinding {
  return { bindingId: `binding-${frontendKind}`, projectSpaceId: "fixture", projectRef: "fixture", chiefNodeId: "chief", frontendKind,
    conversationRef: `${frontendKind}://conversation/exact`, state: "active" };
}

test("Frontend registry isolates multiple Chat kinds and leaves unavailable adapters closed", async () => {
  const calls: string[] = [];
  const registry = new FrontendAdapterRegistry().register("fixture", spec => ({
    id: spec.id, routeClass: "protocol", effectProfile: () => providerAdmissionProfile(spec.frontendKind, "fixture"),
    manifest: hostManifest({ hytheId: spec.id, hostKind: spec.frontendKind }, { operations: ["conversation.locate", "conversation.send"], routeClass: "protocol", createsSession: false }),
    invoke: async (_operation, target) => { calls.push(target.frontendKind); return { status: "host_confirmed", data: { located: true, conversationRef: target.conversationRef } }; },
  })).register("retired-ui", spec => ({
    id: spec.id, routeClass: "ui-fallback", manifest: hostManifest({ hytheId: spec.id, hostKind: "fixture" }, { operations: ["conversation.send"], routeClass: "ui-fallback", createsSession: false }),
    invoke: async () => { throw new Error("Browser must not be called"); },
  }));
  const routes = await registry.create([
    { id: "alpha", adapter: "fixture", frontendKind: "alpha-chat", bindings: [{ projectSpaceId: "alpha", conversationRef: "alpha-chat://conversation/exact" }], options: {} },
    { id: "beta", adapter: "fixture", frontendKind: "beta-chat", bindings: [{ projectSpaceId: "beta", conversationRef: "beta-chat://conversation/exact" }], options: {} },
    { id: "offline", adapter: "uninstalled", frontendKind: "offline-chat", options: {} },
    { id: "ui", adapter: "retired-ui", frontendKind: "alpha-chat", options: {} },
  ], ".");
  assert.equal(routes[0]!.supportsBinding!(binding("beta-chat")), false);
  assert.equal((await routes[0]!.invoke("conversation.locate", binding("beta-chat"))).status, "rejected");
  assert.equal((await routes[1]!.invoke("conversation.locate", { ...binding("beta-chat"), projectSpaceId: "beta" })).status, "host_confirmed");
  assert.deepEqual(calls, ["beta-chat"]);
  assert.equal(routes[2]!.requirementSatisfied!(), false);
  assert.equal(routes[3]!.requirementSatisfied!(), false);
  assert.ok(routes.every(route => route.routeClass !== "ui-fallback"));
  await assert.rejects(registry.create([{ id: "same", adapter: "fixture", frontendKind: "a", options: {} }, { id: "same", adapter: "fixture", frontendKind: "b", options: {} }], "."), /unique/);
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO nodes VALUES ('chief','Chief','active',?)").run(new Date().toISOString());
    const alpha = bindChiefConversation(db, { kind: "human" }, { projectSpaceId: "alpha", projectRef: "fixture", chiefNodeId: "chief", frontendKind: "alpha-chat", conversationRef: "alpha-chat://conversation/exact" });
    const beta = bindChiefConversation(db, { kind: "human" }, { projectSpaceId: "beta", projectRef: "fixture", chiefNodeId: "chief", frontendKind: "beta-chat", conversationRef: "beta-chat://conversation/exact" });
    const boundary = new HumanBoundary(db, routes);
    assert.equal((await boundary.verifyPresence(alpha)).routeId, "alpha");
    assert.equal((await boundary.verifyPresence(beta)).routeId, "beta");
    assert.equal(boundary.effectProfile(alpha)?.id, routes[0]!.effectProfile!().id);
    assert.equal(boundary.effectProfile(beta)?.id, routes[1]!.effectProfile!().id);
    assert.notEqual(boundary.effectProfile(alpha)?.id, boundary.effectProfile(beta)?.id);
    assert.equal(boundary.restore(alpha).routeId, "alpha");
    assert.equal(boundary.effectProfile(beta)?.id, routes[1]!.effectProfile!().id, "Reading one binding must not replace another prepared route");
    await boundary.close();
    const empty = await frontendFactory(db, ".", { routes: [] }, registry);
    assert.equal((await empty.inspect(binding("alpha-chat"))).ready, false);
    await empty.close?.();
  } finally { db.close(); }
});

test("Generic MCP frontend uses authenticated exact protocol calls and never retries uncertain send", async () => {
  const envName = "SIDERA_TEST_FRONTEND_TOKEN", previous = process.env[envName];
  process.env[envName] = "fixture-authentication";
  let accepted = 0, crossings = 0, wrongLocator = false;
  const observed: Array<{ conversationRef: string; bindingId: string }> = [];
  const servers = new Set<McpServer>();
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-authentication") { res.writeHead(401); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const server = new McpServer({ name: "fixture-human-host", version: "1" }); servers.add(server);
    for (const operation of ["locate", "send"] as const) server.registerTool(operation, {
      inputSchema: { conversationRef: z.string(), bindingId: z.string(), body: z.string().optional() },
    }, async input => {
      observed.push(input);
      if (operation === "send") accepted++;
      const output = { status: operation === "locate" ? "host_confirmed" : "accepted", hostRef: operation === "send" ? "actual-host-turn" : undefined,
        data: { located: true, conversationRef: wrongLocator ? "another-chat://wrong" : input.conversationRef } };
      return { content: [{ type: "text", text: JSON.stringify(output) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    let body = ""; for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, JSON.parse(body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  const route = new McpFrontendRoute({ id: "other-chat", adapter: "mcp-http", frontendKind: "other-chat",
    bindings: [{ projectSpaceId: "fixture", conversationRef: "other-chat://conversation/exact" }], options: {
    endpoint: `http://127.0.0.1:${port}/mcp`, authTokenEnv: envName, operations: { "conversation.locate": "locate", "conversation.send": "send" },
  } });
  const target = binding("other-chat");
  const boundary: EffectBoundary = { cross(actual, send) { crossings++; assert.deepEqual(actual, { product: target.frontendKind, locator: target.conversationRef, operation: "conversation.send" }); return send(); } };
  try {
    assert.equal((await route.invoke("conversation.locate", target)).status, "host_confirmed");
    assert.equal((await route.invoke("conversation.send", target, { body: "fixture" })).status, "rejected");
    const delivered = await route.invoke("conversation.send", target, { body: "fixture", conversationRef: "cannot-override", bindingId: "cannot-override" }, boundary);
    assert.equal(delivered.status, "accepted"); assert.equal(delivered.hostRef, "actual-host-turn");
    assert.equal(accepted, 1); assert.equal(crossings, 1);
    assert.ok(observed.every(item => item.conversationRef === target.conversationRef && item.bindingId === target.bindingId));
    wrongLocator = true;
    const uncertain = await effectAwareRoute("conversation.send", target.conversationRef, [{ id: route.id, routeClass: "protocol", logicalLocator: target.conversationRef,
      invoke: () => route.invoke("conversation.send", target, { body: "uncertain fixture" }, boundary) }]);
    assert.equal(uncertain.status, "UNCERTAIN"); assert.equal(accepted, 2); assert.equal(crossings, 2);
    delete process.env[envName]; assert.equal(route.requirementSatisfied(), false);
  } finally {
    await route.close(); await Promise.all([...servers].map(server => server.close()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  }
});

test("Protocol routes require explicit exact scope while legacy native single-endpoint configuration remains usable", async () => {
  let invoked = 0;
  const registry = new FrontendAdapterRegistry();
  for (const routeClass of ["native", "protocol"] as const) registry.register(routeClass, spec => ({
    id: spec.id, routeClass,
    manifest: hostManifest({ hytheId: spec.id, hostKind: spec.frontendKind }, { operations: ["conversation.locate"], routeClass, createsSession: false }),
    invoke: async () => { invoked++; return { status: "host_confirmed" }; },
  }));
  const routes = await registry.create([
    { id: "legacy-native", adapter: "native", frontendKind: "same-chat", options: {} },
    { id: "unscoped-protocol", adapter: "protocol", frontendKind: "same-chat", options: {} },
    { id: "incomplete-protocol", adapter: "protocol", frontendKind: "same-chat", bindings: [{ projectSpaceId: "fixture", conversationRef: "" }], options: {} },
  ], ".");
  assert.equal(routes[0]!.supportsBinding!(binding("same-chat")), true);
  assert.equal((await routes[0]!.invoke("conversation.locate", binding("same-chat"))).status, "host_confirmed");
  for (const route of routes.slice(1)) {
    assert.equal(route.supportsBinding!(binding("same-chat")), false);
    assert.equal(route.requirementSatisfied!(), false);
    assert.equal((await route.invoke("conversation.locate", binding("same-chat"))).status, "rejected");
  }
  assert.equal(invoked, 1);
  assert.throws(() => new McpFrontendRoute({ id: "unscoped", adapter: "mcp-http", frontendKind: "same-chat", options: {} }), /explicit exact binding scope/);
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO nodes VALUES ('chief','Chief','active',?)").run(new Date().toISOString());
  const compatibility = await frontendFactory(db, ".", { kind: "chatgpt-ui", options: { nativeServerPath: "unused-native-fixture" } });
  try {
    assert.equal((await compatibility.inspect(binding("other-chat"))).ready, false);
    // Construction/inspection neither launches this unused native path nor opens a browser.
  } finally { await compatibility.close?.(); db.close(); }
});

test("Two authenticated endpoints of the same Chat kind receive only their exact scoped binding", async () => {
  const envNames = ["SIDERA_FRONTEND_ACCOUNT_A", "SIDERA_FRONTEND_ACCOUNT_B"];
  const previous = envNames.map(name => process.env[name]);
  envNames.forEach((name, index) => { process.env[name] = `fixture-account-${index}`; });
  const requests = [0, 0];
  const observed: Array<Array<{ projectSpaceId: string; conversationRef: string; bindingId: string; body?: string }>> = [[], []];
  const servers = new Set<McpServer>();
  const endpoints = [0, 1].map(index => createServer(async (req, res) => {
    requests[index] = requests[index]! + 1;
    if (req.headers.authorization !== `Bearer fixture-account-${index}`) { res.writeHead(401); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const server = new McpServer({ name: `fixture-account-${index}`, version: "1" }); servers.add(server);
    for (const operation of ["locate", "send"]) server.registerTool(operation, {
      inputSchema: { projectSpaceId: z.string(), conversationRef: z.string(), bindingId: z.string(), body: z.string().optional() },
    }, async input => {
      observed[index]!.push(input);
      return { content: [{ type: "text", text: JSON.stringify({
        status: operation === "locate" ? "host_confirmed" : "accepted", hostRef: operation === "send" ? `host-turn-${index}` : undefined,
        data: { conversationRef: input.conversationRef, located: true },
      }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    let body = ""; for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, JSON.parse(body));
  }));
  await Promise.all(endpoints.map(http => new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve))));
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO nodes VALUES ('chief','Chief','active',?)").run(new Date().toISOString());
  const targets = ["account-project-a", "account-project-b"].map((projectSpaceId, index) => bindChiefConversation(db, { kind: "human" }, {
    projectSpaceId, projectRef: "fixture", chiefNodeId: "chief", frontendKind: "same-chat", conversationRef: `same-chat://conversation/exact-${index}`,
  }));
  const specs = targets.map((target, index) => ({ id: `account-${index}`, adapter: "mcp-http", frontendKind: "same-chat",
    bindings: [{ projectSpaceId: target.projectSpaceId, conversationRef: target.conversationRef, bindingId: target.bindingId }], options: {
      endpoint: `http://127.0.0.1:${(endpoints[index]!.address() as { port: number }).port}/mcp`, authTokenEnv: envNames[index],
      operations: { "conversation.locate": "locate", "conversation.send": "send" },
    } }));
  const direct = new McpFrontendRoute(specs[0]!);
  const registry = new FrontendAdapterRegistry().register("mcp-http", spec => new McpFrontendRoute(spec));
  const routes = await registry.create(specs, ".");
  const human = new HumanBoundary(db, routes);
  let crossings = 0;
  const effect: EffectBoundary = { cross(_actual, send) { crossings++; return send(); } };
  try {
    assert.equal(direct.supportsBinding(targets[1]!), false);
    assert.equal((await direct.invoke("conversation.send", targets[1]!, { body: "must-not-leak" }, effect)).status, "rejected");
    assert.equal((await routes[0]!.invoke("conversation.locate", targets[1]!)).status, "rejected");
    assert.equal((await routes[1]!.invoke("conversation.send", targets[0]!, { body: "must-not-leak" }, effect)).status, "rejected");
    assert.deepEqual(requests, [0, 0], "Even protocol initialization must not contact a wrong account endpoint");
    assert.equal(crossings, 0);
    for (const changed of [
      { ...targets[0]!, bindingId: "different-binding" },
      { ...targets[0]!, conversationRef: "same-chat://conversation/different" },
      { ...targets[0]!, projectSpaceId: "different-project" },
    ]) assert.equal(direct.supportsBinding(changed), false);
    const changedEndpoint = new McpFrontendRoute({ ...specs[0]!, options: { ...specs[0]!.options, endpoint: specs[1]!.options.endpoint } });
    const changedCredential = new McpFrontendRoute({ ...specs[0]!, options: { ...specs[0]!.options, authTokenEnv: envNames[1] } });
    assert.notEqual(direct.effectProfile().id, changedEndpoint.effectProfile().id);
    assert.notEqual(direct.effectProfile().id, changedCredential.effectProfile().id);
    await changedEndpoint.close(); await changedCredential.close();
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!;
      assert.equal((await human.verifyPresence(target)).routeId, specs[index]!.id);
      const result = await routes[index]!.invoke("conversation.send", target, {
        body: `account-${index}-private-result`, projectSpaceId: "cannot-override", bindingId: "cannot-override", conversationRef: "cannot-override",
      }, effect);
      assert.equal(result.hostRef, `host-turn-${index}`);
    }
    assert.equal(crossings, 2);
    assert.notEqual(human.effectProfile(targets[0]!)?.id, human.effectProfile(targets[1]!)?.id);
    for (let index = 0; index < targets.length; index++) {
      assert.equal(human.restore(targets[index]!).routeId, specs[index]!.id);
      assert.equal(observed[index]!.filter(item => item.body !== undefined).length, 1);
      assert.ok(observed[index]!.every(item => item.bindingId === targets[index]!.bindingId && item.projectSpaceId === targets[index]!.projectSpaceId && item.conversationRef === targets[index]!.conversationRef));
      assert.equal(observed[index]!.find(item => item.body !== undefined)!.body, `account-${index}-private-result`);
    }
    specs[0]!.bindings[0]!.projectSpaceId = targets[1]!.projectSpaceId;
    assert.equal(direct.supportsBinding(targets[0]!), true, "Caller config mutation cannot silently broaden a prepared route");
    assert.equal(routes[0]!.supportsBinding!(targets[1]!), false);
  } finally {
    await direct.close(); await human.close(); db.close();
    await Promise.all([...servers].map(server => server.close()));
    await Promise.all(endpoints.map(http => new Promise<void>(resolve => http.close(() => resolve()))));
    envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});

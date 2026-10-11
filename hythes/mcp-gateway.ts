import {projectSupport, INTEGRATION_SUBJECTS, subject, type InterfaceSupport} from '../core/evidence-governance.ts';
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Server as NetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { canonicalMcpServer } from "./canonical-mcp.ts";
import { canonicalOperationForTool } from "./tool-catalog.ts";
import { EdgeOAuthProvider, type OAuthConfig, type OAuthEdgeClient } from "./mcp-oauth.ts";
import { startLocalOAuthConsent } from "./oauth-local-consent.ts";
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { type CoreClientConfig } from "./core-client.ts";

/**
 * Sidera MCP Gateway — the stable northbound machine interface.
 *
 * Product direction, in one sentence: an external product reaches Sidera through
 * MCP (or its official equivalent) and every request resolves into a canonical
 * registered Sidera operation; the product is never the identity and the
 * connection is never the Node.
 *
 * Design rules enforced here:
 *  - A small, long-lived tool surface (six tools) so client tool-schema caching
 *    cannot rot as internal capability grows. Growth happens in the operation
 *    registry, which is discovered dynamically at call time.
 *  - No arbitrary-code endpoint. Every operation is a registered name; the
 *    registry is built from the canonical server, so a name that is not
 *    registered is not dispatchable.
 *  - The MCP connection carries transport identity only. Core still resolves the
 *    Node Session, World, Capability, Authority, Presence and the final Effect
 *    boundary. A gateway can never mint authority by existing.
 *  - Transport is not architecture. stdio, loopback HTTP and network HTTP serve
 *    the same server and the same operations; a tunnel may wrap the network
 *    listener, and its death cannot change Sidera state.
 */

/**
 * The single canonical stable northbound surface. There is exactly one list of
 * tool names in the codebase; every status/manifest/profile path reads it rather
 * than restating it. The *operations* behind these tools are no longer listed
 * here at all: they are derived from the canonical MCP registration, so the
 * internal operation catalog grows automatically as capability is registered.
 */
export const GATEWAY_TOOL_NAMES = ["sidera_status", "sidera_capabilities", "sidera_read", "sidera_invoke", "sidera_work", "sidera_resource"] as const;

export const TARGET_EDGE_IDS = ["chatgpt", "grok-chat", "gemini-chat", "codex", "dsh", "grok-build",
  "gemini-spark"] as const;
export type TargetEdgeId = typeof TARGET_EDGE_IDS[number];

export interface TargetEdge {
  id: TargetEdgeId;
  product: string;
  side: "chat" | "agent";
  /** The official machine interface this edge is expected to use. */
  mechanism: string;
  /** Transport shape Sidera must offer for this edge. */
  transport: "stdio" | "loopback-http" | "network-http";
  /** True when this edge cannot construct a Node identity itself and must bind one. */
  requiresBoundNode: boolean;
  interfaceSupport: InterfaceSupport;
  /** Official-product limitations Sidera cannot engineer around. */
  limits: string[];
  /** Human product-side steps that code cannot perform. */
  humanSteps: string[];
  /** Evidence class for the row. */
  evidence: "adapter-verified" | "protocol-test-verified" | "documented" | "UNVERIFIED";
}

/**
 * Edge health is per edge and derives from durable observations. One edge going
 * DEGRADED or OFFLINE never writes global "not ready", never rewrites Node or
 * Authority truth, and never cancels durable work.
 */
export type EdgeHealth = "ONLINE" | "DEGRADED" | "OFFLINE" | "UNKNOWN";

export interface EdgeState {
  id: TargetEdgeId;
  product: string;
  side: "chat" | "agent";
  mechanism: string;
  transport: TargetEdge["transport"];
  interfaceSupport: TargetEdge["interfaceSupport"];
  health: EdgeHealth;
  runtimeConnectivity: "UNKNOWN";
  support: ReturnType<typeof edgeSupport>;
  /** Why the health value is what it is. Never a substitute for observation. */
  basis: string;
  limits: string[];
  humanSteps: string[];
  evidence: TargetEdge["evidence"];
}

interface RegisteredOperation {
  operation: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

function schemaToJson(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const candidate = schema as { toJSONSchema?: () => unknown };
  try { if (typeof candidate.toJSONSchema === "function") return candidate.toJSONSchema(); }
  catch { /* fall through to the Core-side validation note */ }
  return { type: "object", properties: {}, note: "arguments are validated by Core at invocation" };
}

/** Introspect the canonical server for the authoritative operation registry.
 * Membership comes from canonical registration: every registered canonical tool
 * is dispatchable and nothing else is. The dotted operation label is derived by
 * `canonicalOperationForTool`, so a newly registered tool cannot be forgotten
 * here and a stale hand-written operation list cannot hide it. */
export function buildOperationRegistry(core: CoreClientConfig): Map<string, RegisteredOperation> {
  const canonical = canonicalMcpServer(core) as unknown as {
    _registeredTools: Record<string, { title?: string; description?: string; inputSchema?: unknown;
      annotations?: Record<string, unknown>; handler: (args: never, extra: never) => Promise<unknown> }>;
  };
  const byToolName = new Map(Object.entries(canonical._registeredTools ?? {}));
  const registry = new Map<string, RegisteredOperation>();
  for (const [toolName, tool] of byToolName) {
    const operation = canonicalOperationForTool(toolName);
    if (registry.has(operation))
      throw new Error(`Canonical tools collide on operation ${operation}; the registry cannot be ambiguous`);
    registry.set(operation, { operation, title: tool.title, description: tool.description ?? "",
      inputSchema: schemaToJson(tool.inputSchema), annotations: tool.annotations,
      invoke: async args => {
        // Calling handlers directly must preserve canonical schema validation.
        // Strict objects also refuse selectors a callback would otherwise discard.
        const schema=tool.inputSchema as {strict?():{parseAsync(value:unknown):Promise<unknown>};parseAsync?(value:unknown):Promise<unknown>}|undefined;
        if(!schema?.parseAsync)throw new Error("Canonical input schema is unavailable");
        const input=await (schema.strict?.()??schema).parseAsync!(args);
        return tool.handler(input as never,{signal:new AbortController().signal} as never);
      } });
  }
  return registry;
}

/**
 * The eight release targets. Status is a claim about this repository plus the
 * machine interface the target offers; it is never a claim that a product-side
 * account is logged in. Static implementation is separate from runtime connectivity.
 * A correlated observation is required to claim an observed connection.
 */
export const TARGET_EDGES: readonly TargetEdge[] = [
  { id: "chatgpt", product: "ChatGPT", side: "chat",
    mechanism: "MCP client over remote/streamable HTTP; native app-tools bridge for the exact bound Chat",
    transport: "network-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["Cloud Chat cannot reach a loopback endpoint; remote reachability or the executor-authenticated native bridge is required",
      "Exact conversation binding is Human-owned and cannot be inferred from a tool call"],
    humanSteps: ["Approve the Sidera connector/plugin in the product", "Select the exact existing Chat that should act as Primary",
      "Import the generated connector configuration"],
    evidence: "protocol-test-verified" },
  { id: "grok-chat", product: "Grok Chat", side: "chat",
    mechanism: "MCP client via the generic external-mcp-client Host; custom MCP connector on a publicly reachable endpoint",
    transport: "network-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["Cloud Chat cannot reach a loopback endpoint; the shared Gateway endpoint needs a tunnel or public ingress",
      "Same-account Chat and Build variants share cloud resources but are not one Node, Session, permission set or lifecycle"],
    humanSteps: ["Run the Human authority grant for this Node", "Add the custom MCP connector with this edge's credential",
      "Publish the Gateway endpoint through the tunnel or ingress"],
    evidence: "adapter-verified" },
  { id: "gemini-chat", product: "Gemini Chat", side: "chat",
    mechanism: "MCP client via the generic external-mcp-client Host; Gemini custom Connected App with an MCP server URL",
    transport: "network-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["Chat and Spark may share a connector mechanism while remaining different Nodes with different Authority",
      "A single shared connector that cannot distinguish callers is a PRODUCT_IDENTITY_GRANULARITY_LIMIT, not an identity merge"],
    humanSteps: ["Run the Human authority grant for this Node", "Add the custom Connected App with this edge's credential",
      "Publish the Gateway endpoint through the tunnel or ingress"],
    evidence: "adapter-verified" },
  { id: "codex", product: "Codex", side: "agent",
    mechanism: "MCP client over loopback HTTP or stdio; independent app-server Session",
    transport: "loopback-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["An app-server executor context is required for the native Human return path; an arbitrary terminal does not acquire it"],
    humanSteps: [], evidence: "adapter-verified" },
  { id: "dsh", product: "DeepSeek Harness", side: "agent",
    mechanism: "ACP harness; MCP client for its own tool surface",
    transport: "loopback-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["The exact Host Session must be executable now; protocol connection alone is not Presence"],
    humanSteps: ["Start the exact Harness Session", "Approve the generated MCP binding"],
    evidence: "adapter-verified" },
  { id: "grok-build", product: "Grok Build", side: "agent",
    mechanism: "ACP build client; MCP client for its own tool surface",
    transport: "loopback-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["Host availability and plan/region restrictions are runtime facts"],
    humanSteps: ["Start the exact Build Session", "Approve the generated MCP binding"],
    evidence: "adapter-verified" },
  { id: "gemini-spark", product: "Gemini Spark", side: "agent",
    mechanism: "MCP client via the generic external-mcp-client Host; the same custom-app mechanism with its own connector instance",
    transport: "network-http", requiresBoundNode: true, interfaceSupport: "IMPLEMENTED",
    limits: ["Spark and Chat are separate Nodes even where a connector mechanism is shared",
      "Bulk media work is bounded by the product's own limits, not by Sidera",
      "Never reuse the Gemini Chat credential for Spark"],
    humanSteps: ["Run the Human authority grant for this Node", "Register this edge as its own connector instance",
      "Publish the Gateway endpoint through the tunnel or ingress"],
    evidence: "adapter-verified" },
] as const;

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const left = Buffer.from(actual.slice(7)), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function envelope(operation: string, value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ operation, ...(value as object) }) }] };
}

/** A canonical tool answers with its own content block. The gateway unwraps it so
 * a machine client sees one payload level, not transport-in-transport nesting.
 * The operation name is always preserved, so a result is self-describing. */
export function envelopeValue(operation: string, value: unknown): unknown {
  const content = (value as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (content?.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string") {
    try {
      const parsed = JSON.parse(content[0].text) as unknown;
      return { operation, ...(parsed as object) };
    } catch { return { operation, text: content[0].text }; }
  }
  return { operation, result: value };
}

/** Normalize an operation outcome. A transport error is not a task failure and
 * "uncertain" must never be presented as a retry instruction. */
export function operationEnvelope(operation: string, value: unknown) {
  if (value && typeof value === "object" && (value as { isError?: boolean }).isError) {
    const first = (value as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    return { isError: true, ...envelope(operation, { ok: false, outcome: "DENIED_OR_BLOCKED",
      reason: first ?? "Operation returned an error", resendSafe: false }) };
  }
  // An outcome is not a no-effect proof. Without registry capability metadata
  // this wrapper conservatively refuses effect replay, even after success.
  return envelope(operation, { ok: true, outcome: "COMPLETED", result: value, resendSafe: false });
}

async function dispatch(registry: Map<string, RegisteredOperation>, core: CoreClientConfig,
  operation: string, args: Record<string, unknown>) {
  const entry = registry.get(operation);
  if (!entry)
    return { isError: true, ...envelope(operation, { ok: false, outcome: "UNKNOWN_OPERATION",
      reason: "Not a registered Sidera operation", resendSafe: true }) };
  try {
    const value = await entry.invoke(args);
    if (value && typeof value === "object" && (value as { isError?: boolean }).isError) {
      const reason = (value as { content?: Array<{ text?: string }> }).content?.[0]?.text;
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(envelopeValue(operation,
        { ok: false, outcome: "DENIED_OR_BLOCKED", reason: reason ?? "Operation returned an error",
          resendSafe: false })) }] };
    }
    const payload = envelopeValue(operation, value) as Record<string, unknown>;
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...payload, ok: true,
      outcome: "COMPLETED", resendSafe: entry.annotations?.readOnlyHint===true }) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertain = /uncertain|timed out|closed|connection failed/i.test(message);
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(envelopeValue(operation,
      { ok: false, outcome: uncertain ? "UNCERTAIN" : "REJECTED", reason: message,
        resendSafe: entry.annotations?.readOnlyHint===true && !uncertain,
        recovery: uncertain ? "Reconcile the original request; never resend it." :
          entry.annotations?.readOnlyHint===true ? undefined : "Inspect the original Effect; never infer a safe resend from this error." })) }] };
  }
}

async function dispatchReadOnly(registry: Map<string, RegisteredOperation>, core: CoreClientConfig,
  operation: string, args: Record<string, unknown>) {
  const entry=registry.get(operation);
  if(!entry) return {isError:true,...envelope(operation,{ok:false,outcome:"UNKNOWN_OPERATION",
    reason:"Not a registered Sidera operation",resendSafe:true})};
  if(entry.annotations?.readOnlyHint!==true)
    return {isError:true,...envelope(operation,{ok:false,outcome:"READ_ONLY_REQUIRED",
      reason:"sidera_read accepts only operations explicitly registered read-only",resendSafe:true})};
  return dispatch(registry,core,operation,args);
}

/** Discovery is served from the registry, so the external tool surface can stay
 * small while the internal operation catalog keeps growing. Groups are derived
 * from the operation namespace; there is no second list to keep in sync. */
export function capabilityCatalog(registry: Map<string, RegisteredOperation>) {
  const operations = [...registry.values()].map(entry => ({ operation: entry.operation, registered: true,
    description: entry.description, inputSchema: entry.inputSchema, annotations: entry.annotations ?? null }));
  const groups: Record<string, typeof operations> = {};
  for (const entry of operations) {
    const namespace = entry.operation.split(".")[0] ?? entry.operation;
    (groups[namespace] ??= []).push(entry);
  }
  return { surface: [...GATEWAY_TOOL_NAMES], registered: registry.size, groups, operations };
}

function requireResourceOperation(registry: Map<string, RegisteredOperation>, operation: string) {
  if (!registry.has(operation))
    throw new Error(`Resource operation ${operation} is not registered in this Core build`);
  return operation;
}

/**
 * The stable Sidera MCP server. Four tools, unchanged as capability grows.
 * Every argument is passed through to a registered canonical operation; the
 * gateway adds no authority, no identity and no business rule of its own.
 */
export function createGatewayServer(core: CoreClientConfig, options: { registry?: Map<string, RegisteredOperation> } = {}): McpServer {
  const registry = options.registry ?? buildOperationRegistry(core);
  const server = new McpServer({ name: "sidera", version: "1.1.0" }, { instructions:
    "Sidera machine interface. Discover first with sidera_capabilities, then act with sidera_invoke / sidera_work / sidera_resource. " +
    "Every operation resolves to a registered Sidera operation; connection identity is never Node identity. " +
    "Never resend an operation whose outcome is UNCERTAIN; reconcile it instead. Human is the authority root, not a message bus." });

  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

  server.registerTool("sidera_status", {
    description: "Read Sidera runtime status, current World view and per-edge machine-interface health. Read-only. " +
      "One degraded edge never means Sidera Core is down.",
    inputSchema: { include: z.array(z.enum(["runtime", "world", "edges", "activation"])).optional(),
      limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async input => json(await gatewayStatus(core, registry, input)));

  server.registerTool("sidera_capabilities", {
    description: "Discover the stable surface and the registered operations it resolves to, including their schemas. " +
      "Call this before acting; it replaces per-tool schema caching.",
    inputSchema: { group: z.string().min(1).max(60).optional(),
      operation: z.string().min(1).max(120).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async input => {
    if (input.operation) {
      const entry = registry.get(input.operation);
      return json(entry ? { operation: entry.operation, registered: true, description: entry.description,
        inputSchema: entry.inputSchema, annotations: entry.annotations ?? null }
        : { operation: input.operation, registered: false });
    }
    const catalog = capabilityCatalog(registry);
    if (input.group)
      return json({ ...catalog, groups: { [input.group]: catalog.groups[input.group] ?? [] } });
    return json(catalog);
  });

  server.registerTool("sidera_read", {
    description: "Invoke one registered operation only when its canonical MCP registration is explicitly read-only. " +
      "Use this for identity/status/resource reads from approval-restricted Agent Hosts; write or mixed-effect operations are refused.",
    inputSchema: { operation: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.unknown()).default({}) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async input => dispatchReadOnly(registry, core, input.operation, input.arguments));

  server.registerTool("sidera_invoke", {
    description: "Invoke one registered Sidera operation by name with explicit arguments. " +
      "The operation stays subject to World scope, Capability, Authority, Presence and the final Effect boundary. " +
      "An UNCERTAIN outcome must be reconciled, never resent.",
    inputSchema: { operation: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.unknown()).default({}) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async input => dispatch(registry, core, input.operation, input.arguments));

  server.registerTool("sidera_work", {
    description: "Work-plane lifecycle: start or continue supervised work, dispatch a Task to a named Node, " +
      "record a supervision decision, manage Responsibilities and read work state. Every call is a canonical operation.",
    inputSchema: { operation: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.unknown()).default({}) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async input => dispatch(registry, core, input.operation, input.arguments));

  server.registerTool("sidera_resource", {
    description: "File, resource and artifact handoff: publish bytes or text, read them back, list what this subject " +
      "may see, scope a Resource to another Node, and register or read Artifact references. Content-addressed and world-scoped.",
    inputSchema: { operation: z.enum(["put", "metadata", "get", "list", "scope", "artifact.register", "artifact.get"]),
      arguments: z.record(z.string(), z.unknown()).default({}) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => {
    const operation = input.operation === "artifact.register" ? "artifact.register"
      : input.operation === "artifact.get" ? "artifact.get" : `resource.${input.operation}`;
    return dispatch(registry, core, operation, input.arguments);
  });

  return server;
}

export async function gatewayStatus(core: CoreClientConfig, registry: Map<string, RegisteredOperation>,
  input: { include?: Array<"runtime" | "world" | "edges" | "activation">; limit?: number } = {}) {
  const include = new Set(input.include ?? ["runtime", "world", "edges"]);
  const out: Record<string, unknown> = { operation: "sidera.status", stableSurface: [...GATEWAY_TOOL_NAMES],
    registeredOperations: registry.size };
  // Status reads resolve through the same registry as every other operation, so
  // status can never depend on an RPC name the gateway invented.
  if (include.has("runtime")) out.runtime = await safeOperation(registry, "runtime.status", {});
  if (include.has("world")) out.world = await safeOperation(registry, "world.inspect", input.limit ? { limit: input.limit } : {});
  if (include.has("edges")) out.edges = await edgeStates();
  return out;
}

async function safeOperation(registry: Map<string, RegisteredOperation>, operation: string,
  args: Record<string, unknown>) {
  const entry = registry.get(operation);
  if (!entry) return { observationAvailable: false, reason: `${operation} is not registered`, outcome: "UNAVAILABLE" };
  try { return envelopeValue(operation, await entry.invoke(args)); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { operation, observationAvailable: false, reason: message,
      outcome: /uncertain|timed out/i.test(message) ? "UNCERTAIN" : "UNAVAILABLE" };
  }
}

// ---------------------------------------------------------------------------
// Edge configuration / import profiles
// ---------------------------------------------------------------------------

export interface EdgeConfigFile {
  version: 1;
  generatedAt: string;
  transport: { loopbackPort: number | null; networkPort: number | null; stdio: boolean };
  edges: Array<{ id: TargetEdgeId; product: string; interfaceSupport: TargetEdge["interfaceSupport"];
    importConfig: Record<string, unknown> | null; humanSteps: string[]; limits: string[]; evidence: TargetEdge["evidence"] }>;
}

export function writeEdgeConfig(path: string, file: EdgeConfigFile): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(file, null, 2));
  renameSync(temp, path);
}

export function readEdgeConfig(path: string): EdgeConfigFile | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as EdgeConfigFile; } catch { return null; }
}

/** Per-edge health. Every value is derived from durable observations or an
 * explicit unverified marker; nothing is inferred from Sidera's own liveness. */
export async function edgeStates(configPath?: string): Promise<EdgeState[]> {
  const resolved = configPath ?? gatewayCliOptions().configPath;
  interface BoundEdge { id: TargetEdgeId; boundNodeId: string }
  let file: { edges?: BoundEdge[] } | null = null;
  try { file = JSON.parse(readFileSync(resolved, "utf8")) as { edges?: BoundEdge[] }; } catch { file = null; }
  return TARGET_EDGES.map(edge => {
    const bound = file?.edges?.find((item: BoundEdge) => item.id === edge.id) ?? null;
    // Health is per edge. It never collapses into a global readiness flag, and it
    // is never upgraded to ONLINE by configuration or by Sidera being alive.
    const health: EdgeHealth = "UNKNOWN";
    return { id: edge.id, product: edge.product, side: edge.side, mechanism: edge.mechanism,
      transport: edge.transport, interfaceSupport: edge.interfaceSupport, health, runtimeConnectivity: "UNKNOWN", support: edgeSupport(edge),
      basis: !bound ? "No binding configured for this edge in this workspace"
        : edge.interfaceSupport === "IMPLEMENTED"
          ? "Adapter path is configured; a real correlated round trip is still required to claim ONLINE"
          : "Configuration exists; product-side import or login remains Human work",
      limits: [...edge.limits], humanSteps: [...edge.humanSteps], evidence: edge.evidence };
  });
}

// ---------------------------------------------------------------------------
// Workspace configuration and profile generation
// ---------------------------------------------------------------------------

/** Boundary authentication mode. It is transport-edge policy, never Node identity,
 * and it is selected per edge so one Gateway serves bearer and OAuth clients at once. */
export type EdgeAuthMode = "bearer" | "oauth";

export interface GatewayEdgeSpec {
  id: TargetEdgeId;
  /** Node this edge acts as at Core. The connection is not the identity. */
  boundNodeId: string;
  /** Exact Human-selected Chief Conversation for this inbound edge, when it
   * acts as a Chief. This deployment binding is never tool input. */
  chiefConversationRef?: string;
  /** Optional per-edge Core token; otherwise the workspace default is used. */
  coreToken?: string;
  /** Per-edge gateway token clients must present; generated if absent. */
  token?: string;
  /** Boundary authentication for this edge. Defaults to `bearer` for existing clients. */
  authMode?: EdgeAuthMode;
  /** Required for `authMode: "oauth"`. One edge, one OAuth client. */
  oauth?: {
    clientId: string;
    /** Optional for public Authorization Code + PKCE clients. */
    clientSecret?: string;
    /** Preserve this existing client ID with explicit loopback Human consent for public PKCE. */
    publicPkceOwnerApproval?: boolean;
    clientName?: string;
    /** Exact redirect URIs. The Human supplies the product's copied value. */
    redirectUris: string[];
  };
}

export interface GatewayWorkspaceConfig {
  version: 1;
  corePort: number;
  gatewayPort: number;
  host: "127.0.0.1" | "0.0.0.0";
  /** Legacy workspace default. It is never used to resolve an edge credential;
   * a missing edge credential is a clear failure, not a fallback. */
  coreToken?: string;
  /** Explicit external base URL for OAuth metadata and redirect generation. A
   * Cloudflare Quick Tunnel hostname may change, so this is configuration and
   * never inferred from a request host or bound to any tunnel identifier. */
  publicBaseUrl?: string;
  accessTokenTtlSeconds?: number;
  /** Loopback-only Human approval endpoint. Never expose this port through a tunnel. */
  localOwnerApprovalPort?: number;
  edges: GatewayEdgeSpec[];
}

export interface GeneratedEdgeProfile {
  id: TargetEdgeId;
  product: string;
  side: "chat" | "agent";
  mechanism: string;
  interfaceSupport: TargetEdge["interfaceSupport"];
  boundNodeId: string | null;
  token: string | null;
  transport: TargetEdge["transport"];
  endpoint: string | null;
  importConfig: Record<string, unknown> | null;
  humanSteps: string[];
  limits: string[];
  evidence: TargetEdge["evidence"];
  edgeHealth: EdgeHealth;
  healthBasis: string;
}

export function generateEdgeProfiles(config: GatewayWorkspaceConfig,
  options: { registry?: { has(operation: string): boolean } } = {}): { profiles: GeneratedEdgeProfile[]; markdown: string } {
  const endpointFor = (edge: TargetEdge) => edge.transport === "stdio"
    ? null
    : `${config.host === "0.0.0.0" ? "http://<this-machine-host>" : "http://127.0.0.1"}:${config.gatewayPort}/mcp`;
  const profiles = TARGET_EDGES.map(edge => {
    const spec = config.edges.find(candidate => candidate.id === edge.id) ?? null;
    const bound = spec?.boundNodeId ?? null;
    const token = spec?.token ?? null;
    const registered = options.registry ? options.registry.has("resource.put") : true;
    const ready = Boolean(spec) && registered;
    // A bound edge is OFFLINE until a real correlated round trip; nothing here
    // may report ONLINE, and Sidera's own liveness never upgrades an edge.
    const health: EdgeHealth = "UNKNOWN";
    return { id: edge.id, product: edge.product, side: edge.side, mechanism: edge.mechanism, interfaceSupport: edge.interfaceSupport,
      boundNodeId: bound, token, transport: edge.transport, endpoint: endpointFor(edge),
      importConfig: spec ? importConfigFor(edge, { config, token }) : null,
      humanSteps: [...edge.humanSteps], limits: [...edge.limits], evidence: edge.evidence,
      edgeHealth: health,
      healthBasis: !spec ? "No binding configured for this edge yet"
        : edge.interfaceSupport === "IMPLEMENTED"
          ? "Adapter path exists locally; a real round trip is still required to claim ONLINE"
          : "Configuration generated; product-side import or login remains Human work" };
  });
  return { profiles, markdown: renderMatrix(profiles) };
}

export function renderMatrix(profiles: GeneratedEdgeProfile[]): string {
  return ["| Target | Side | Interface | Transport | Bound Node | Interface support | Runtime health | Evidence |",
    "|---|---|---|---|---|---|---|---|",
    ...profiles.map(p => `| ${p.product} | ${p.side} | ${p.mechanism} | ${p.transport} | ${p.boundNodeId ?? "-"} | ${p.interfaceSupport} | ${p.edgeHealth} | ${p.evidence} |`)].join("\n");
}

export function importConfigFor(edge: TargetEdge, context: { config: GatewayWorkspaceConfig; token: string | null }) {
  if (edge.transport === "stdio")
    return { mcpServers: { sidera: { command: "node", args: ["hythes/mcp-gateway.ts", "stdio"],
      env: { SIDERA_GATEWAY_CORE_TOKEN: context.config.coreToken, SIDERA_CORE_PORT: String(context.config.corePort) } } },
      note: "stdio client launches the gateway as a subprocess; no listener or tunnel is involved." };
  const url = context.config.host === "0.0.0.0"
    ? `http://<this-machine-host>:${context.config.gatewayPort}/mcp`
    : `http://127.0.0.1:${context.config.gatewayPort}/mcp`;
  return { mcpServers: { sidera: { type: "streamable-http", url,
    headers: { Authorization: `Bearer ${context.token ?? "<edge token>"}` } } },
    note: edge.transport === "network-http"
      ? "Cloud clients need this endpoint reachable (tunnel or public ingress). Reachability is not Sidera identity, authority, readiness or the scheduler."
      : "Loopback endpoint; no tunnel required." };
}

export function edgeStateFor(profile: GeneratedEdgeProfile): EdgeState {
  return { id: profile.id, product: profile.product, side: profile.side,
    mechanism: profile.mechanism,
    transport: profile.transport, interfaceSupport: profile.interfaceSupport, health: profile.edgeHealth, runtimeConnectivity: "UNKNOWN", support: edgeSupport(profile),
    basis: profile.healthBasis, limits: profile.limits, humanSteps: profile.humanSteps,
    evidence: profile.evidence };
}

export function writeGeneratedConfig(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** The exact Core credential for one edge. There is deliberately no workspace
 * fallback: a request must never silently become another Node's identity. */
export function edgeCoreToken(config: GatewayWorkspaceConfig, edge: GatewayEdgeSpec): string | null {
  const resolved = edge.coreToken?.trim();
  return resolved ? resolved : null;
}

export function edgeAuthMode(edge: GatewayEdgeSpec): EdgeAuthMode {
  return edge.authMode === "oauth" ? "oauth" : "bearer";
}

/** Build one HTTP edge: boundary authentication -> exact Core principal -> registry.
 * An OAuth edge carries no static bearer credential; a bearer edge requires one. */
export function buildEdge(config: GatewayWorkspaceConfig, edge: GatewayEdgeSpec): GatewayEdge {
  const target = TARGET_EDGES.find(candidate => candidate.id === edge.id);
  if (!target) throw new Error(`Unknown edge ${edge.id}`);
  const mode = edgeAuthMode(edge);
  const token = edge.token?.trim() ?? "";
  if (mode === "bearer" && !token)
    throw new Error(`Edge ${edge.id} has no boundary credential; run init to bind it`);
  if (mode === "oauth") {
    if (!edge.oauth?.clientId?.trim())
      throw new Error(`Edge ${edge.id} selects OAuth but has no registered client_id`);
    // An empty redirect set is a valid provisioning state: the product's exact
    // value is not known until the Human copies it. Every authorization attempt
    // is refused until then, so this fails closed without blocking discovery.
  }
  const coreToken = edgeCoreToken(config, edge);
  if (!coreToken)
    throw new Error(`Edge ${edge.id} has no bound Core credential for Node ${edge.boundNodeId}; `
      + `run init <nodeId> ${edge.id} or set edges[].coreToken. Refusing to fall back to another identity.`);
  const core: CoreClientConfig = { port: config.corePort, token: coreToken,
    chiefConversationRef: edge.chiefConversationRef };
  return { id: edge.id, product: target.product, token, authMode: mode,
    oauthClientId: edge.oauth?.clientId?.trim() ?? null, core,
    registry: buildOperationRegistry(core) };
}

export function gatewayCliOptions(env: Record<string, string | undefined> = process.env): {
  corePort: number; coreToken: string; port: number; token: string;
  host: "127.0.0.1" | "0.0.0.0"; configPath: string;
} {
  const corePort = Number(env.SIDERA_CORE_PORT ?? 8765);
  const port = Number(env.SIDERA_GATEWAY_PORT ?? 8788);
  const host = env.SIDERA_GATEWAY_HOST === "0.0.0.0" ? "0.0.0.0" as const : "127.0.0.1" as const;
  return { corePort, coreToken: env.SIDERA_GATEWAY_CORE_TOKEN ?? env.SIDERA_GPT_CORE_TOKEN ?? "",
    port, token: env.SIDERA_GATEWAY_TOKEN ?? "", host,
    configPath: env.SIDERA_GATEWAY_CONFIG ?? join(process.cwd(), ".sidera-dev", "sol", "data", "gateway.json") };
}

// Transports. MCP is the interface; a listener is only a reachability shape.
// The same server, registry and operations back every mode, so a remote client
// never gets a different Sidera product.
// ---------------------------------------------------------------------------

export interface GatewayListener {
  mode: "stdio" | "loopback-http" | "network-http";
  port: number | null;
  close(): Promise<void>;
}

/** Metadata URLs must not inherit a trailing slash from the configured base. */
function requestBase(provider: EdgeOAuthProvider): URL {
  const issuer = provider.issuerUrl;
  return new URL(issuer.pathname.endsWith("/") ? issuer.pathname : `${issuer.pathname}/`, issuer.origin);
}

function bearerValue(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice(7);
  return value.length ? value : null;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** An HTTP edge: one boundary credential, one registry, one bound Core principal. */
export interface GatewayEdge {
  id: TargetEdgeId;
  product: string;
  /** Static boundary credential for `bearer` edges; empty for pure OAuth edges. */
  token: string;
  authMode: EdgeAuthMode;
  /** OAuth client that resolves to this edge, when this edge accepts OAuth. */
  oauthClientId: string | null;
  core: CoreClientConfig;
  registry: Map<string, RegisteredOperation>;
}

/** Build the OAuth provider from the workspace configuration. Pre-registered
 * clients only: Dynamic Client Registration stays absent so the Human-entered
 * credentials are the whole client set. */
export function gatewayOAuthProvider(config: GatewayWorkspaceConfig, statePath: string): EdgeOAuthProvider | null {
  const oauthEdges = config.edges.filter(edge => edgeAuthMode(edge) === "oauth");
  if (!oauthEdges.length) return null;
  if (!config.publicBaseUrl)
    throw new Error("OAuth edges are configured but publicBaseUrl is missing; "
      + "set it explicitly (the tunnel hostname may change and is never identity)");
  const clients: OAuthEdgeClient[] = oauthEdges.map(edge => {
    const declared = edge.oauth!;
    return { edgeId: edge.id, boundNodeId: edge.boundNodeId, clientId: declared.clientId.trim(),
      clientSecret: declared.clientSecret, publicPkceOwnerApproval: declared.publicPkceOwnerApproval,
      clientName: declared.clientName,
      redirectUris: [...declared.redirectUris] };
  });
  return new EdgeOAuthProvider({ baseUrl: config.publicBaseUrl, clients,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds }, statePath);
}

function handleMcpRequest(core: CoreClientConfig, registry: Map<string, RegisteredOperation>,
  req: never, res: never): void {
  const server = createGatewayServer(core, { registry });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  void (async () => {
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, (req as { body?: unknown }).body);
    } catch {
      const response = res as unknown as { headersSent?: boolean; status?: (code: number) => { end(): void } };
      if (!response.headersSent && response.status) response.status(500).end();
    } finally {
      try { await transport.close(); await server.close(); } catch { /* a closed transport cannot change an outcome */ }
    }
  })();
}

/** One HTTP listener serves every configured HTTP edge.
 *
 * The listener authenticates the presented bearer credential, resolves it to
 * exactly one configured edge, and runs that edge's operations with that edge's
 * own bound Core principal. There is one endpoint, not one port per pair, and no
 * pair-specific route: the credential is the whole routing key.
 *
 * Unknown, empty or shared credentials are refused before any Core call, so an
 * edge can never borrow another edge's Node identity and never falls back to a
 * workspace credential.
 */
export async function startGatewayHttp(edges: GatewayEdge[], options: {
  port: number; host?: "127.0.0.1" | "0.0.0.0";
  mode?: "loopback-http" | "network-http";
  oauth?: EdgeOAuthProvider | null;
  /** 0 requests an ephemeral port in tests. Default is 8791 in a local installation. */
  localOwnerApprovalPort?: number;
  /** Authenticated HTTP arrival only; not a completed MCP tool or exact Chat Presence. */
  onAuthenticatedIngress?: (edgeId:TargetEdgeId,instanceId:string,observedAt:string)=>void;
}): Promise<GatewayListener> {
  if (!edges.length) throw new Error("Sidera MCP Gateway has no HTTP edge with a boundary credential");
  const host = options.host ?? "127.0.0.1";
  const bearerEdges = edges.filter(edge => edge.token);
  const oauthEdges = edges.filter(edge => edge.oauthClientId);
  if (!bearerEdges.length && !oauthEdges.length)
    throw new Error("Sidera MCP Gateway has no edge with any boundary authentication");
  // A boundary credential must name exactly one Node. OAuth clients are checked
  // in their own client_id space so the two modes cannot collide either.
  const seen = new Map<string, TargetEdgeId>();
  const seenClients = new Map<string, TargetEdgeId>();
  for (const edge of edges) {
    if (!edge.core.token) throw new Error(`Edge ${edge.id} has no bound Core principal; refusing to fall back to another identity`);
    if (edge.token) {
      const owner = seen.get(edge.token);
      if (owner) throw new Error(`Edges ${owner} and ${edge.id} share one boundary credential; a credential must name exactly one Node`);
      seen.set(edge.token, edge.id);
    }
    if (edge.oauthClientId) {
      const owner = seenClients.get(edge.oauthClientId);
      if (owner) throw new Error(`Edges ${owner} and ${edge.id} share one OAuth client; a client must name exactly one Node`);
      seenClients.set(edge.oauthClientId, edge.id);
    }
  }
  const byCredential = new Map(bearerEdges.map(edge => [edge.token, edge]));
  const byClientId = new Map(oauthEdges.map(edge => [edge.oauthClientId!, edge]));
  const app = createMcpExpressApp({ host });
  const instanceId=randomUUID();
  app.get("/healthz", (_req, res) => res.json({ healthy: true, instanceId, transport: "streamable-http-stateless",
    surface: [...GATEWAY_TOOL_NAMES], edges: edges.length,
    authModes: { bearer: bearerEdges.length, oauth: oauthEdges.length } }));
  app.get("/readyz", (_req, res) => {
    void (async () => {
      const runtime = await safeOperation(edges[0]!.registry, "runtime.status", {}) as
        { observationAvailable?: boolean;ready?:boolean };
      const ready=runtime.observationAvailable!==false&&runtime.ready===true;
      res.status(ready ? 200 : 503).json({ ready,
        edges: edges.length, runtime });
    })();
  });
  // Standard MCP OAuth discovery plus the authorization and token endpoints. The
  // SDK supplies the protocol shape; Sidera supplies edge binding only.
  const oauth = options.oauth ?? null;
  if (oauth) {
    // Metadata matches the provider: rotating refresh is durable and bound to the same Node.
    const metadata=createOAuthMetadata({provider:oauth,issuerUrl:oauth.issuerUrl,scopesSupported:['sidera.mcp']});
    metadata.grant_types_supported=['authorization_code','refresh_token'];
    metadata.token_endpoint_auth_methods_supported=[...new Set(oauth.config.clients.map(c=>c.publicPkceOwnerApproval
      ? "none" : c.clientSecret ? "client_secret_post" : "none"))];
    metadata.revocation_endpoint_auth_methods_supported=metadata.token_endpoint_auth_methods_supported;
    app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json(metadata));
    app.get("/oauth/owner-status",(req,res)=>{
      res.set("Cache-Control","no-store");res.set("Referrer-Policy","no-referrer");
      const request=typeof req.query.request==="string"?req.query.request:"";
      res.json({status:oauth.ownerApprovalStatus(request)});
    });
    app.get("/oauth/owner-complete",(req,res)=>{
      res.set("Cache-Control","no-store");res.set("Referrer-Policy","no-referrer");
      const request=typeof req.query.request==="string"?req.query.request:"";
      const confirmed=oauth.completeOwnerRequest(request);
      if(!confirmed){res.status(409).type("text").send("This authorization has not been approved or has expired.");return;}
      const redirect=new URL(confirmed.redirectUri);
      redirect.searchParams.set("code",confirmed.code);
      if(confirmed.state)redirect.searchParams.set("state",confirmed.state);
      res.redirect(302,redirect.href);
    });
    app.use(mcpAuthRouter({ provider: oauth, issuerUrl: oauth.issuerUrl,
      resourceServerUrl: new URL(oauth.resourceUrl), scopesSupported: ["sidera.mcp"],
      resourceName: "Sidera MCP Gateway" }));
  }
  const resourceMetadataUrl = oauth
    ? new URL("/.well-known/oauth-protected-resource/mcp", requestBase(oauth)).href : undefined;
  app.use("/mcp", (req, res, next) => {
    const presented = bearerValue(req.header("authorization"));
    if (!presented) {
      if (resourceMetadataUrl) res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
      res.status(401).end();
      return;
    }
    if (oauth) {
      const client = oauth.clientForToken(presented);
      const edge = client ? byClientId.get(client.clientId) : undefined;
      if (edge) {
        // Full verification (signature-free token lookup, expiry, audience and
        // edge binding) runs here, before any Core call.
        void requireBearerAuth({ verifier: oauth, resourceMetadataUrl, requiredScopes: ["sidera.mcp"] })(req, res, (error?: unknown) => {
          if (error) { res.status(401).end(); return; }
          const info = (req as unknown as { auth?: { extra?: { edgeId?: string } } }).auth;
          const resolved = info?.extra?.edgeId ? edges.find(candidate => candidate.id === info.extra!.edgeId) : undefined;
          if (!resolved) { res.status(401).end(); return; }
          (req as unknown as { sideraEdge?: GatewayEdge }).sideraEdge = resolved;
          next();
        });
        return;
      }
    }
    const matched = byCredential.get(presented);
    if (!matched) {
      if (resourceMetadataUrl) res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
      res.status(401).end();
      return;
    }
    (req as unknown as { sideraEdge?: GatewayEdge }).sideraEdge = matched;
    next();
  });
  app.post("/mcp", (req, res) => {
    const edge = (req as unknown as { sideraEdge?: GatewayEdge }).sideraEdge;
    if (!edge) { res.status(401).end(); return; }
    // The credential was authenticated and bound to one edge. Do not infer
    // that a user conversation is online or the submitted MCP call succeeded.
    try { options.onAuthenticatedIngress?.(edge.id,instanceId,new Date().toISOString()); }
    catch { /* Failure to observe cannot alter transport authentication. */ }
    handleMcpRequest(edge.core, edge.registry, req as never, res as never);
  });
  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());
  // The Human confirmation service is separate from the tunnel-forwarded Gateway.
  // It is deliberately only reachable from the owning machine.
  const localOwner = oauth?.needsLocalOwnerApproval
    ? await startLocalOAuthConsent(oauth,options.localOwnerApprovalPort??8791):null;
  if(localOwner)oauth?.setLocalOwnerApprovalOrigin("http://127.0.0.1:"+localOwner.port);
  return new Promise<GatewayListener>((resolve, reject) => {
    const listener = app.listen(options.port, host, () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("Sidera MCP Gateway listener has no bound port"));
        return;
      }
      resolve({ mode: options.mode ?? (host === "127.0.0.1" ? "loopback-http" : "network-http"),
        port: address.port,
        close: async () => {
          await new Promise<void>((done,fail)=>listener.close(error=>error?fail(error):done()));
          if(localOwner){await localOwner.close();oauth?.setLocalOwnerApprovalOrigin(null);}
        } });
    });
    listener.once("error", error => {
      if(localOwner){void localOwner.close();oauth?.setLocalOwnerApprovalOrigin(null);}
      reject(error);
    });
  });
}

export async function startGatewayStdio(core: CoreClientConfig): Promise<GatewayListener> {
  const server = createGatewayServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { mode: "stdio", port: null, close: async () => { await server.close(); } };
}

function edgeSupport(edge: {id: TargetEdgeId;interfaceSupport: InterfaceSupport}) {
 const adapter:Record<string,string>={codex:'codex-app-server',dsh:'dsh-harness-acp','grok-build':'grok-build-acp','grok-chat':'grok-chat'};
 return projectSupport({subject:INTEGRATION_SUBJECTS[adapter[edge.id]??edge.id]??subject('unspecified',edge.id,'MCP ingress','control ingress','connector auth'),interfaceSupport:edge.interfaceSupport});
}

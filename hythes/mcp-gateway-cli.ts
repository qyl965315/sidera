/**
 * Sidera MCP Gateway operator entry.
 *
 *   node hythes/mcp-gateway.ts serve      # listeners for the configured edges
 *   node hythes/mcp-gateway.ts stdio      # one Node-bound stdio gateway
 *   node hythes/mcp-gateway.ts check      # validate config and profile every edge
 *   node hythes/mcp-gateway.ts profiles   # generate profiles + per-edge import config
 *   node hythes/mcp-gateway.ts matrix     # print the compatibility matrix
 *
 * The gateway process holds transports and edge credentials only. It owns no
 * identity, no authority, no scheduler and no durable work: killing it cannot
 * change Sidera state, and Sidera Core keeps cooperating without it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { callCore } from "./core-client.ts";
import { buildEdge, edgeAuthMode, gatewayCliOptions, gatewayOAuthProvider, gatewayStatus,
  GATEWAY_TOOL_NAMES, generateEdgeProfiles, renderMatrix, startGatewayHttp, startGatewayStdio, TARGET_EDGES,
  writeGeneratedConfig, type GatewayEdge, type GatewayWorkspaceConfig, type GatewayListener } from "./mcp-gateway.ts";
import { EdgeOAuthProvider } from "./mcp-oauth.ts";
import { startGatewayIngressObservation,recordGatewayAuthenticatedIngress } from "./gateway-ingress.ts";

function workspaceConfig(path: string, fallback: ReturnType<typeof gatewayCliOptions>): GatewayWorkspaceConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GatewayWorkspaceConfig;
    if (parsed?.version !== 1 || !Array.isArray(parsed.edges))
      throw new Error("Gateway workspace config must be version 1 with an edges array");
    return { ...parsed, corePort: parsed.corePort || fallback.corePort,
      gatewayPort: parsed.gatewayPort || fallback.port,
      host: parsed.host ?? fallback.host, coreToken: parsed.coreToken || fallback.coreToken };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, corePort: fallback.corePort, gatewayPort: fallback.port, host: fallback.host,
      coreToken: fallback.coreToken, edges: [] };
  }
}

function lines(values: string[]) { for (const value of values) process.stdout.write(value + "\n"); }

interface RuntimeSpecNode { nodeId: string; displayName?: string; coreToken?: string }
interface RuntimeSpec { version?: number; chiefNodeId?: string; corePort?: number; nodes?: RuntimeSpecNode[] }

function runtimeSpecPath(configPath: string, env: Record<string, string | undefined> = process.env): string {
  return env.SIDERA_RUNTIME_SPEC ?? join(configPath, "..", "runtime-spec.json");
}

/** The exact Core credential of one bound Node, read from the Human-owned runtime
 * configuration. There is deliberately no fallback to another Node's credential. */
function resolveBoundNode(configPath: string, nodeRef: string): { node: RuntimeSpecNode; coreToken: string } {
  const path = runtimeSpecPath(configPath);
  let spec: RuntimeSpec;
  try { spec = JSON.parse(readFileSync(path, "utf8")) as RuntimeSpec; }
  catch (error) {
    throw new Error(`Cannot resolve Node ${nodeRef}: runtime configuration ${path} is unreadable `
      + `(${error instanceof Error ? error.message : String(error)})`);
  }
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const matched = nodes.filter(node => node.nodeId === nodeRef || node.displayName === nodeRef);
  if (!matched.length)
    throw new Error(`Cannot resolve Node ${nodeRef}: it is not declared in ${path}. `
      + `Declared Nodes: ${nodes.map(node => `${node.displayName ?? "?"}=${node.nodeId}`).join(", ") || "(none)"}`);
  if (matched.length > 1)
    throw new Error(`Node reference ${nodeRef} is ambiguous in ${path}; use the exact nodeId`);
  const node = matched[0]!;
  const coreToken = node.coreToken?.trim();
  if (!coreToken)
    throw new Error(`Node ${node.nodeId} (${node.displayName ?? "unnamed"}) has no coreToken in ${path}; `
      + `Sidera will not fall back to another identity`);
  return { node, coreToken };
}

/** Fail closed before any listener exists: every configured edge must resolve to
 * exactly one declared Node, one credential and one non-shared boundary token. */
function configuredEdges(config: GatewayWorkspaceConfig, configPath: string): GatewayEdge[] {
  const edges = config.edges.filter(edge => edge.authMode === "oauth" || (edge.token ?? "").trim().length > 0);
  if (!edges.length) throw new Error("No edge with a boundary credential is configured; refusing to start an empty gateway");
  const problems: string[] = [];
  const byBoundary = new Map<string, string>();
  for (const edge of edges) {
    if (!edge.boundNodeId) { problems.push(`edge ${edge.id} has no boundNodeId`); continue; }
    try {
      const resolved = resolveBoundNode(configPath, edge.boundNodeId);
      const declared = edge.coreToken?.trim();
      if (declared && declared !== resolved.coreToken)
        problems.push(`edge ${edge.id} declares a Core credential that does not match Node ${resolved.node.nodeId}`);
      const boundary = edge.token?.trim();
      if (boundary) {
        const owner = byBoundary.get(boundary);
        if (owner) problems.push(`edges ${owner} and ${edge.id} share one boundary credential`);
        else byBoundary.set(boundary, edge.id);
      }
    } catch (error) {
      problems.push(`edge ${edge.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length) throw new Error(`Gateway configuration is not usable:\n- ${problems.join("\n- ")}`);
  return edges.map(edge => buildEdge(config, { ...edge, coreToken: resolveBoundNode(configPath, edge.boundNodeId).coreToken }));
}

const command = process.argv[2] ?? "matrix";
const options = gatewayCliOptions();
const configPath = options.configPath;
const config = workspaceConfig(configPath, options);

try {
  if (command === "stdio") {
    // stdio carries exactly one edge, resolved the same way as an HTTP edge:
    // bound Node -> exact Core principal. There is no workspace-identity fallback.
    const edges = configuredEdges(config, configPath);
    if (edges.length !== 1)
      throw new Error(`stdio serves exactly one edge; ${edges.length} are configured. `
        + `Use 'serve' for a shared HTTP listener, or a separate private config for one stdio edge.`);
    await startGatewayStdio(edges[0]!.core);
  } else if (command === "matrix") {
    const { profiles } = generateEdgeProfiles(config);
    lines([renderMatrix(profiles), "",
      "Status legend: CONNECTED = a locally verifiable adapter path exists (not a login claim).",
      "READY_FOR_IMPORT = code/config is ready, product-side Human import or login remains.",
      "BLOCKED = a known product restriction prevents the machine interface now.",
      "UNSUPPORTED = no usable machine interface exists for this target."]);
  } else if (command === "init") {
    // Bind one edge to one existing Node. This writes no Core state and grants
    // nothing: it produces the transport credential and the import profile the
    // Human still has to approve product-side.
    const nodeRef = process.argv[3] ?? "";
    const edgeId = process.argv[4] ?? "codex";
    const target = TARGET_EDGES.find(edge => edge.id === edgeId);
    if (!target) throw new Error(`Unknown edge ${edgeId}; choose one of ${TARGET_EDGES.map(edge => edge.id).join(", ")}`);
    if (!nodeRef) throw new Error("init requires a Node ID to bind");
    const resolved = resolveBoundNode(configPath, nodeRef);
    const existing = workspaceConfig(configPath, options);
    const token = randomUUID();
    const event: GatewayWorkspaceConfig = { version: 1, corePort: config.corePort,
      gatewayPort: config.gatewayPort, host: config.host, edges: [...existing.edges.filter(edge => edge.id !== edgeId),
        { id: target.id, boundNodeId: resolved.node.nodeId, coreToken: resolved.coreToken, token }] };
    writeGeneratedConfig(configPath, event);
    const { profiles } = generateEdgeProfiles(event);
    const profile = profiles.find(item => item.id === edgeId)!;
    lines([`Bound ${target.product} to Node ${resolved.node.nodeId} (${resolved.node.displayName ?? "unnamed"}) in ${configPath}`,
      `Interface support: ${target.interfaceSupport}`, `Edge health: ${profile.edgeHealth} (no round trip yet)`,
      `Boundary token: ${token}  (private; stored in a mode-0600 file. The product receives only this token.)`,
      `Import configuration: ${JSON.stringify(profile.importConfig)}`,
      ...target.humanSteps.map(step => `Human step: ${step}`)]);
  } else if (command === "oauth-init") {
    // Pre-register one OAuth client for one edge. Generates the client_id and
    // client_secret the Human pastes into the product, and switches that edge to
    // OAuth boundary authentication. No Sidera Authority is created or widened.
    const edgeId = process.argv[3] ?? "";
    const target = TARGET_EDGES.find(edge => edge.id === edgeId);
    if (!target) throw new Error(`Unknown edge ${edgeId}; choose one of ${TARGET_EDGES.map(edge => edge.id).join(", ")}`);
    const existing = workspaceConfig(configPath, options);
    const prior = existing.edges.find(edge => edge.id === edgeId);
    if (!prior) throw new Error(`Edge ${edgeId} is not bound yet; run init <nodeId> ${edgeId} first`);
    const clientId = `sidera-${edgeId}-${randomUUID().slice(0, 8)}`;
    const clientSecret = randomBytes(32).toString("base64url");
    const updated: GatewayWorkspaceConfig = { ...existing,
      edges: [...existing.edges.filter(edge => edge.id !== edgeId),
        { ...prior, authMode: "oauth",
          oauth: { clientId, clientSecret, clientName: `Sidera ${target.product}`,
            redirectUris: prior.oauth?.redirectUris ?? [] } }] };
    writeGeneratedConfig(configPath, updated);
    lines([`OAuth client registered for edge ${edgeId} -> Node ${prior.boundNodeId}`,
      `  client_id:     ${clientId}`,
      `  client_secret: ${clientSecret}`,
      `  stored in:     ${configPath} (mode 0600, never printed by status commands)`,
      `  A restart of the Gateway is required for a newly registered client to take effect.`,
      prior.oauth?.redirectUris?.length
        ? `  redirect_uris: ${prior.oauth.redirectUris.join(", ")}`
        : `  redirect_uris: NONE YET - run: node hythes/mcp-gateway-cli.ts oauth-set-redirect ${edgeId} "<the exact value from Copy Redirect URI>"`,
      `The product receives only client_id/client_secret. No Core credential is exposed.`]);
  } else if (command === "oauth-set-redirect") {
    const edgeId = process.argv[3] ?? "";
    const redirectUri = process.argv[4] ?? "";
    if (!edgeId || !redirectUri)
      throw new Error('Usage: oauth-set-redirect <edgeId> "<exact redirect URI from the product>"');
    const parsed = new URL(redirectUri);
    if (!["https:", "http:"].includes(parsed.protocol))
      throw new Error(`Redirect URI must be an absolute http(s) URL, got ${redirectUri}`);
    if (parsed.hash) throw new Error("Redirect URI must not contain a fragment");
    const existing = workspaceConfig(configPath, options);
    const prior = existing.edges.find(edge => edge.id === edgeId);
    if (!prior) throw new Error(`Edge ${edgeId} is not configured`);
    if (!prior.oauth?.clientId) throw new Error(`Edge ${edgeId} has no OAuth client; run oauth-init ${edgeId} first`);
    const redirects = [...new Set([...(prior.oauth.redirectUris ?? []), redirectUri])];
    const updated: GatewayWorkspaceConfig = { ...existing,
      edges: [...existing.edges.filter(edge => edge.id !== edgeId),
        { ...prior, oauth: { ...prior.oauth, redirectUris: redirects } }] };
    writeGeneratedConfig(configPath, updated);
    lines([`Registered redirect URI for ${edgeId}:`, ...redirects.map(uri => `  ${uri}`),
      `Exact match is required; any other redirect_uri is refused.`,
      `Restart the Gateway (Ctrl-C, then serve) so the running listener loads this value.`]);
  } else if (command === "oauth-status") {
    const provider = gatewayOAuthProvider(config, join(configPath, "..", "gateway-oauth-state.json"));
    if (!provider) { lines(["No OAuth edge is configured."]); }
    else {
      const summary = provider.summary() as { baseUrl: string; resource: string; issuer: string;
        accessTokenTtlSeconds: number; activeAccessTokens: number; pendingAuthorizationCodes: number;
        pendingOwnerApprovals: number; clients: Array<{ edgeId: string; boundNodeId: string; clientId: string; redirectUris: string[];
          secretFingerprint: string; ownerApprovalRequired: boolean }> };
      lines([`issuer:  ${summary.issuer}`, `resource: ${summary.resource}`,
        `discovery: ${new URL("/.well-known/oauth-authorization-server", summary.issuer).href}`,
        `protected-resource: ${new URL("/.well-known/oauth-protected-resource/mcp", summary.issuer).href}`,
        `authorization_code + PKCE S256; access token TTL ${summary.accessTokenTtlSeconds}s`,
        `active access tokens: ${summary.activeAccessTokens}; pending codes: ${summary.pendingAuthorizationCodes}; pending Human approvals: ${summary.pendingOwnerApprovals}`,
        ...summary.clients.map(client => `client ${client.edgeId} -> ${client.boundNodeId}  client_id=${client.clientId}  `
          + `auth=${client.ownerApprovalRequired ? "public-pkce-on-device-consent" : "confidential-client-secret"}  `
          + `secret_fp=${client.secretFingerprint}  redirects=${client.redirectUris.join(",") || "(none)"}`)]);
    }
  } else if (command === "profiles") {
    const { profiles, markdown } = generateEdgeProfiles(config);
    const outPath = join(configPath, "..", "gateway-profiles.json");
    writeGeneratedConfig(outPath, { version: 1, generatedAt: new Date().toISOString(),
      corePort: config.corePort, gatewayPort: config.gatewayPort, host: config.host,
      stableSurface: [...GATEWAY_TOOL_NAMES],
      profiles });
    for (const profile of profiles) {
      process.stdout.write(`${profile.product}: [${profile.interfaceSupport}]${profile.boundNodeId ? ` node=${profile.boundNodeId}` : ""}\n`);
      if (profile.importConfig) process.stdout.write(`  ${JSON.stringify(profile.importConfig)}\n`);
      for (const step of profile.humanSteps) process.stdout.write(`  human: ${step}\n`);
    }
    process.stdout.write(`\n${markdown}\n\nWritten: ${outPath}\n`);
  } else if (command === "check" || command === "serve") {
    const edges = configuredEdges(config, configPath);
    if (command === "check") {
      const missing = TARGET_EDGES.filter(edge => !config.edges.some(item => item.id === edge.id)).map(edge => edge.id);
      const reachability = await Promise.all(edges.map(async edge => {
        try { await callCore(edge.core, "runtime.status", {}); return `${edge.id}=REACHABLE`; }
        catch (error) { return `${edge.id}=UNAVAILABLE(${error instanceof Error ? error.message : String(error)})`; }
      }));
      lines([`Core port: ${config.corePort}`, `Registered operations: ${edges[0]!.registry.size}`,
        `Stable surface: ${[...GATEWAY_TOOL_NAMES].join(" ")}`,
        `Edges configured: ${edges.length}/${TARGET_EDGES.length}${missing.length ? ` (not bound: ${missing.join(", ")})` : ""}`,
        `Per-edge Node principals: ${edges.map(edge => `${edge.id}->${edge.core.token.slice(0, 6)}…`).join(", ")}`,
        `Core reachability: ${reachability.join(", ")}`]);
    } else {
      const listeners: GatewayListener[] = [];
      const httpEdges = edges.filter(edge => TARGET_EDGES.find(candidate => candidate.id === edge.id)!.transport !== "stdio");
      for (const edge of edges.filter(edge => TARGET_EDGES.find(candidate => candidate.id === edge.id)!.transport === "stdio"))
        listeners.push(await startGatewayStdio(edge.core));
      const oauthProvider = gatewayOAuthProvider(config, join(configPath, "..", "gateway-oauth-state.json"));
      if (httpEdges.length) listeners.push(await startGatewayHttp(httpEdges, { port: config.gatewayPort,
        host: config.host, mode: config.host === "127.0.0.1" ? "loopback-http" : "network-http",
        oauth: oauthProvider,localOwnerApprovalPort:config.localOwnerApprovalPort??8791,
        onAuthenticatedIngress:recordGatewayAuthenticatedIngress }));
      const status = await gatewayStatus(httpEdges[0]?.core ?? edges[0]!.core,
        (httpEdges[0] ?? edges[0]!).registry, { include: ["runtime", "edges"], limit: 1 });
      process.stdout.write(JSON.stringify({ event: "gateway.started", configPath,
        listeners: listeners.map(listener => ({ mode: listener.mode, port: listener.port })),
        edges: edges.map(edge => ({ id: edge.id, node: edge.core.token.slice(0, 6) + "…", transport:
          TARGET_EDGES.find(candidate => candidate.id === edge.id)!.transport })),
        stableSurface: [...GATEWAY_TOOL_NAMES],
        core: status.runtime ?? null, edgeHealth: status.edges ?? null }) + "\n");
      const ingress=httpEdges.length?startGatewayIngressObservation(join(configPath,"..","gateway-ingress.json"),config):null;
      const stop = () => { ingress?.close();void Promise.all(listeners.map(listener => listener.close())).then(() => process.exit(0)); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    }
  } else {
    lines([`Unknown command: ${command}`, "Use: serve | stdio | check | profiles | matrix"]);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

import {hostFactories} from "../hythes/host-factories.ts";
import {defaultFrontendRegistry} from "../hythes/frontend-factory.ts";
import type {RuntimeSpec} from "./service.ts";
import type {FrontendSpec} from "../hythes/frontend-registry.ts";
/** Pure structural config check. Does not instantiate adapters, contact Hosts, or establish Presence. */
export function checkConfiguration(spec: RuntimeSpec) {
  const errors: string[] = [], warnings: string[] = [];
  const agentAdapters = Object.keys(hostFactories).sort(), frontendAdapters = defaultFrontendRegistry().adapters();
  if (spec.version !== 1 || !Array.isArray(spec.nodes)) throw new Error("Human-owned RuntimeSpec v1 with nodes is required");
  for (const field of ["corePort", "mcpPort"] as const) if (!Number.isInteger(spec[field]) || spec[field] < 1 || spec[field] > 65535) errors.push(`${field} must be a valid TCP port`);
  const seen = { nodeId: new Set<string>(), sessionId: new Set<string>(), hytheId: new Set<string>() };
  const nodes = spec.nodes.map(node => {
    for (const field of ["nodeId", "sessionId", "hytheId"] as const) {
      if (!node[field] || seen[field].has(node[field])) errors.push(`Missing or duplicate ${field}`);
      seen[field].add(node[field]);
    }
    if (!node.locatorRef || !node.coreToken) errors.push(`Node ${node.nodeId} requires its exact locator and local RPC credential`);
    if (!agentAdapters.includes(node.hostKind)) errors.push(`Unregistered Agent adapter: ${node.hostKind}`);
    return { nodeId: node.nodeId, displayName: node.displayName, sessionId: node.sessionId, hytheId: node.hytheId, hostKind: node.hostKind, adapterRegistered: agentAdapters.includes(node.hostKind) };
  });
  if (!seen.nodeId.has(spec.chiefNodeId)) errors.push("chiefNodeId must reference a configured Node");
  const frontend = spec.frontend as FrontendSpec | undefined;
  const frontendRoutes: Array<{ id: string; adapter: string; frontendKind: string; adapterRegistered: boolean }> = [];
  if (frontend?.routes !== undefined) {
    if (!Array.isArray(frontend.routes)) errors.push("frontend.routes must be an array");
    else {
      const ids = new Set<string>();
      for (const route of frontend.routes) {
        if (!route.id || ids.has(route.id) || !route.frontendKind) errors.push("Frontend routes require unique IDs and explicit frontendKind");
        ids.add(route.id);
        if (!frontendAdapters.includes(route.adapter)) errors.push(`Unregistered frontend adapter: ${route.adapter}`);
        frontendRoutes.push({ id: route.id, adapter: route.adapter, frontendKind: route.frontendKind, adapterRegistered: frontendAdapters.includes(route.adapter) });
      }
    }
  } else if (frontend?.kind && ["chatgpt-ui", "chatgpt-native", "codex-app-tools"].includes(frontend.kind)) {
    warnings.push("Legacy frontend configuration maps to native only; browser/UI transport is disabled");
    if (frontend.options?.nativeServerPath || process.env.SIDERA_CODEX_APP_TOOLS_SERVER)
      frontendRoutes.push({ id: "chatgpt:codex-app-tools", adapter: "codex-app-tools", frontendKind: "chatgpt-web", adapterRegistered: true });
  } else if (frontend?.kind) errors.push("Unknown legacy frontend kind; declare frontend.routes explicitly");
  if (!frontendRoutes.length) warnings.push("No configured Human return route; Human-facing work will remain blocked until a real non-browser route is available");
  return { valid: errors.length === 0, readOnly: true, hostsContacted: 0, presenceEstablished: false, chiefNodeId: spec.chiefNodeId,
    nodes, frontendRoutes, registeredAgentAdapters: agentAdapters, registeredFrontendAdapters: frontendAdapters, errors, warnings };
}


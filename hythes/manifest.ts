import type { Hythe } from "./types.ts";

export type RouteClass = "native" | "protocol" | "ui-fallback";
export const semanticOperations = ["node.inspect","node.capabilities","session.list","session.create","session.inspect","session.resume","session.close",
  "conversation.open","conversation.locate","conversation.read","conversation.send","conversation.observe","conversation.interrupt","conversation.resume","conversation.steer",
  "model.inspect","model.set","model.list","workspace.inspect","workspace.read","workspace.write","tool.list","tool.invoke","tool.configure","host.inspect","host.status"] as const;
export interface CapabilityOperation {
  operation: string; backendOperation: string; supported: boolean; routeClass: RouteClass;
  effect: "read" | "write"; retry: "safe-read" | "reconcile"; backend: string;
}
export interface CapabilityManifest {
  version: 1; hytheId: string; hostKind: string;
  nodeId?:string; sessionId?:string|null; availability?:unknown;
  operations: CapabilityOperation[]; transportCapabilities: string[];
}
/** One adapter inventory. All public compatibility lists derive from it. */
const hostSources: Record<string,{routeClass:RouteClass;operations:string[];createsSession:boolean;transportCapabilities?:string[]}> = {
  "codex-app-server":{routeClass:"native",createsSession:true,operations:["conversation.read","conversation.resume","conversation.interrupt","conversation.steer","conversation.send","model.list","tool.list","session.inspect"]},
  "grok-build-acp":{routeClass:"protocol",createsSession:true,operations:["session.inspect","session.create","conversation.resume","conversation.interrupt"]},
  "dsh-harness-acp":{routeClass:"protocol",createsSession:true,operations:["session.inspect","conversation.resume"]},
  "antigravity-cli-headless":{routeClass:"native",createsSession:true,operations:["session.inspect"]},
  // Dormant historical adapter; excluded from default products and target edges.
  "zcode-native-service":{routeClass:"native",createsSession:true,operations:["session.inspect"]},
  // Hidden legacy alias for existing configurations only.
  "openai-compatible-api":{routeClass:"protocol",createsSession:true,operations:["session.inspect"]},
  "generic-api":{routeClass:"protocol",createsSession:true,operations:["session.inspect"]},
  // Inbound-only: an external product that reaches Sidera as an MCP client. Sidera
  // cannot push into it without an official product machine interface, so no
  // proactive transport capability is declared here.
  "external-mcp-client":{routeClass:"protocol",createsSession:false,operations:["session.inspect"],
    transportCapabilities:["session.locate"]},
};
export function operationEffect(operation:string): "read"|"write" {
  return /\.(inspect|capabilities|list|read|observe|status|locate)$/.test(operation) ? "read" : "write";
}
export function hostManifest(hythe: Pick<Hythe,"hytheId"|"hostKind">, override?: {operations:string[];routeClass:RouteClass;createsSession:boolean;transportCapabilities?:string[]}): CapabilityManifest {
  const source = override ?? hostSources[hythe.hostKind];
  if (!source) throw new Error(`Host manifest is not defined: ${hythe.hostKind}`);
  const operations = [...new Set([...semanticOperations,...source.operations])].map(operation=>{
    const backendOperation = operation === "session.resume" ? "conversation.resume" : operation === "model.inspect" ? "model.list" : operation;
    const effect=operationEffect(operation);
    return {operation,backendOperation,supported:source.operations.includes(backendOperation),routeClass:source.routeClass,
      effect,retry:effect === "read" ? "safe-read" as const : "reconcile" as const,backend:hythe.hytheId};
  });
  return {version:1,hytheId:hythe.hytheId,hostKind:hythe.hostKind,operations,
    transportCapabilities:source.transportCapabilities ?? ["message.receive","session.locate",...(source.createsSession?["session.create"]:[])]};
}
export function controlsFromManifest(manifest:CapabilityManifest): string[] {
  return [...new Set(manifest.operations.filter(o=>o.supported).map(o=>o.backendOperation))];
}

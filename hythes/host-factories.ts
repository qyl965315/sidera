import type { DatabaseSync } from "node:sqlite";
import type { NodeHostSpec } from "../core/onboarding.ts";
import { CodexHythe,type CodexHytheOptions } from "./codex.ts";
import { DshHythe,type DshHytheOptions } from "./dsh.ts";
import { GrokHythe,type GrokHytheOptions } from "./grok.ts";
import { AntigravityHythe,type AntigravityOptions } from "./antigravity.ts";
import { ZcodeHythe,type ZcodeOptions } from "./zcode.ts";
import { OpenAICompatibleHythe,type OpenAICompatibleHytheOptions } from "./openai-compatible.ts";
import { ExternalMcpClientHythe,type ExternalMcpClientOptions } from "./external-mcp-client.ts";
import { PeregrineHostHythe } from "./peregrine-host.ts";
import type { LocalPeregrineManager } from "../peregrine/local.ts";
import type { Hythe } from "./types.ts";


export interface HostFactoryContext { peregrines?: LocalPeregrineManager }
export type HostFactory=(spec:NodeHostSpec,db:DatabaseSync,corePort:number,context?:HostFactoryContext)=>Hythe;
/**
 * Protocol 02: a Host that can produce an Effect must declare its own control
 * profile. This is validated, not defaulted - supplying a fallback would let a
 * future Host silently claim a control class nobody chose for it.
 */
function declared(hythe:Hythe):Hythe{
 if(hythe.capabilities().includes("message.receive")&&!hythe.effectProfile?.("message.receive"))
  throw new Error(`Host ${hythe.hytheId} (${hythe.hostKind}) can receive work but declares no M2 control profile`);
 return hythe;
}
/** Adding a Host adds one adapter factory. Core has no Host/name branches. */
export const hostFactories:Record<string,HostFactory>={
"codex-app-server":(s,_db,p)=>declared(new CodexHythe({...s.options,hytheId:s.hytheId,coreToken:s.coreToken,corePort:p} as CodexHytheOptions)),
"dsh-harness-acp":(s,db,p)=>declared(new DshHythe({...s.options,db,coreToken:s.coreToken,corePort:p} as DshHytheOptions)),
"grok-build-acp":(s,db,p)=>declared(new GrokHythe({...s.options,db,coreToken:s.coreToken,corePort:p} as GrokHytheOptions)),
"antigravity-cli-headless":(s,db,p)=>declared(new AntigravityHythe({...s.options,provider:s.model?.provider??s.options.provider,db,coreToken:s.coreToken,corePort:p} as AntigravityOptions)),
// Dormant compatibility only; rejected by new-host setup.
"zcode-native-service":(s,db)=>declared(new ZcodeHythe({...s.options,db} as ZcodeOptions)),
// Hidden legacy configuration alias; never advertised for new Hosts.
"openai-compatible-api":(s,db,p)=>declared(compatible(s,db,p)),
"generic-api":(s,db,p)=>declared(compatible(s,db,p)),
// One adapter for every external product that reaches Sidera as an MCP client.
// The product identity lives in the configured edge, never in a code branch.
// Built-in local executor: a real, publicly distributable Host with no private bridge or external account.
"peregrine-local":(s,db,_p,context)=>{
  if(!context?.peregrines)throw new Error("Peregrine local executor requires the Core-owned manager");
  return declared(new PeregrineHostHythe({hytheId:s.hytheId,nodeId:s.nodeId,sessionId:s.sessionId,db,manager:context.peregrines}));},
"external-mcp-client":(s,_db,_p)=>declared(new ExternalMcpClientHythe(s.hytheId,{
  edgeId:String(s.options.edgeId ?? ""), gatewayEndpoint:s.options.gatewayEndpoint == null ? undefined : String(s.options.gatewayEndpoint),
  locatorRef:s.locatorRef,
} as ExternalMcpClientOptions)),
};
function compatible(s:NodeHostSpec,db:DatabaseSync,p:number) {
 if(s.hostKind==="generic-api"&&s.options.protocol!=="openai-compatible")throw Error("Unsupported Generic API protocol");
 return new OpenAICompatibleHythe({...s.options,db,nodeId:s.nodeId,sessionId:s.sessionId,locatorRef:s.locatorRef,
  hytheId:s.hytheId,hostKind:s.hostKind,core:{port:p,token:s.coreToken},
  resolveCredential:(ref:string)=>ref.startsWith("env:")?process.env[ref.slice(4)]:undefined} as OpenAICompatibleHytheOptions);
}

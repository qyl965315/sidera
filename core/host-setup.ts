/** Bounded local configuration; never establishes identity, authentication or Presence. */
import { z } from 'zod';
import { McpFrontendRoute } from '../hythes/mcp-frontend.ts';
import type { FrontendRouteSpec } from '../hythes/frontend-registry.ts';
const text=z.string().trim().min(1).max(200);
const path=z.string().min(1).max(2048).regex(/^[A-Za-z]:[\\/]/).refine(v=>!/[\r\n\0]/.test(v));
const common={label:text,locatorRef:text,workspace:path};
export const executableHostInput=z.discriminatedUnion('hostKind',[
 z.object({...common,hostKind:z.literal('codex-app-server'),codexExecutable:path,home:path,temp:path,codexHome:path,model:text}).strict(),
 z.object({...common,hostKind:z.literal('dsh-harness-acp'),executable:path,cliEntry:path,dshHome:path}).strict(),
 z.object({...common,hostKind:z.literal('grok-build-acp'),executable:path,home:path}).strict(),
 z.object({...common,hostKind:z.literal('antigravity-cli-headless'),executable:path,provider:text,modelId:text,effort:z.enum(['low','medium','high']),settingsPath:path}).strict(),
]);
export const environmentReference=z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/);
export const apiHostInput=z.object({label:text,hostKind:z.literal('generic-api'),protocol:z.literal('openai-compatible'),providerId:text,
 baseUrl:z.string().max(2048).url().refine(value=>{const u=new URL(value);return !u.username&&!u.password&&!u.search&&!u.hash&&u.pathname.endsWith('/')&&(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)));}),
 credentialRef:environmentReference.optional()}).strict();
export const routeInput=z.object({bindingId:text,endpoint:z.string().url().max(2048),secretRef:environmentReference,
 locateTool:text,sendTool:text,readTool:text.optional(),observeTool:text.optional()}).strict();
export function protocolRoute(value:unknown,binding:{binding_id:string;project_space_id:string;conversation_ref:string;frontend_kind:string}):FrontendRouteSpec{
 const p=routeInput.parse(value);
 const spec:FrontendRouteSpec={id:'mcp:'+binding.binding_id,adapter:'mcp-http',frontendKind:binding.frontend_kind,
 bindings:[{bindingId:binding.binding_id,projectSpaceId:binding.project_space_id,conversationRef:binding.conversation_ref}],
 options:{endpoint:p.endpoint,authTokenEnv:p.secretRef.slice(4),operations:{'conversation.locate':p.locateTool,'conversation.send':p.sendTool,
 ...(p.readTool?{'conversation.read':p.readTool}:{}),...(p.observeTool?{'conversation.observe':p.observeTool}:{})}}};
 // Reuse the adapter's canonical validation, with no connection or external effect.
 new McpFrontendRoute(spec);
 return spec;
}

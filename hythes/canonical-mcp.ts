import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureTools,registeredToolNames } from "./tool-catalog.ts";
import { registerHostControl } from "./host-control-mcp.ts";
import { registerOrganizationControl } from "./organization-mcp.ts";
import { registerSubjectivityControl } from "./subjectivity-mcp.ts";
import { registerWorkspaceControl } from "./workspace-mcp.ts";
import { registerResourceControl } from "./resource-mcp.ts";
import { callCore,type CoreClientConfig } from "./core-client.ts";
export function canonicalMcpServer(core:CoreClientConfig):McpServer {
 const server=captureTools(new McpServer({name:"sidera",version:"0.2.0"},{instructions:
  "Use task_dispatch with parentRunId/checkpoint; yield WAIT and resume on events. Never poll or resend uncertain work. Human uses one designated Chat; never ask Human to relay prompts or create feedback Chats. Description + Explanation are sovereign; world archives are observations."}));
 registerHostControl(server,core);registerOrganizationControl(server,core);registerSubjectivityControl(server,core);registerWorkspaceControl(server,core);registerResourceControl(server,core);
 server.registerTool("effects_query",{description:"Read canonical uncertain Effects and append-only reconciliation history. A transport error is not Task failure. Never replay uncertain effects.",
  inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async()=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"effects.query",{}))}]}));
 server.registerTool("effects_reconcile",{description:"Append sourced Effect reconciliation under Authority. Does not retry or overwrite original effects. Human adjudication is Human-only.",
  inputSchema:{effectId:z.string().min(1),state:z.enum(["OPEN_UNCERTAIN","OBSERVED_COMPLETED","OBSERVED_NOT_APPLIED","SUPERSEDED"]),reason:z.string().min(1),evidenceEventIds:z.array(z.string()).min(1),expectedRevision:z.number().int().min(0)},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"effects.reconcile",input))}]}));
 server.registerTool("capability_invoke",{description:"Operate on a logical targetNodeId and semantic operation. Discover node.capabilities first. Core resolves exact Session/backend and Authority. C is not A. An uncertain action must be reconciled without resending.",
  inputSchema:{requestId:z.string().uuid(),targetNodeId:z.string().min(1),operation:z.string().min(1),input:z.record(z.string(),z.unknown()).default({}),expectedSessionId:z.string().optional()},
  annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},async input=>{
   try{return {content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"capability.invoke",input))}]};}
   catch(error){return {isError:true,content:[{type:"text" as const,text:error instanceof Error?error.message:"uncertain"}]};}
 });
 server.registerTool("task_result",{description:"Store an exact Run result. Only confirmed Host turn-end completes it.",
  inputSchema:{requestId:z.string().uuid(),runId:z.string().uuid(),messageId:z.string().uuid(),body:z.string().min(1).max(500000)},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"task.result",input))}]}));
 server.registerTool("node_rename",{description:"Rename a Node display label under exact Authority and expected-display-name CAS; identity, work and History stay attributable.",
  inputSchema:{requestId:z.string().uuid(),nodeId:z.string().min(1),expectedDisplayName:z.string().min(1),displayName:z.string().min(1)},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"node.rename",input))}]}));
 registerConstitutionalTools(server,core);
 return server;
}
export function canonicalToolNames():string[] {return registeredToolNames(canonicalMcpServer({port:0,token:"schema-only"}));}
import { registerConstitutionalTools } from "./constitutional-mcp.ts";

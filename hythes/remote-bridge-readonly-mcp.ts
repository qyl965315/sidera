/**
 * Self-hosted Remote Bridge read-only MCP adapter.
 * Canonical Sidera registered tools derive dynamic Gateway operations.
 * Bound to exact existing Chief Node, approved non-sensitive local workspace,
 * and one existing loopback Bridge instance, never model-selected host/secret.
 */
import {readFileSync} from "node:fs";
import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {callCore,type CoreClientConfig} from "./core-client.ts";

export const BRIDGE_PORT=47311;
const MAX_RESPONSE=65536;
type Config={allowedNodeId:string;credentialFile:string};
export function relativeBridgePath(value:string,allowRoot=false):string{
 if(allowRoot && value===".")return value;
 if(typeof value!=="string"||value.length<1||value.length>180||
   value.startsWith("/")||value.startsWith("\\")||/^[A-Za-z]:/.test(value)||
   value.includes("\\")||/[%:&?*|<>"'!\u0000-\u001f]/.test(value)||
   value.split("/").some(part=>!part||part==="."||part==="..")||
   !/^[A-Za-z0-9._/ -]+$/.test(value))
   throw Error("BRIDGE_RELATIVE_PATH_REQUIRED");
 return value;
}
export function bridgeReadConfig(env:NodeJS.ProcessEnv=process.env):Config{
 const allowedNodeId=env.SIDERA_BRIDGE_READONLY_NODE_ID;
 const credentialFile=env.SIDERA_BRIDGE_READONLY_CREDENTIAL_FILE;
 if(!allowedNodeId||!/^[0-9a-f-]{36}$/i.test(allowedNodeId)||
   !credentialFile||!/^[A-Za-z]:[\\/]/.test(credentialFile))
   throw Error("BRIDGE_READ_CONFIG_UNAVAILABLE");
 return {allowedNodeId,credentialFile};
}
export async function authorizeRead(
 core:CoreClientConfig,config:Config):Promise<void>{
 const scope=core.chiefIngressScope;
 if(!scope||scope.nodeId!==config.allowedNodeId||
    !scope.bindingId||!scope.conversationRef)
   throw Error("BRIDGE_EXACT_CHIEF_BINDING_REQUIRED");
 const session=await callCore(core,"session.active",{}) as
   {nodeId?:string;sessionId?:string;state?:string};
 if(session.nodeId!==config.allowedNodeId||session.state!=="active"||
    !session.sessionId)
   throw Error("BRIDGE_AUTHENTICATED_CHIEF_REQUIRED");
}
function getBearer(file:string):string{
 let token:string;
 try{token=readFileSync(file,"utf8").trim()}catch{throw Error("BRIDGE_BEARER_UNAVAILABLE")}
 if(!/^[0-9a-f]{96}$/.test(token))throw Error("BRIDGE_BEARER_INVALID");
 return token;
}
export async function callBridgeRead(config:Config,tool:"fs.list"|"fs.read_text",
 args:Record<string,unknown>):Promise<Record<string,unknown>>{
 let response:Response;
 try{
   response=await fetch("http://127.0.0.1:"+BRIDGE_PORT+"/mcp",{
     method:"POST",
     headers:{"Content-Type":"application/json",Accept:"application/json",
       Authorization:"Bearer "+getBearer(config.credentialFile)},
     body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
       params:{name:tool,arguments:args}}),
     signal:AbortSignal.timeout(4500),
   });
 }catch{throw Error("BRIDGE_LOCAL_TRANSPORT_UNAVAILABLE")}
 if(!response.ok)throw Error("BRIDGE_TRANSPORT_"+response.status);
 let payload:unknown;
 try{payload=await response.json()}catch{throw Error("BRIDGE_INVALID_RESPONSE")}
 const result=(payload as {result?:{structuredContent?:Record<string,unknown>;
   isError?:boolean};error?:unknown})?.result;
 if(!result||result.isError||!result.structuredContent||
   result.structuredContent.status!=="ok"||
   result.structuredContent.operation!==tool)
   throw Error("BRIDGE_READ_BLOCKED");
 const answer={status:"ok",via:"sidera-gateway",bridge:"self-hosted-local",
   readOnly:true,operation:tool,receipt:result.structuredContent};
 if(JSON.stringify(answer).length>MAX_RESPONSE)
   throw Error("BRIDGE_READ_OUTPUT_LIMIT");
 return answer;
}
const envelope=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
const blocked=(error:unknown)=>({isError:true,...envelope({
  status:"blocked",code:error instanceof Error?error.message:"BRIDGE_READ_UNAVAILABLE"})});
export function registerRemoteBridgeReadOnly(server:McpServer,core:CoreClientConfig):void{
 server.registerTool("remote_bridge_list",{
  description:"List a bounded relative path in the Human-approved self-hosted Bridge read-only workspace, authenticated exact Chief only. Never creates work or executes commands.",
  inputSchema:z.strictObject({path:z.string().min(1).max(180).optional(),
    depth:z.number().int().min(0).max(2).optional()}),
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
 },async input=>{
  try{
   const cfg=bridgeReadConfig();
   await authorizeRead(core,cfg);
   const file=relativeBridgePath(input.path??".",true);
   return envelope(await callBridgeRead(cfg,"fs.list",{path:file,depth:input.depth??1}));
  }catch(e){return blocked(e)}
 });
 server.registerTool("remote_bridge_read_text",{
  description:"Read only a bounded UTF-8 file from the configured self-hosted Bridge read-only root, through the existing authenticated Chief Sidera Gateway.",
  inputSchema:z.strictObject({path:z.string().min(1).max(180),
    maxBytes:z.number().int().min(1).max(32768).optional()}),
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
 },async input=>{
  try{
   const cfg=bridgeReadConfig();
   await authorizeRead(core,cfg);
   return envelope(await callBridgeRead(cfg,"fs.read_text",{
     path:relativeBridgePath(input.path),maxBytes:input.maxBytes??16384}));
  }catch(e){return blocked(e)}
 });
}

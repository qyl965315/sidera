/**
 * Separate R2 Shadow read-only MCP adapter. Does not alter the original R0
 * adapter, make a public listener, or mint Authority.
 * The credential file and Chief identity are operator-provided environment
 * settings: never model arguments, never response fields.
 */
import {readFileSync} from "node:fs";
import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {CoreClientConfig} from "./core-client.ts";
import {relativeBridgePath,authorizeRead} from "./remote-bridge-readonly-mcp.ts";

export const R2_BRIDGE_PORT=47312;
const MAX_RESPONSE=65536;
const READ_TOOLS=new Set(["fs.list","fs.info","fs.read_text","fs.read_many"]);
type R2ReadTool="fs.list"|"fs.info"|"fs.read_text"|"fs.read_many";
export type R2ReadConfig={allowedNodeId:string;credentialFile:string};

export function r2BridgeReadConfig(env:NodeJS.ProcessEnv=process.env):R2ReadConfig{
 const allowedNodeId=env.SIDERA_BRIDGE_R2_READONLY_NODE_ID;
 const credentialFile=env.SIDERA_BRIDGE_R2_READONLY_CREDENTIAL_FILE;
 if(!allowedNodeId||!/^[0-9a-f-]{36}$/i.test(allowedNodeId)||
   !credentialFile||!/^[A-Za-z]:[\\/]/.test(credentialFile))
  throw Error("BRIDGE_R2_READ_CONFIG_UNAVAILABLE");
 return {allowedNodeId,credentialFile};
}
function bearerFromFile(file:string):string{
 let token:string;
 try{token=readFileSync(file,"utf8").trim();}
 catch{throw Error("BRIDGE_R2_BEARER_UNAVAILABLE")}
 if(!/^[0-9a-f]{96}$/.test(token))throw Error("BRIDGE_R2_BEARER_INVALID");
 return token;
}
export async function callR2BridgeRead(config:R2ReadConfig,tool:R2ReadTool,
 args:Record<string,unknown>):Promise<Record<string,unknown>>{
 if(!READ_TOOLS.has(tool))throw Error("BRIDGE_R2_NOT_A_READ_OPERATION");
 const bearer=bearerFromFile(config.credentialFile);
 let response:Response;
 try{
  response=await fetch("http://127.0.0.1:"+R2_BRIDGE_PORT+"/mcp",{
   method:"POST",
   headers:{"Content-Type":"application/json",Accept:"application/json",
     Authorization:"Bearer "+bearer},
   body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
     params:{name:tool,arguments:args}}),
   signal:AbortSignal.timeout(8000),
  });
 }catch{throw Error("BRIDGE_R2_LOCAL_TRANSPORT_UNAVAILABLE")}
 if(!response.ok)throw Error("BRIDGE_R2_TRANSPORT_"+response.status);
 let payload:unknown;
 try{payload=await response.json()}catch{throw Error("BRIDGE_R2_INVALID_RESPONSE")}
 const result=(payload as {result?:{structuredContent?:Record<string,unknown>;
    isError?:boolean};error?:unknown})?.result;
 if(!result||result.isError||!result.structuredContent||
   result.structuredContent.status!=="ok"||
   result.structuredContent.operation!==tool)
  throw Error("BRIDGE_R2_READ_BLOCKED");
 const answer={status:"ok",via:"sidera-gateway",bridge:"r2-shadow",
   readOnly:true,operation:tool,receipt:result.structuredContent};
 if(JSON.stringify(answer).length>MAX_RESPONSE)throw Error("BRIDGE_R2_OUTPUT_LIMIT");
 return answer;
}
const envelope=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
const blocked=(error:unknown)=>({isError:true,...envelope({
 status:"blocked",code:error instanceof Error?error.message:"BRIDGE_R2_READ_UNAVAILABLE"})});
const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false} as const;

export function registerRemoteBridgeR2ReadOnly(server:McpServer,core:CoreClientConfig):void{
 server.registerTool("remote_bridge_r2_list",{
  description:"List a bounded path under the isolated R2 Shadow read-only workspace. Exact authorized Chief only.",
  inputSchema:z.strictObject({path:z.string().min(1).max(180).optional(),
    depth:z.number().int().min(1).max(2).optional()}),annotations,
 },async input=>{
  try{
   const cfg=r2BridgeReadConfig();
   await authorizeRead(core,cfg);
   return envelope(await callR2BridgeRead(cfg,"fs.list",
     {path:relativeBridgePath(input.path??".",true),depth:input.depth??1}));
  }catch(error){return blocked(error)}
 });
 server.registerTool("remote_bridge_r2_info",{
  description:"Read bounded metadata and optional hash under R2 Shadow, authenticated exact Chief only.",
  inputSchema:z.strictObject({path:z.string().min(1).max(180)}),annotations,
 },async input=>{
  try{
   const cfg=r2BridgeReadConfig();
   await authorizeRead(core,cfg);
   return envelope(await callR2BridgeRead(cfg,"fs.info",
     {path:relativeBridgePath(input.path,true)}));
  }catch(error){return blocked(error)}
 });
 server.registerTool("remote_bridge_r2_read_text",{
  description:"Read a bounded UTF-8 text file from isolated R2 Shadow, authenticated exact Chief only.",
  inputSchema:z.strictObject({path:z.string().min(1).max(180),
    maxBytes:z.number().int().min(1).max(16384).optional()}),annotations,
 },async input=>{
  try{
   const cfg=r2BridgeReadConfig();
   await authorizeRead(core,cfg);
   return envelope(await callR2BridgeRead(cfg,"fs.read_text",
     {path:relativeBridgePath(input.path),maxBytes:input.maxBytes??16384}));
  }catch(error){return blocked(error)}
 });
 server.registerTool("remote_bridge_r2_read_many",{
  description:"Read at most eight small files and hashes under R2 Shadow, authenticated exact Chief only.",
  inputSchema:z.strictObject({paths:z.array(z.string().min(1).max(180)).min(1).max(8),
    maxTotalBytes:z.number().int().min(1).max(24576).optional()}),annotations,
 },async input=>{
  try{
   const cfg=r2BridgeReadConfig();
   await authorizeRead(core,cfg);
   return envelope(await callR2BridgeRead(cfg,"fs.read_many",
     {paths:input.paths.map(value=>relativeBridgePath(value)),maxTotalBytes:input.maxTotalBytes??24576}));
  }catch(error){return blocked(error)}
 });
}
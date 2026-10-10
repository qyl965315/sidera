/** Typed MCP imports: no command launch, arbitrary environment or tool invocation. */
import {z} from 'zod';
export const mcpLink=z.object({name:z.string().trim().min(1).max(100),url:z.string().max(2048).url().refine(v=>{const u=new URL(v);return !u.username&&!u.password&&!u.hash&&!u.search&&(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));})}).strict();
export type McpLink=z.infer<typeof mcpLink>;
export function parseMcpImport(text:string){
 if(text.length>65536)throw Error('IMPORT_TOO_LARGE');const raw=JSON.parse(text);if(!raw||typeof raw!=='object'||Array.isArray(raw)||!raw.mcpServers||typeof raw.mcpServers!=='object'||Array.isArray(raw.mcpServers))throw Error('MCP_SERVERS_REQUIRED');
 const entries=Object.entries(raw.mcpServers);if(entries.length>32)throw Error('TOO_MANY_INTEGRATIONS');const supported:McpLink[]=[],unsupported:Array<{name:string;fields:string[];reason:string}>=[];
 for(const [name,value] of entries){if(!value||typeof value!=='object'||Array.isArray(value)){unsupported.push({name,fields:[],reason:'Unsupported configuration'});continue;}const v=value as Record<string,unknown>,fields=Object.keys(v).filter(k=>!['url','type','transport'].includes(k));
 if(fields.length||v.type!==undefined&&!['http','streamable-http'].includes(String(v.type))||v.transport!==undefined&&!['http','streamable-http'].includes(String(v.transport))){unsupported.push({name,fields,reason:'Only a Streamable HTTP URL is supported; commands, credentials and other fields are never executed'});continue;}
 const result=mcpLink.safeParse({name,url:v.url});if(result.success)supported.push(result.data);else unsupported.push({name,fields:['url'],reason:'A safe Streamable HTTP URL is required'});
 }return {supported,unsupported};
}

import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {parseMcpImport,mcpLink,type McpLink} from './mcp-import.ts';
import {SetupError,type LocalSetup} from './local-setup.ts';
import {hasCoreOwner} from '../hythes/core-client.ts';
type Integration=McpLink&{id:string;enabled:boolean;transport:'streamable-http';binding:null;authReference:null};
export class SimpleMcpManager{
 private setup:LocalSetup;
 constructor(setup:LocalSetup){this.setup=setup;}
 private previews=new Map<string,{expires:number;fingerprint:string;links:McpLink[]}>();
 list():Integration[]{try{return JSON.parse(readFileSync(join(this.setup.data,'mcp-integrations.json'),'utf8'));}catch{return [];}}
 private save(rows:Integration[]){const file=join(this.setup.data,'mcp-integrations.json');writeFileSync(file+'.tmp',JSON.stringify(rows,null,2),{mode:0o600});renameSync(file+'.tmp',file);}
 preview(value:unknown){const p=z.union([z.object({snippet:z.string().max(65536)}).strict(),mcpLink]).parse(value);const parsed='snippet' in p?parseMcpImport(p.snippet):{supported:[p],unsupported:[]};const previewId=randomUUID();this.previews.set(previewId,{expires:Date.now()+600000,fingerprint:JSON.stringify(this.list()),links:parsed.supported});return {previewId,...parsed,toolsCalled:0};}
 async apply(value:unknown){const p=z.object({previewId:z.string().uuid()}).strict().parse(value),review=this.previews.get(p.previewId);if(!review)throw new SetupError('PREVIEW_NOT_FOUND');this.previews.delete(p.previewId);if(review.expires<Date.now()||review.fingerprint!==JSON.stringify(this.list()))throw new SetupError('REVIEW_STALE');if(await hasCoreOwner(this.setup.spec().corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');const rows=this.list(),before=rows.length;for(const link of review.links)if(!rows.some(r=>r.url===link.url&&r.name===link.name))rows.push({...link,id:randomUUID(),enabled:true,transport:'streamable-http',binding:null,authReference:null});this.save(rows);return {state:'CONFIGURED',added:rows.length-before,authenticated:false,toolsCalled:0};}
 async change(value:unknown){const p=z.object({id:z.string().uuid(),action:z.enum(['enable','disable','remove'])}).strict().parse(value);if(await hasCoreOwner(this.setup.spec().corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');const rows=this.list();if(!rows.some(r=>r.id===p.id))throw new SetupError('INTEGRATION_NOT_FOUND');this.save(p.action==='remove'?rows.filter(r=>r.id!==p.id):rows.map(r=>r.id===p.id?{...r,enabled:p.action==='enable'}:r));return {state:'CONFIG_SAVED'};}
 discovery(){const files=process.env.APPDATA?[join(process.env.APPDATA,'Claude','claude_desktop_config.json')]:[];const supported:McpLink[]=[],unsupported:any[]=[];for(const file of files){try{if(!existsSync(file))continue;const value=readFileSync(file,'utf8');if(value.length>65536)continue;const parsed=parseMcpImport(value);supported.push(...parsed.supported);unsupported.push(...parsed.unsupported);}catch{}}return {supported,unsupported,scannedLocations:files.length,toolsCalled:0};}
 async health(value:unknown){const p=z.object({id:z.string().uuid()}).strict().parse(value),r=this.list().find(r=>r.id===p.id);if(!r||!r.enabled)throw new SetupError('SUPPORTED_ENABLED_MCP_REQUIRED');const client=new Client({name:'sidera-inspection',version:'0.1.0'});try{await client.connect(new StreamableHTTPClientTransport(new URL(r.url),{requestInit:{redirect:'error',signal:AbortSignal.timeout(8000)},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}}),{timeout:8000});const tools=await client.listTools(undefined,{timeout:8000});return {state:'AVAILABLE',tools:tools.tools.slice(0,200).map(t=>({name:t.name,description:t.description})),toolsCalled:0,authorityGranted:false};}catch(e){const status=(e as {code?:number;status?:number}).code??(e as {status?:number}).status;return {state:[401,403].includes(Number(status))?'NEEDS_SIGN_IN':'CONNECTION_FAILED',tools:[],toolsCalled:0,uncertain:true};}finally{await client.close().catch(()=>{});}}
}

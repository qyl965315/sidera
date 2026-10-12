import {readFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import { projectWorld } from './project-world.mjs';
import { readLocalHumanWorld } from './local-human.mjs';
export { projectWorld } from './project-world.mjs';
export function rpc(config,method,params={}){
 if(!['world.inspect','runtime.status'].includes(method))throw Error('READ_ONLY_ALLOWLIST');
 return new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:config.corePort});let pending='',done=false;
 const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();e?reject(e):resolve(r);};
 const timer=setTimeout(()=>finish(Object.assign(Error('READ_TIMEOUT'),{code:'uncertain'})),4000);
 socket.on('error',()=>finish(Object.assign(Error('READ_UNAVAILABLE'),{code:'unavailable'})));socket.on('close',()=>finish(Object.assign(Error('READ_CLOSED'),{code:'uncertain'})));
 socket.on('connect',()=>socket.write(JSON.stringify({id:1,token:config.token,method,params})+'\n'));
 socket.on('data',data=>{pending+=data;if(pending.length>8000000)return finish(Error('READ_LIMIT'));let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const r=JSON.parse(line);if(r.id===1)finish(r.error?Object.assign(Error('R1_READ_ERROR'),{code:r.error.code}):null,r.result);}catch{finish(Error('INVALID_READ'));}}});});
}
export async function liveSnapshot(specPath,options={}){const capturedAt=new Date().toISOString();try{
 const spec=JSON.parse(readFileSync(specPath??process.env.SIDERA_RUNTIME_SPEC??new URL('../../.sidera-dev/sol/data/runtime-spec.json',import.meta.url),'utf8'));
 const node=spec.nodes.find(n=>n.nodeId===(process.env.SIDERA_READER_NODE??spec.chiefNodeId));if(!node?.coreToken&&options.localHuman!==true)throw Error('READER_NOT_CONFIGURED');
 const config={corePort:spec.corePort,token:node?.coreToken??''};
 const w=options.localHuman===true ? readLocalHumanWorld(specPath??new URL('../../.sidera-dev/sol/data/runtime-spec.json',import.meta.url).pathname) : await rpc(config,'world.inspect',{limit:200,...(process.env.SIDERA_WORLD_ID?{worldId:process.env.SIDERA_WORLD_ID}:{})});
 const health=[{title:'Core · world.inspect',state:'available',observedAt:capturedAt,evidence:w.emptyFreshProfile?'canonical_records / empty local World':options.localHuman===true?'canonical_records / verified local Human World':'canonical_records / authenticated participant scope'}];
 if(!node?.coreToken)health.push({title:'Core · runtime.status',state:'unavailable',observedAt:capturedAt,evidence:'NO_AUTHENTICATED_NODE'});
 else try{const r=await rpc(config,'runtime.status');health.push({title:'Core · runtime.status',state:r.ready?'ready':'unavailable',observedAt:new Date().toISOString(),evidence:'ready='+String(r.ready)});}catch(e){health.push({title:'Core · runtime.status',state:e.code??'unavailable',observedAt:new Date().toISOString(),evidence:'R1_READ_'+String(e.code??'unavailable').toUpperCase()});}
 try{const r=await fetch('http://127.0.0.1:'+spec.mcpPort+'/healthz',{signal:AbortSignal.timeout(2000)});health.push({title:'Gateway · /healthz',state:r.ok?'reachable':'unavailable',observedAt:new Date().toISOString(),evidence:'HTTP '+r.status+' · transport only'});}catch{health.push({title:'Gateway · /healthz',state:'unavailable',observedAt:new Date().toISOString(),evidence:'HEALTH_READ_UNAVAILABLE'});}
 const projected=projectWorld(w,capturedAt,health);
 const secrets=[spec.httpToken,...spec.nodes.flatMap(n=>[n.coreToken]),...(spec.frontends??[]).map(f=>f.httpToken)].filter(v=>typeof v==='string'&&v.length>8);
 let json=JSON.stringify(projected);for(const secret of secrets)json=json.split(secret).join('[REDACTED]');
 json=json.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi,'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
 return JSON.parse(json);
 }catch(e){return {source:'live',capturedAt,access:e.code==='denied'?'denied':'authorized',readStatus:e.code==='denied'?'denied':e.code==='uncertain'?'uncertain':'unavailable',readCode:'R1_READ_'+String(e.code??'unavailable').toUpperCase(),projects:[],tasks:[],nodes:[],runs:[],dependencies:[],effects:[],resources:[],events:[],connections:[],responsibilities:[],health:[]};}}
export function livePlugin(){return {name:'sidera-read-only',configureServer:attach,configurePreviewServer:attach};}
function attach(server){server.middlewares.use('/api/r1/snapshot',async(req,res)=>{if(!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host??'')){res.statusCode=403;res.end();return;}if(req.method!=='GET'){res.statusCode=405;res.end();return;}if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){res.statusCode=403;res.end();return;}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(await liveSnapshot()));});}

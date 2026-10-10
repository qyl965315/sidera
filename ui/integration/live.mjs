import {readFileSync} from 'node:fs';
import {createConnection} from 'node:net';
const L=v=>({'zh-CN':v==null||v==='unknown'?'未知 / 不可用':v,en:v==null||v==='unknown'?'Unknown / unavailable':v});
const state=s=>s==='completed'?'completed':['running','active'].includes(s)?'working':['queued','waiting','waiting_dependency'].includes(s)?'waiting':['failed','blocked','cancelled','expired'].includes(s)?'error':'uncertain';
const progress={kind:'state-only'};
export function projectWorld(w,capturedAt,health=[]){
 if(w.readOnly!==true||w.semantics?.source!=='canonical_records'||!Array.isArray(w.tasks)||!Array.isArray(w.responsibilities))throw Error('INVALID_CANONICAL_READ');
 const tasks=w.tasks.map(t=>{
 const r=w.responsibilities.find(r=>r.responsibilityId===t.provenance?.responsibilityId),s=(w.supervisions??[]).find(s=>s.supervisionId===t.supervisionId);
 let status=state(t.state);if(status==='working'&&!t.runs?.some(r=>r.execution?.authoritativeRunning===true))status='uncertain';
 const nodes=[t.executingNodeId,...(t.workerNodeIds??[])].filter(Boolean);
 return {id:t.taskId,projectId:r?'responsibility:'+r.responsibilityId:'task:'+t.taskId,displayName:L('Task · '+t.taskId),canonicalName:t.taskId,state:status,progress,goal:L(s?.goal),next:L(s?.nextAction??t.runs?.at(-1)?.execution?.state),groups:nodes.length?[{groupId:t.taskId,step:L('R1 节点分配 / Node assignments'),parallel:false,assignments:nodes.map(nodeId=>({nodeId,state:'uncertain',role:L(nodeId===t.executingNodeId?'执行节点 / Executing Node':'Worker · 并行性未知 / concurrency unknown')}))}]:[],outputs:t.finalResult?.taskCompleted?[L('resultMessageId: '+t.finalResult.messageId+' · '+t.finalResult.deliveryState)]:[],runIds:(t.runs??[]).map(r=>r.runId),responsibilityId:r?.responsibilityId,uncertainty:status==='uncertain'?L('执行状态或外部效果未确认 / Execution or external effect unconfirmed'):undefined,error:status==='error'?{code:'R1_TASK_'+String(t.state).toUpperCase(),category:'canonical-task-state',reason:L('R1 state: '+t.state+' · 详细错误不可用 / error detail unavailable')}:undefined};});
 const projects=w.responsibilities.map(r=>({id:'responsibility:'+r.responsibilityId,displayName:L(r.title),goal:L(r.scope),state:state(r.state),progress,taskIds:tasks.filter(t=>t.responsibilityId===r.responsibilityId).map(t=>t.id),recent:[L('Responsibility · '+r.state+' · '+r.updatedAt)]}));
 for(const t of tasks.filter(t=>!t.responsibilityId))projects.push({id:t.projectId,displayName:L('独立工作项 / Standalone · '+t.id),goal:L('无可见 Responsibility 关联 / No visible Responsibility membership'),state:t.state,progress,taskIds:[t.id],recent:[]});
 return {source:'live',capturedAt,access:'authorized',readStatus:'available',worldId:w.worldId,truncated:!!w.truncated,canonicalReportFacts:{source:'canonical_records',tasks:w.tasks,nodes:w.nodes??[],recentProgress:w.recentProgress??[]},health,projects,tasks,nodes:(w.nodes??[]).map(n=>({id:n.nodeId,displayName:n.displayName,health:n.sessions?.find(s=>s.state==='active')?.health?.state??'UNKNOWN',modelBinding:{id:'unknown',provider:'unknown',modelId:'unknown'},sessions:n.sessions.map(s=>({id:s.sessionId,state:s.state,hostId:'unknown',hytheId:s.adapterId,locatorRef:'unavailable',health:s.health}))})),runs:w.tasks.flatMap(t=>(t.runs??[]).map((r,i)=>({id:r.runId,taskId:t.taskId,sequence:i,state:r.state,targetSessionId:r.sessionId,hostTurnEnded:!r.turnOpen,checkpoint:L(r.checkpointOutcome),execution:r.execution}))),dependencies:w.tasks.flatMap(t=>(t.dependencies??[]).map(d=>({id:d.parentRunId+':'+d.childTaskId,...d}))),effects:[],resources:[],events:(w.recentProgress??[]).map(e=>({id:e.eventId,title:L(e.kind+' · '+e.createdAt),attests:[]})),connections:[],responsibilities:w.responsibilities.map(r=>({id:r.responsibilityId,state:r.state,deferReason:r.deferredReason?L(r.deferredReason):undefined}))};
}
export function rpc(config,method,params={}){
 if(!['world.inspect','runtime.status'].includes(method))throw Error('READ_ONLY_ALLOWLIST');
 return new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:config.corePort});let pending='',done=false;
 const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();e?reject(e):resolve(r);};
 const timer=setTimeout(()=>finish(Object.assign(Error('READ_TIMEOUT'),{code:'uncertain'})),4000);
 socket.on('error',()=>finish(Object.assign(Error('READ_UNAVAILABLE'),{code:'unavailable'})));socket.on('close',()=>finish(Object.assign(Error('READ_CLOSED'),{code:'uncertain'})));
 socket.on('connect',()=>socket.write(JSON.stringify({id:1,token:config.token,method,params})+'\n'));
 socket.on('data',data=>{pending+=data;if(pending.length>8000000)return finish(Error('READ_LIMIT'));let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const r=JSON.parse(line);if(r.id===1)finish(r.error?Object.assign(Error('R1_READ_ERROR'),{code:r.error.code}):null,r.result);}catch{finish(Error('INVALID_READ'));}}});});
}
export async function liveSnapshot(specPath){const capturedAt=new Date().toISOString();try{
 const spec=JSON.parse(readFileSync(specPath??process.env.SIDERA_RUNTIME_SPEC??new URL('../../.sidera-dev/sol/data/runtime-spec.json',import.meta.url),'utf8'));
 const node=spec.nodes.find(n=>n.nodeId===(process.env.SIDERA_READER_NODE??spec.chiefNodeId));if(!node?.coreToken)throw Error('READER_NOT_CONFIGURED');
 const config={corePort:spec.corePort,token:node.coreToken};
 const w=await rpc(config,'world.inspect',{limit:200,...(process.env.SIDERA_WORLD_ID?{worldId:process.env.SIDERA_WORLD_ID}:{})});
 const health=[{title:'Core · world.inspect',state:'available',observedAt:capturedAt,evidence:'canonical_records / authenticated participant scope'}];
 try{const r=await rpc(config,'runtime.status');health.push({title:'Core · runtime.status',state:r.ready?'ready':'unavailable',observedAt:new Date().toISOString(),evidence:'ready='+String(r.ready)});}catch(e){health.push({title:'Core · runtime.status',state:e.code??'unavailable',observedAt:new Date().toISOString(),evidence:'R1_READ_'+String(e.code??'unavailable').toUpperCase()});}
 try{const r=await fetch('http://127.0.0.1:'+spec.mcpPort+'/healthz',{signal:AbortSignal.timeout(2000)});health.push({title:'Gateway · /healthz',state:r.ok?'reachable':'unavailable',observedAt:new Date().toISOString(),evidence:'HTTP '+r.status+' · transport only'});}catch{health.push({title:'Gateway · /healthz',state:'unavailable',observedAt:new Date().toISOString(),evidence:'HEALTH_READ_UNAVAILABLE'});}
 const projected=projectWorld(w,capturedAt,health);
 const secrets=[spec.httpToken,...spec.nodes.flatMap(n=>[n.coreToken]),...(spec.frontends??[]).map(f=>f.httpToken)].filter(v=>typeof v==='string'&&v.length>8);
 let json=JSON.stringify(projected);for(const secret of secrets)json=json.split(secret).join('[REDACTED]');
 json=json.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi,'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
 return JSON.parse(json);
 }catch(e){return {source:'live',capturedAt,access:e.code==='denied'?'denied':'authorized',readStatus:e.code==='denied'?'denied':e.code==='uncertain'?'uncertain':'unavailable',readCode:'R1_READ_'+String(e.code??'unavailable').toUpperCase(),projects:[],tasks:[],nodes:[],runs:[],dependencies:[],effects:[],resources:[],events:[],connections:[],responsibilities:[],health:[]};}}
export function livePlugin(){return {name:'sidera-read-only',configureServer:attach,configurePreviewServer:attach};}
function attach(server){server.middlewares.use('/api/r1/snapshot',async(req,res)=>{if(!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host??'')){res.statusCode=403;res.end();return;}if(req.method!=='GET'){res.statusCode=405;res.end();return;}if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){res.statusCode=403;res.end();return;}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(await liveSnapshot()));});}

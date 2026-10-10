import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {LocalSetup} from '../core/local-setup.ts';
import {startWorkbench} from '../scripts/local-launcher.ts';
import {parseMcpImport} from '../core/mcp-import.ts';
import {SimpleMcpManager} from '../core/mcp-simple.ts';
import {presentReport} from '../ui/src/reportPresentation.ts';

test('MCP imports allow only typed HTTP entries; unsupported commands/credentials never partially execute',()=>{
 const value=parseMcpImport(JSON.stringify({mcpServers:{valid:{url:'https://example.org/mcp',type:'http'},exec:{command:'node',args:['evil.js']},credential:{url:'https://example.org/mcp',headers:{Authorization:'secret'}},sse:{url:'https://example.org/sse',type:'sse'},unsafe:{url:'https://user:secret@example.org/mcp'},query:{url:'https://example.org/mcp?token=secret'}}}));
 assert.deepEqual(value.supported,[{name:'valid',url:'https://example.org/mcp'}]);assert.equal(value.unsupported.length,5);assert.ok(!JSON.stringify(value).includes('secret'));assert.throws(()=>parseMcpImport('{'));assert.throws(()=>parseMcpImport(JSON.stringify({mcpServers:Object.fromEntries(Array.from({length:33},(_,i)=>[i,{}]))})));
});
test('MCP preview/apply is one-time, typed, deduplicated and detects changed configuration',async()=>{
 const setup=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-mcp-simple-')));setup.bootstrap();const m=new SimpleMcpManager(setup);
 const first=m.preview({name:'Local service',url:'http://127.0.0.1:47499/mcp'});assert.equal(m.list().length,0);await m.apply({previewId:first.previewId});assert.equal(m.list().length,1);await assert.rejects(()=>m.apply({previewId:first.previewId}),/PREVIEW_NOT_FOUND/);
 const pending=m.preview({name:'Second',url:'https://example.org/mcp'});await m.change({id:m.list()[0]!.id,action:'disable'});await assert.rejects(()=>m.apply({previewId:pending.previewId}),/REVIEW_STALE/);assert.equal(m.list()[0]!.enabled,false);
});
test('simple MCP health checks initialize and list features without calling tools; protected endpoints need sign-in',async()=>{
 const setup=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-mcp-health-')));setup.bootstrap();const manager=new SimpleMcpManager(setup),servers=new Set<McpServer>();let calls=0,needsAuth=false;
 const http=createHttpServer(async(req,res)=>{if(needsAuth){res.writeHead(401);res.end();return;}if(req.method!=='POST'){res.writeHead(405);res.end();return;}const server=new McpServer({name:'local-health-fixture',version:'1'});servers.add(server);server.registerTool('read.document',{},async()=>{calls++;return {content:[]};});const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);let body='';for await(const chunk of req)body+=chunk;await transport.handleRequest(req,res,JSON.parse(body));});
 await new Promise<void>(ok=>http.listen(0,'127.0.0.1',ok));try{const preview=manager.preview({name:'Documents',url:`http://127.0.0.1:${(http.address() as {port:number}).port}/mcp`});await manager.apply({previewId:preview.previewId});const id=manager.list()[0]!.id;const health=await manager.health({id});assert.equal(health.state,'AVAILABLE');assert.equal(health.tools[0]!.name,'read.document');assert.equal(calls,0);needsAuth=true;assert.equal((await manager.health({id})).state,'NEEDS_SIGN_IN');assert.equal(calls,0);await manager.change({id,action:'disable'});await assert.rejects(()=>manager.health({id}),/SUPPORTED_ENABLED_MCP_REQUIRED/);}finally{await Promise.all([...servers].map(s=>s.close()));await new Promise<void>(ok=>http.close(()=>ok()));}
});
test('report modes preserve unknown truth, independently control detail and exact identifiers',()=>{
 const snapshot={access:'authorized',readStatus:'available',source:'live',capturedAt:'2026-10-06T12:00:00Z',tasks:[{id:'exact-task',state:'uncertain',displayName:'Work',next:'Await evidence',runIds:['exact-run'],groups:[{step:'Review'}],outputs:[],uncertainty:'UNKNOWN'}],runs:[{id:'exact-run',state:'UNKNOWN'}],effects:[{id:'exact-effect',state:'UNKNOWN'}],nodes:[],events:[]};
 for(const detail of ['brief','detailed'] as const)for(const precision of ['overview','exact'] as const){const r=presentReport(snapshot,detail,precision,true);assert.ok(r.outcome.includes('review'));assert.equal('work' in r,detail==='detailed');assert.equal('exact' in r,precision==='exact');assert.equal(JSON.stringify(r).includes('exact-task'),precision==='exact');if(precision==='exact')assert.ok(JSON.stringify(r).includes('UNKNOWN'));}
 assert.ok(presentReport(undefined,'brief','overview',true).outcome.includes('Unknown'));assert.ok(!presentReport({...snapshot,readStatus:'unavailable'},'brief','overview',true).outcome.includes('completed'));
 const exact=presentReport({...snapshot,canonicalReportFacts:{source:'canonical_records',tasks:[{taskId:'exact-task',state:'waiting_dependency',createdAt:'exact-time',runs:[],effects:[{knowledge:'UNKNOWN'}]}],recentProgress:[{eventId:'evidence-ref'}]}},'brief','exact',true);
 assert.equal(exact.exact.tasks[0].state,'waiting_dependency');assert.equal(exact.exact.tasks[0].createdAt,'exact-time');assert.equal(exact.exact.effects[0].knowledge,'UNKNOWN');assert.equal(exact.exact.evidence[0].eventId,'evidence-ref');
 assert.equal(Object.keys(presentReport(snapshot,'brief','overview',true)).length,4);
});
test('button approval rejects renderer-only and foreign-origin calls, native cancel has no effect, approved review is exact and one-time',async()=>{
 const probe=createServer();await new Promise<void>(ok=>probe.listen(0,'127.0.0.1',ok));const port=(probe.address() as {port:number}).port;await new Promise<void>(ok=>probe.close(()=>ok()));
 let approved=false,statement='';const app=await startWorkbench(mkdtempSync(join(tmpdir(),'sidera-button-')),port,{assetRoot:process.cwd(),approveHuman:async value=>{statement=value;return approved;}});
 const post=(op:string,input:unknown,origin=app.address)=>fetch(app.address+'/api/setup/'+op,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
 try{const human=await app.setup.createHuman({label:'Human'});await app.setup.addNode({label:'Service',edgeId:'test',locator:'external-mcp://test/exact'});const review=await post('profile-review',{humanId:human.humanId,mode:'read-only'}).then(r=>r.json());assert.equal(review.confirmationText,undefined);
 assert.equal((await post('approve',{reviewId:review.reviewId},'https://foreign.test')).status,403);const cancelled=await post('approve',{reviewId:review.reviewId});assert.equal((await cancelled.json()).code,'NATIVE_HUMAN_CONFIRMATION_REQUIRED');assert.equal(statement,'');
 approved=true;assert.equal((await post('approve',{reviewId:review.reviewId,approved:true})).status,400);assert.equal((await post('approve',{reviewId:review.reviewId})).status,400);assert.equal(statement,'');const privileged=app.setup.nativeReview({reviewId:review.reviewId});assert.equal(privileged.statement,review.exactStatement);privileged.apply();assert.throws(()=>privileged.apply());
 }finally{await app.close();}
});
test('server-held native review preserves config fingerprint, expiry and policy epoch after the dialog',async()=>{
 const setup=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-review-expiry-')));setup.bootstrap();const h=await setup.createHuman({label:'Human'});await setup.addNode({label:'Service',edgeId:'x',locator:'external-mcp://x/exact'});
 const first=setup.profile({humanId:h.humanId,mode:'read-only'}),closure=setup.nativeReview({reviewId:first.reviewId});setup.writeSpec({...setup.spec(),corePort:49998});assert.throws(()=>closure.apply(),/REVIEW_STALE/);
 const second=setup.profile({humanId:h.humanId,mode:'read-only'}),policy=setup.nativeReview({reviewId:second.reviewId});const db=setup.db();try{db.prepare('UPDATE trust_policy SET epoch=epoch+1 WHERE world_id=?').run(setup.world());}finally{db.close();}assert.throws(()=>policy.apply(),/REVIEW_STALE/);
 const third=setup.profile({humanId:h.humanId,mode:'read-only'});const now=Date.now;Date.now=()=>now()+600001;try{assert.throws(()=>setup.nativeReview({reviewId:third.reviewId}),/REVIEW_STALE/);}finally{Date.now=now;}
});

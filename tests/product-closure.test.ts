import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSetup} from '../core/local-setup.ts';
import {browserSafe} from '../core/browser-redaction.ts';
const fresh=()=>{const s=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-product-')));s.bootstrap();return s;};
test('API bounded schema preserves secret references; no model identity or readiness invented',async()=>{
 const s=fresh();const input={label:'API',hostKind:'generic-api',protocol:'openai-compatible',providerId:'deepseek',baseUrl:'https://api.deepseek.com/',credentialRef:'env:SIDERA_TEST_KEY'};
 await assert.rejects(s.addApiHost({...input,options:{key:'raw'}}));await assert.rejects(s.addApiHost({...input,baseUrl:'https://user:password@example.com/'}));await assert.rejects(s.addApiHost({...input,credentialRef:'raw-key'}));
 const result=await s.addApiHost(input);assert.equal(result.authenticated,false);assert.equal(s.spec().nodes[0]!.model,undefined);
 const db=s.db();assert.equal(db.prepare('SELECT count(*) n FROM model_bindings').get()!.n,0);db.close();
 const status=await s.status();assert.equal(status.readiness.FULL_ROUTE_READY,false);assert.equal(status.readiness.LOCAL_READY,false);
 process.env.SIDERA_TEST_KEY='private-test-value';try{assert.ok(!JSON.stringify(browserSafe({nested:'private-test-value'},s.spec())).includes('private-test-value'));}finally{delete process.env.SIDERA_TEST_KEY;}
});
test('Human rename requires exact confirmation and preserves Node/session/history',async()=>{
 const s=fresh(),{humanId}=await s.createHuman({label:'Human'}),node=await s.addNode({label:'Original',edgeId:'edge',locator:'external-mcp://edge/exact'});
 const r=s.rename({humanId,nodeId:node.nodeId,expectedDisplayName:'Original',displayName:'Renamed'});
 assert.throws(()=>s.confirm({reviewId:r.reviewId,confirmation:''}),/HUMAN_CONFIRMATION_REQUIRED/);
 const db=s.db();assert.equal(db.prepare('SELECT display_name FROM nodes WHERE node_id=?').get(node.nodeId)!.display_name,'Original');db.close();
 s.confirm({reviewId:r.reviewId,confirmation:r.confirmationText});assert.equal((await s.status()).nodes[0]!.displayName,'Renamed');assert.equal(s.spec().nodes[0]!.sessionId,node.sessionId);
 assert.throws(()=>s.confirm({reviewId:r.reviewId,confirmation:r.confirmationText}),/REVIEW_NOT_FOUND/);
});
test('MCP route pins exact active binding, validates adapter schema, does not authenticate or send',async()=>{
 const s=fresh(),{humanId}=await s.createHuman({label:'Human'});await s.addNode({label:'Chat',edgeId:'edge',locator:'external-mcp://edge/exact'});
 const r=s.chief({humanId,projectSpaceId:'project',projectRef:'sidera://project',frontendKind:'chatgpt-web',conversationRef:'https://chatgpt.com/c/synthetic-test'});
 const b=s.confirm({reviewId:r.reviewId,confirmation:r.confirmationText}) as {bindingId:string};
 const input={bindingId:b.bindingId,endpoint:'https://example.com/mcp',secretRef:'env:SIDERA_ROUTE_TEST',locateTool:'locate_exact',sendTool:'send_exact'};
 await assert.rejects(s.configureRoute({...input,endpoint:'https://example.com/mcp?token=private'}));await assert.rejects(s.configureRoute({...input,bindingId:'wrong'}));
 assert.equal((await s.configureRoute(input)).authenticated,false);assert.deepEqual(s.spec().frontend!.routes![0]!.bindings,[{bindingId:b.bindingId,projectSpaceId:'project',conversationRef:'https://chatgpt.com/c/synthetic-test'}]);
 await assert.rejects(s.configureRoute(input),/ROUTE_ALREADY_CONFIGURED/);assert.equal((await s.status()).readiness.FULL_ROUTE_READY,false);
 const db=s.db();assert.equal(db.prepare('SELECT count(*) n FROM frontend_presence_observations').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM logical_actions').get()!.n,0);db.close();
});
test('native route cannot be installed without actual bridge and context',async()=>{
 const s=fresh();const old=process.env.SIDERA_CODEX_APP_TOOLS_SERVER;delete process.env.SIDERA_CODEX_APP_TOOLS_SERVER;
 try{await assert.rejects(s.configureNative({bindingId:'missing'}),/REAL_NATIVE_BRIDGE_CONTEXT_REQUIRED/);}finally{if(old!==undefined)process.env.SIDERA_CODEX_APP_TOOLS_SERVER=old;}
});

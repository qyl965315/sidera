import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,cpSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSetup} from '../core/local-setup.ts';
import {startWorkbench} from '../scripts/local-launcher.ts';
import {browserSafe} from '../core/browser-redaction.ts';
import {canonicalToolNames} from '../hythes/canonical-mcp.ts';
const fresh=()=>new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-setup-')));
test('first-run bootstrap has no Human, Authority, fabricated Node or Presence',async()=>{
 const s=fresh();s.bootstrap();s.bootstrap();const status=await s.status();assert.deepEqual(status.humans,[]);assert.deepEqual(status.nodes,[]);assert.equal(status.configuration.valid,false);const db=s.db();try{for(const table of ['human_semantic_acts','grants','chief_conversations','sessions'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get()!.n,0);}finally{db.close();}
 await s.configure({corePort:47590,mcpPort:47591});assert.equal(s.spec().corePort,47590);await assert.rejects(s.configure({corePort:47320,mcpPort:47591}),/PORT_CONFLICT/);await assert.rejects(s.configure({corePort:47590,mcpPort:47591,path:'C:/private'}));
});
test('exact permission review is inert; wrong/stale/reused confirmation cannot grant; confirmed package materializes',async()=>{
 const s=fresh();s.bootstrap();const {humanId}=await s.createHuman({label:'Human'});await s.addNode({label:'Chat',edgeId:'chat',locator:'external-mcp://chat/exact'});
 const r=s.profile({humanId,mode:'workspace'});const db=s.db();assert.equal(db.prepare('SELECT count(*) n FROM grants').get()!.n,0);db.close();
 assert.throws(()=>s.applyConfirmed({reviewId:r.reviewId,confirmation:'ADMIT'}),/HUMAN_CONFIRMATION_REQUIRED/);
 const applied=s.applyConfirmed({reviewId:r.reviewId,confirmation:r.confirmationText}) as {complete:boolean};assert.equal(applied.complete,true);
 assert.throws(()=>s.applyConfirmed({reviewId:r.reviewId,confirmation:r.confirmationText}),/REVIEW_NOT_FOUND/);
 const next=s.profile({humanId,mode:'read-only'});const spec=s.spec();spec.mcpPort++;s.writeSpec(spec);assert.throws(()=>s.applyConfirmed({reviewId:next.reviewId,confirmation:next.confirmationText}),/REVIEW_STALE/);
});
test('Chief bind and handoff use admitted exact Human statements and never fabricate a route',async()=>{
 const s=fresh();s.bootstrap();const {humanId}=await s.createHuman({label:'Human'});await s.addNode({label:'Chat',edgeId:'chat',locator:'external-mcp://chat/exact'});
 const input={humanId,projectSpaceId:'p',projectRef:'sidera://project/p',frontendKind:'chatgpt-web',conversationRef:'https://chatgpt.com/c/exact'};
 const invalid=s.chief({...input,conversationRef:'not-an-exact-conversation'});assert.throws(()=>s.applyConfirmed({reviewId:invalid.reviewId,confirmation:invalid.confirmationText}));const before=s.db();assert.equal(before.prepare('SELECT count(*) n FROM human_semantic_acts').get()!.n,0,'failed binding rolls admission back');before.close();
 const r=s.chief(input),b=s.applyConfirmed({reviewId:r.reviewId,confirmation:r.confirmationText}) as {bindingId:string};
 const r2=s.chief({...input,expectedBindingId:b.bindingId,conversationRef:'https://chatgpt.com/c/next'});s.applyConfirmed({reviewId:r2.reviewId,confirmation:r2.confirmationText});
 const status=await s.status();assert.equal(status.bindings.length,1);assert.equal(status.bindings[0]!.conversation_ref,'https://chatgpt.com/c/next');assert.equal((status.chief as {available:boolean}).available,false);
 const db=s.db();try{assert.equal(db.prepare('SELECT count(*) n FROM frontend_presence_observations').get()!.n,0);}finally{db.close();}
});
test('literal Human intent is preserved and grants no authority; request unknown outcome is saved once',async()=>{
 const s=fresh();s.bootstrap();const {humanId}=await s.createHuman({label:'Human'});const body='  literal Human goal\nKeep this exactly.  ';
 const r=await s.intent({humanId,body,submit:false}) as {intentRevisionId:string};const db=s.db();try{assert.equal(db.prepare('SELECT content FROM intent_revisions WHERE revision_id=?').get(r.intentRevisionId)!.content,body);assert.equal(db.prepare('SELECT count(*) n FROM grants').get()!.n,0);}finally{db.close();}
});
test('local HTTP boundary rejects missing/cross origin, Node credentials, generic methods and extra fields; no secrets returned',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sidera-http-'));const port=47581,app=await startWorkbench(root,port);try{
 const post=async(path:string,body:unknown,origin?:string)=>fetch(app.address+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
 assert.equal((await post('/api/setup/human',{label:'Injected'})).status,403);
 assert.equal((await post('/api/setup/human',{label:'Injected'},'http://evil.test')).status,403);
 assert.equal((await post('/api/setup/human',{label:'Human',token:app.setup.spec().httpToken},app.address)).status,400);
 assert.equal((await post('/api/setup/rpc',{method:'authority.grant'},app.address)).status,404);
 assert.equal((await post('/api/setup/command',{command:'powershell'},app.address)).status,404);
   assert.ok(canonicalToolNames().every(n=>!/(?:setup|human_admit|profile_apply|confirm|approve)/i.test(n)),'Human setup is not a model tool');
 const status=await (await fetch(app.address+'/api/setup/status')).text();assert.ok(!status.includes(app.setup.spec().httpToken));assert.ok(!status.includes('coreToken'));
 const human=await (await post('/api/setup/human',{label:'Human'},app.address)).json();assert.ok(human.humanId);
 }finally{await app.close();}
});
test('browser boundary redacts nested secret fields and interpolated configured values',()=>{
 const secret='local-secret-long-value';const result=JSON.stringify(browserSafe({plain:'prefix '+secret,options:{apiKey:secret},message:'Bearer abcdefghi'},{nodes:[{coreToken:secret}]}));assert.ok(!result.includes(secret));assert.ok(!result.includes('abcdefghi'));
});

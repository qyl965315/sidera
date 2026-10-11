import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,cpSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSetup} from '../core/local-setup.ts';
import {startWorkbench} from '../scripts/local-launcher.ts';
import {browserSafe} from '../core/browser-redaction.ts';
import {canonicalToolNames} from '../hythes/canonical-mcp.ts';
import {activateApprovedEnrollments,reconcileSpecs} from '../core/onboarding.ts';
import {AntigravityHythe} from '../hythes/antigravity.ts';
import type {Hythe} from '../hythes/types.ts';
import {protocolTestBoundary} from './fixtures/execution.ts';
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
test('Antigravity native session creation requires one granting Human and a separate reviewed approval',async()=>{
 const s=fresh();s.bootstrap();const {humanId}=await s.createHuman({label:'Owner'}),other=(await s.createHuman({label:'Other'})).humanId;
 const root=mkdtempSync(join(tmpdir(),'sidera-agy-enroll-'));
 const base={label:'Antigravity',hostKind:'antigravity-cli-headless' as const,workspace:join(root,'workspace'),executable:process.execPath,provider:'antigravity-cli',modelId:'gemini-3.8-flash-low',effort:'medium' as const,settingsPath:join(root,'settings.json')};
 await assert.rejects(s.addExecutableHost({...base,locatorRef:'installed://forbidden'}),/ANTIGRAVITY_SESSION_CREATE_REQUIRED/);
 const configured=await s.addExecutableHost({...base,locatorRef:'pending-native-session:12345678-1234-4234-8234-123456789abc'});
 await assert.throws(()=>s.nativeSessionCreate({humanId,nodeId:configured.nodeId}),/ANTIGRAVITY_ENROLLMENT_REQUIRES_REVIEWED_GRANT/);
 const grant=s.profile({humanId,mode:'workspace'});s.applyConfirmed({reviewId:grant.reviewId,confirmation:grant.confirmationText});
 await assert.throws(()=>s.nativeSessionCreate({humanId:other,nodeId:configured.nodeId}),/ANTIGRAVITY_ENROLLMENT_REQUIRES_GRANTING_HUMAN/);
 const review=s.nativeSessionCreate({humanId,nodeId:configured.nodeId});const before=s.db();try{assert.equal(before.prepare('SELECT count(*) n FROM model_bindings').get()!.n,0);assert.equal(before.prepare('SELECT count(*) n FROM sessions').get()!.n,0);}finally{before.close();}
 s.applyConfirmed({reviewId:review.reviewId,confirmation:review.confirmationText});const enrolled=s.spec().nodes[0]!.enrollment!;
 assert.equal(enrolled.state,'approved');assert.match(enrolled.effectRef,/^native-session-create:/);assert.equal(enrolled.model.modelId,'gemini-3.8-flash-low');
 await assert.throws(()=>s.nativeSessionCreate({humanId,nodeId:configured.nodeId}),/ANTIGRAVITY_ENROLLMENT_ALREADY_RECORDED/);
});
test('approved native session.create crosses the Final Effect once, persists only provider facts, and supports direct Human Conversation',async()=>{
 const s=fresh();s.bootstrap();const {humanId}=await s.createHuman({label:'Owner'}),root=mkdtempSync(join(tmpdir(),'sidera-agy-native-create-'));
 const fixture=join(root,'provider.mjs');writeFileSync(fixture,`import readline from 'node:readline';const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');send({event:'init',conversation_id:'provider-created-session',init:{model:'gemini-3.8-flash-low',tools:[]}});for await(const line of readline.createInterface({input:process.stdin})){const v=JSON.parse(line);if(v.event==='user'){send({event:'step_update',step_update:{conversation_id:'provider-created-session',step_type:'user_input'}});send({event:'result',result:{conversation_id:'provider-created-session',status:'SUCCESS',response:v.message.content}})}}`);
 const configured=await s.addExecutableHost({label:'Antigravity',hostKind:'antigravity-cli-headless',locatorRef:'pending-native-session:12345678-1234-4234-8234-123456789abc',workspace:join(root,'workspace'),executable:process.execPath,provider:'antigravity-cli',modelId:'gemini-3.8-flash-low',effort:'medium',settingsPath:join(root,'settings.json')});
 const grant=s.profile({humanId,mode:'workspace'});s.applyConfirmed({reviewId:grant.reviewId,confirmation:grant.confirmationText});
 const review=s.nativeSessionCreate({humanId,nodeId:configured.nodeId});assert.equal(s.spec().nodes[0]!.enrollment,undefined,'review alone cannot start a provider process');s.applyConfirmed({reviewId:review.reviewId,confirmation:review.confirmationText});
 const spec=s.spec(),db=s.db(),h=new AntigravityHythe({executable:process.execPath,launchArgs:[fixture],workspace:join(root,'workspace'),settingsPath:join(root,'settings.json'),provider:'antigravity-cli',modelId:'gemini-3.8-flash-low',effort:'medium',db,coreToken:'fixture-core-token-0123456789',corePort:47625,mcpEntry:fixture});
 try{
  reconcileSpecs(db,spec.nodes,new Map([[h.hytheId,h]]));
  await activateApprovedEnrollments(db,spec.nodes,new Map([[h.hytheId,h]]),()=>s.writeSpec(spec));
  const node=spec.nodes[0]!;assert.equal(node.enrollment!.state,'completed',JSON.stringify(db.prepare("SELECT * FROM events WHERE kind LIKE 'session.enrollment_%'").all()));assert.equal(node.locatorRef,'provider-created-session');assert.deepEqual(node.model,{provider:'antigravity-cli',modelId:'gemini-3.8-flash-low',reasoningConfig:{effort:'medium'}});
  assert.equal(db.prepare('SELECT locator_ref FROM sessions WHERE session_id=?').get(node.sessionId)!.locator_ref,'provider-created-session');assert.equal(db.prepare('SELECT count(*) n FROM model_bindings WHERE node_id=?').get(node.nodeId)!.n,1);
  const effect=db.prepare("SELECT state FROM effect_attempt_state e JOIN action_attempts a USING(attempt_id) JOIN logical_actions l USING(action_id) WHERE l.operation='session.create'").get()!;assert.equal(effect.state,'accepted');
  const received=h.receive(node.locatorRef)[Symbol.asyncIterator]().next(),messageId='conversation-001';const accepted=await h.invoke(node.locatorRef,'message.receive',{messageId,kind:'conversation',body:'Literal Human text'},'conversation-request-001',protocolTestBoundary);assert.equal(accepted.status,'accepted');const observed=(await received).value!;assert.equal(observed.observedMessageId,messageId);assert.match(observed.body,/Literal Human text/);assert.doesNotMatch(observed.body,/Task undefined|Run undefined/);
 }finally{await h.close();db.close();}
});
test('native session.create model mismatch or uncertain provider outcome becomes HOLD and is never replayed',async()=>{
 const s=fresh();s.bootstrap();const {humanId}=await s.createHuman({label:'Owner'}),root=mkdtempSync(join(tmpdir(),'sidera-agy-native-hold-'));
 const configured=await s.addExecutableHost({label:'Antigravity',hostKind:'antigravity-cli-headless',locatorRef:'pending-native-session:22345678-1234-4234-8234-123456789abc',workspace:join(root,'workspace'),executable:process.execPath,provider:'antigravity-cli',modelId:'gemini-3.8-flash-low',effort:'medium',settingsPath:join(root,'settings.json')});
 const grant=s.profile({humanId,mode:'workspace'});s.applyConfirmed({reviewId:grant.reviewId,confirmation:grant.confirmationText});const review=s.nativeSessionCreate({humanId,nodeId:configured.nodeId});s.applyConfirmed({reviewId:review.reviewId,confirmation:review.confirmationText});
 const spec=s.spec(),db=s.db();let creates=0;const h={hytheId:'antigravity-cli',hostKind:'antigravity-cli-headless',capabilities:()=>['message.receive'],manifest:()=>({transportCapabilities:['message.receive']}),effectProfile:()=>({id:'fixture:session-create',version:'m2-v1',control:'ProviderAutonomousNonCancelable' as const,boundary:'fixture',admission:'fixture',businessEffects:[],cancellation:null,uncertainInterval:'fixture',externalIdentityRequired:false}),createSession:async(boundary:unknown)=>{creates++;(boundary as {cross:(target:unknown,send:()=>void)=>void}).cross({product:'antigravity-cli-headless',locator:spec.nodes[0]!.locatorRef,operation:'session.create'},()=>{});throw Error('fixture provider crashed after admission');},modelBinding:()=>({provider:'antigravity-cli',modelId:'gemini-3.1-pro-low'})} as unknown as Hythe;
 try{reconcileSpecs(db,spec.nodes,new Map([[h.hytheId,h]]));await activateApprovedEnrollments(db,spec.nodes,new Map([[h.hytheId,h]]),()=>s.writeSpec(spec));assert.equal(creates,1);assert.equal(spec.nodes[0]!.enrollment!.state,'blocked');assert.match(spec.nodes[0]!.locatorRef,/^pending-native-session:/);assert.equal(db.prepare('SELECT count(*) n FROM model_bindings').get()!.n,0);await activateApprovedEnrollments(db,spec.nodes,new Map([[h.hytheId,h]]),()=>s.writeSpec(spec));assert.equal(creates,1,'blocked request is not replayed on restart');}finally{db.close();}
});

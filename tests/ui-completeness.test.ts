import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSetup} from '../core/local-setup.ts';
import {executableHostInput} from '../core/host-setup.ts';
import {canonicalToolNames} from '../hythes/canonical-mcp.ts';
test('every mapped function and canonical MCP tool has a visible catalog location; Node actions never execute as Human',()=>{
 const catalog=JSON.parse(readFileSync('ui/src/capability-catalog.json','utf8')) as Array<{name:string;actor:string;executable:boolean;location:string;why:string}>;
 const rows=readFileSync('FUNCTION_INTERFACE_MAP.md','utf8').split('\n').filter(l=>l.startsWith('| ')&&!l.startsWith('| ---')&&!l.startsWith('| Human-facing'));
 for(const row of rows)assert.ok(catalog.some(c=>c.name===row.split('|')[1].trim()&&c.location));
 for(const tool of canonicalToolNames())assert.ok(catalog.some(c=>c.name===tool));
 for(const c of catalog.filter(c=>c.actor==='Node')){assert.equal(c.executable,false);assert.ok(c.why);}
 for(const op of ['session.handoff','node.retire','message.reconcile_result','task.reconcile_result'])assert.ok(catalog.some(c=>c.name===op&&!c.executable));
});
test('typed Host schemas reject shell arguments, unknown options and non-loopback native services',()=>{
 const input={label:'Host',hostKind:'grok-build-acp',locatorRef:'grok://exact',workspace:'D:/workspace',executable:'D:/host/grok.exe',home:'D:/isolated'};
 assert.ok(executableHostInput.safeParse(input).success);
 assert.equal(executableHostInput.safeParse({...input,launchArgs:['--command','arbitrary']}).success,false);
 assert.equal(executableHostInput.safeParse({...input,options:{}}).success,false);
 assert.equal(executableHostInput.safeParse({...input,executable:'grok && shell'}).success,false);
});
test('reviewed revoke is inert before confirmation, revokes only the exact package and preserves history',async()=>{
 const s=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-ui-revoke-')));s.bootstrap();const {humanId}=await s.createHuman({label:'Human'});
 await s.addNode({label:'Chat',edgeId:'chat',locator:'external-mcp://chat/exact'});
 const r=s.profile({humanId,mode:'workspace'});s.confirm({reviewId:r.reviewId,confirmation:r.confirmationText});
 const status=await s.status();const revoke=s.revoke({humanId,packageActId:status.authority.actId,reason:'End exact package'});
 assert.ok((await s.status()).authority.grants?.some(g=>!g.revoked_at));
 assert.throws(()=>s.confirm({reviewId:revoke.reviewId,confirmation:'yes'}),/HUMAN_CONFIRMATION_REQUIRED/);
 s.confirm({reviewId:revoke.reviewId,confirmation:revoke.confirmationText});
 assert.ok((await s.status()).authority.grants?.every(g=>g.revoked_at));
 assert.throws(()=>s.confirm({reviewId:revoke.reviewId,confirmation:revoke.confirmationText}),/REVIEW_NOT_FOUND/);
});
test('Human intent revision keeps exact parent and refuses a stale review without replay',async()=>{
 const s=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-ui-intent-')));s.bootstrap();const {humanId}=await s.createHuman({label:'Human'});
 const initial=await s.intent({humanId,body:'Original goal',submit:false}) as {intentId:string;intentRevisionId:string};
 const input={humanId,intentId:initial.intentId,parentRevisionId:initial.intentRevisionId,content:'  Revised literal goal\n'};
 const first=s.revise(input),stale=s.revise(input);s.confirm({reviewId:first.reviewId,confirmation:first.confirmationText});
 assert.throws(()=>s.confirm({reviewId:stale.reviewId,confirmation:stale.confirmationText}),/Obsolete Intent revision requires Human clarification/);
 const db=s.db();try{assert.equal(db.prepare('SELECT count(*) n FROM tasks').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM intent_revisions').get()!.n,2);assert.equal(db.prepare('SELECT content FROM intent_revisions WHERE parent_revision_id=?').get(initial.intentRevisionId)!.content,input.content);}finally{db.close();}
});
test('installed Host declaration pins canonical adapter identity without login, Presence or replacement',async()=>{
 const s=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-ui-host-')));s.bootstrap();
 const input={label:'Grok',hostKind:'grok-build-acp',locatorRef:'grok://exact',workspace:'D:/isolated/work',executable:process.execPath,home:'D:/isolated/home'};
 await s.addExecutableHost(input);assert.equal(s.spec().nodes[0].hytheId,'grok-build');
 await assert.rejects(s.addExecutableHost(input),/HOST_REPLACEMENT_REQUIRES_NODE_HANDOFF/);
 const db=s.db();try{for(const table of ['model_bindings','frontend_presence_observations','grants','sessions'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get()!.n,0);}finally{db.close();}
});

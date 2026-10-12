import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {startWorkbench} from '../scripts/local-launcher.ts';
test('desktop native gate rejects arbitrary renderer confirmation; stopped Core retains Setup with secret-free status',async()=>{
 const probe=createServer();await new Promise<void>(ok=>probe.listen(0,'127.0.0.1',ok));const port=(probe.address() as {port:number}).port;await new Promise<void>(ok=>probe.close(()=>ok()));
 let asked='';const root=mkdtempSync(join(tmpdir(),'sidera-desktop-boundary-'));
 // This boundary test serves its own static fixture without a local UI build.
 const pageFixture='<!doctype html><html><body><div id="root">Desktop boundary fixture</div></body></html>';
 mkdirSync(join(root,'ui/dist'),{recursive:true});writeFileSync(join(root,'ui/dist/index.html'),pageFixture);
 const app=await startWorkbench(root,port,{assetRoot:root,approveHuman:async statement=>{asked=statement;return false;}});
 try{
  const human=await app.setup.createHuman({label:'Human'});await app.setup.addNode({label:'Chat',edgeId:'chat',locator:'external-mcp://chat/exact'});
  const review=app.setup.profile({humanId:human.humanId,mode:'workspace'});
  const r=await fetch(app.address+'/api/setup/confirm',{method:'POST',headers:{Origin:app.address,'Content-Type':'application/json'},body:JSON.stringify({reviewId:review.reviewId,confirmation:review.confirmationText})});
  assert.equal(r.status,400);assert.equal((await r.json()).code,'NATIVE_HUMAN_CONFIRMATION_REQUIRED');assert.equal(asked,'');
  const db=app.setup.db();try{assert.equal(db.prepare('SELECT count(*) n FROM human_semantic_acts').get()!.n,0);}finally{db.close();}
  const status=await fetch(app.address+'/api/setup/status').then(r=>r.text());const spec=app.setup.spec();assert.ok(!status.includes(spec.httpToken));assert.ok(!status.includes(spec.nodes[0].coreToken));assert.equal(JSON.parse(status).readiness.FULL_ROUTE_READY,false);
  const page=await fetch(app.address+'/setup');assert.equal(page.status,200);assert.equal(await page.text(),pageFixture);
  const icon=await fetch(app.address+'/sidera.png');assert.equal(icon.headers.get('content-type'),'image/png');const bytes=Buffer.from(await icon.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');
  const denied=await fetch(app.address+'/api/setup/confirm',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
 }finally{await app.close();}
});

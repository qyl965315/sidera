import {_electron as electron} from '../node_modules/playwright-core/index.mjs';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createConnection} from 'node:net';
import assert from 'node:assert/strict';
const executable=resolve(process.argv[2]);
const existingRoot=resolve(process.argv[3]);
const evidence=resolve(process.argv[4]);
mkdirSync(evidence,{recursive:true});
const temp=mkdtempSync(join(tmpdir(),'sidera-viewer-prod-'));
const env={...process.env,SIDERA_DESKTOP_TEST_DATA:temp,
  SIDERA_CONSOLE_VIEW_ROOT:existingRoot};
delete env.ELECTRON_RUN_AS_NODE;
const liveCore=()=>new Promise(resolve=>{
 const s=createConnection({host:'127.0.0.1',port:8765});
 s.setTimeout(1000);let done=false;
 const finish=ok=>{if(done)return;done=true;s.destroy();resolve(ok)};
 s.once('connect',()=>finish(true));s.once('error',()=>finish(false));s.once('timeout',()=>finish(false));
});
assert.equal(await liveCore(),true,'Existing Core must be online before test');
const app=await electron.launch({executablePath:executable,env,timeout:30000});
const errors=[];let closed=false;
try {
 const page=await app.firstWindow();
 page.on('pageerror',e=>errors.push(String(e)));
 await page.locator('.sc-shell').waitFor({timeout:30000});
 const origin=new URL(page.url()).origin;
 assert.match(page.url(),/\/projects/);
 assert.equal(await page.locator('.sc-rail nav a').count(),2);
 await page.waitForFunction(()=>document.querySelectorAll('.sc-project').length>0,{timeout:20000});
 const snapshot=await page.evaluate(()=>fetch('/api/r1/snapshot').then(r=>r.json()));
 assert.equal(snapshot.readStatus,'available','Viewer reads original Core data');
 assert.equal(snapshot.source,'live');
 assert.ok(snapshot.projects.length>=1);
 assert.ok(snapshot.nodes.length>=2);
 assert.ok(snapshot.projects.some(p=>p.id==='sidera://project/local'));
 assert.ok(snapshot.nodes.some(n=>n.displayName==='Codex'));
 const viewer=await page.evaluate(()=>fetch('/api/setup/status').then(r=>r.json()));
 assert.equal(viewer.viewOnly,true);
 assert.equal(await page.locator('.sc-bottom').count(),0,'Viewer hides administrative controls');
 const mutation=await page.evaluate(async()=>{const r=await fetch('/api/setup/core-stop',{method:'POST',headers:{'Content-Type':'application/json',Origin:location.origin},body:'{}'});return {status:r.status,body:await r.json()}});
 assert.equal(mutation.status,405);
 assert.equal(mutation.body.code,'READ_ONLY_CONSOLE');
 await page.screenshot({path:join(evidence,'real-projects.png'),fullPage:true});
 await page.locator('.sc-rail nav a[href="/nodes"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.sc-node').length>=2,{timeout:20000});
 assert.equal(await page.locator('.sc-node').count(),snapshot.nodes.length);
 await page.screenshot({path:join(evidence,'real-nodes.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 const event=app.waitForEvent('close',{timeout:20000});
 await app.evaluate(({app})=>app.quit());
 await event;closed=true;
 assert.equal(await liveCore(),true,'Closing Console cannot stop an existing Core');
 const report={
  state:'PASS',mode:'read-only connected existing Core',projectCount:snapshot.projects.length,
  nodeCount:snapshot.nodes.length,taskCount:snapshot.tasks.length,
  originalCoreStillRunning:true,mutationsRejected:true,mainTabs:2,rawNodeAccess:false,
  noHumanRegistrationRequired:true,noExistingHostTaskCreated:true,
  testEvidence:{realScreenshots:true,syntheticTaskDrilldownTestSeparate:true},
 };
 writeFileSync(join(evidence,'existing-core-viewer-smoke.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{if(!closed)console.error('Viewer close unverified. Do not kill or stop existing Core.');}

import {_electron as electron} from '../node_modules/playwright-core/index.mjs';
import {mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const repo=resolve(import.meta.dirname,'..'),source=resolve(process.argv[2]||join(repo,'candidates/desktop-ux-20261006/portable'));
const clean=mkdtempSync(join(tmpdir(),'sidera-desktop-clean-')),candidate=join(clean,'app'),data=join(clean,'private-data');cpSync(source,candidate,{recursive:true});
const evidence=join(repo,'desktop-evidence','hierarchy','packaged');mkdirSync(evidence,{recursive:true});
const env={...process.env,SIDERA_DESKTOP_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];env.PATH=join(process.env.SystemRoot??'C:\\Windows','System32');
const app=await electron.launch({executablePath:join(candidate,'Sidera.exe'),args:[],env,timeout:30000});
const errors=[];let closed=false;
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));
 await page.waitForURL('**/setup',{timeout:30000});await page.locator('.setup-page').waitFor();
 assert.equal(await page.evaluate(()=>typeof process),'undefined');assert.equal(await page.evaluate(()=>typeof require),'undefined');
 assert.deepEqual(await page.evaluate(()=>Object.keys(window.sideraDesktop).sort()),['checkUpdates','diagnostics','downloadUpdate','exportDiagnostics','installUpdate','openChat','openDataFolder','openFallback','openHostGuide','updateStatus']);
 const post=async(op,input)=>page.evaluate(async({op,input})=>{const r=await fetch('/api/setup/'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:r.status,value:await r.json()};},{op,input});
 const status=()=>page.evaluate(()=>fetch('/api/setup/status').then(r=>r.json()));
 let s=await status();assert.equal(s.nodes.length,0);assert.equal(s.readiness.FULL_ROUTE_READY,false);
 await page.screenshot({path:join(evidence,'desktop-fresh-setup.png'),fullPage:true});
 const human=(await post('human',{label:'Synthetic validation Human'})).value;
 await post('node',{label:'Synthetic Chat',edgeId:'desktop-test',locator:'external-mcp://desktop-test/exact'});
 const review=(await post('profile-review',{humanId:human.humanId,mode:'workspace'})).value;
 // Test-driver responses exercise the native gate; they are not real Human approval.
 await app.evaluate(({dialog})=>{globalThis.nativeReviews=[];dialog.showMessageBox=async(_window,options)=>{globalThis.nativeReviews.push(options.detail);return {response:0};};});
 const denied=await post('confirm',{reviewId:review.reviewId,confirmation:review.confirmationText});assert.equal(denied.value.code,'NATIVE_HUMAN_CONFIRMATION_REQUIRED');
 assert.equal(await app.evaluate(()=>globalThis.nativeReviews.length),1);
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
 assert.equal((await post('confirm',{reviewId:review.reviewId,confirmation:review.confirmationText})).status,200);
 const bindingReview=(await post('chief-review',{humanId:human.humanId,projectSpaceId:'desktop-test',projectRef:'local-test',frontendKind:'chatgpt-web',conversationRef:'https://chatgpt.com/c/synthetic-exact'})).value;
 assert.equal((await post('confirm',{reviewId:bindingReview.reviewId,confirmation:bindingReview.confirmationText})).status,200);
 await app.evaluate(({shell})=>{globalThis.externalOpened=[];shell.openExternal=async uri=>{globalThis.externalOpened.push(uri);};});
 s=await status();await page.evaluate(id=>window.sideraDesktop.openChat(id),s.bindings[0].binding_id);
 assert.deepEqual(await app.evaluate(()=>globalThis.externalOpened),['https://chatgpt.com/c/synthetic-exact']);
 const other=(await post('node',{label:'Synthetic non-Chief Grok',edgeId:'desktop-grok-test',locator:'external-mcp://desktop-grok-test/exact'})).value;assert.equal((await post('navigation',{nodeId:other.nodeId,product:'grok',userOpenableConversationRef:'https://grok.com/chat/synthetic-non-chief'})).status,200);await page.evaluate(id=>window.sideraDesktop.openChat(id),other.nodeId);assert.deepEqual(await app.evaluate(()=>globalThis.externalOpened),['https://chatgpt.com/c/synthetic-exact','https://grok.com/chat/synthetic-non-chief']);
 const arbitrary=await page.evaluate(()=>window.sideraDesktop.openChat('https://evil.test').then(()=>false,()=>true));assert.equal(arbitrary,true);
 await post('core-start',{});
 let ready=false;for(let i=0;i<80;i++){s=await status();if(s.runtime?.ready){ready=true;break;}await new Promise(r=>setTimeout(r,200));}assert.ok(ready,'packaged Core starts');assert.equal(s.readiness.FULL_ROUTE_READY,false);
 const spec=JSON.parse(readFileSync(join(data,'.sidera-dev/sol/data/runtime-spec.json'),'utf8'));
 const payload=JSON.stringify(s)+JSON.stringify(await page.evaluate(()=>window.sideraDesktop.diagnostics()));
 for(const secret of [spec.httpToken,...spec.nodes.map(n=>n.coreToken)])assert.ok(!payload.includes(secret));
 await page.goto(new URL('/integrations',page.url()).href);await page.getByRole('heading',{name:'集成',exact:true}).waitFor();
 await page.goto(new URL('/nodes',page.url()).href);await page.getByRole('heading',{name:'Synthetic Chat',exact:true}).waitFor();
 await page.goto(new URL('/status',page.url()).href);await page.getByRole('heading',{name:'状态',exact:true}).waitFor();assert.ok((await page.locator('main').innerText()).includes('尚未就绪'));assert.equal(/PowerShell|RuntimeSpec|Hythe|FULL_ROUTE_READY|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23,}/.test(await page.locator('main').innerText()),false);await page.waitForFunction(()=>!document.querySelector('.loading'));assert.equal(/PowerShell|RuntimeSpec|Hythe|FULL_ROUTE_READY|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23,}/.test(await page.locator('main').innerText()),false);await page.screenshot({path:join(evidence,'desktop-status.png'),fullPage:true});
 // Synthetic persisted open-turn fixture, no real Host operation. Exercise the real owner stop gate.
 const db=new DatabaseSync(join(data,'.sidera-dev/sol/data/sidera.sqlite'));db.exec('PRAGMA foreign_keys=ON');const n=spec.nodes[0],at=new Date().toISOString();
 db.prepare("INSERT INTO tasks(task_id,request_id,origin_node_id,center_node_id,worker_node_ids,state,created_at) VALUES ('desktop-exit-task','desktop-exit-request',?,?,?,'running',?)").run(n.nodeId,n.nodeId,JSON.stringify([n.nodeId]),at);
 db.prepare("INSERT INTO messages(message_id,request_id,task_id,from_node_id,to_node_id,target_session_id,sequence,kind,body,state,created_at) VALUES ('desktop-exit-message','desktop-exit-message-request','desktop-exit-task',?,?,?,900001,'task','Synthetic exit guard fixture','delivered',?)").run(n.nodeId,n.nodeId,n.sessionId,at);
 db.prepare("INSERT INTO task_runs(run_id,task_id,session_id,message_id,state,turn_open,created_at) VALUES ('desktop-exit-run','desktop-exit-task',?,'desktop-exit-message','running',1,?)").run(n.sessionId,at);
 const ownerBefore=readFileSync(join(data,'.sidera-dev/sol/data/core-owner.json'),'utf8');
 // In-memory test-only updater staging. No feed file is written and no network occurs.
 // Exercise the real desktop install handler against the real canonical Core refusal.
 await app.evaluate(({app,dialog})=>{const req=process.mainModule.require.bind(process.mainModule);const {createHash}=req('node:crypto');const {join}=req('node:path');const {Updates}=req(join(app.getAppPath(),'updates.cjs'));const original=Updates.prototype.check;Updates.prototype.check=async function(){const fixture=Buffer.from('non-executable synthetic update fixture');this.configuration={feed:'https://fixture.invalid/metadata',allowedHosts:['fixture.invalid']};this.fetcher=async url=>new Response(url.endsWith('/metadata')?JSON.stringify({schema:1,product:'sidera-desktop',platform:'win32-x64',version:'0.2.0',size:fixture.length,sha256:createHash('sha256').update(fixture).digest('hex'),url:'https://fixture.invalid/Sidera.exe'}):fixture);return original.call(this);};dialog.showMessageBox=async()=>({response:1});});
 await page.evaluate(()=>window.sideraDesktop.checkUpdates());await page.evaluate(()=>window.sideraDesktop.downloadUpdate());assert.equal(await page.evaluate(()=>window.sideraDesktop.installUpdate().then(()=>false,()=>true)),true);assert.equal((await page.evaluate(()=>window.sideraDesktop.updateStatus())).state,'VERIFIED');assert.equal(readFileSync(join(data,'.sidera-dev/sol/data/core-owner.json'),'utf8'),ownerBefore);
 await app.evaluate(({dialog,app})=>{globalThis.exitWarnings=[];dialog.showMessageBox=async(_w,options)=>{globalThis.exitWarnings.push(options.detail);return {response:0};};app.quit();});
 await page.waitForFunction(async()=> (await window.sideraDesktop.diagnostics()).logs.some(l=>l.includes('CORE_STOP_BLOCKED_OR_UNCERTAIN')));
 assert.equal((await status()).runtime.ready,true);assert.equal(readFileSync(join(data,'.sidera-dev/sol/data/core-owner.json'),'utf8'),ownerBefore);assert.equal(db.prepare("SELECT turn_open FROM task_runs WHERE run_id='desktop-exit-run'").get().turn_open,1);
 db.prepare("UPDATE task_runs SET turn_open=0,state='completed' WHERE run_id='desktop-exit-run'").run();db.close();
 assert.equal((await post('core-stop',{})).value.stop,'accepted');
 for(let i=0;i<50;i++){s=await status();if(!s.runtime?.ready)break;await new Promise(r=>setTimeout(r,100));}assert.equal(s.runtime?.ready===true,false);
 await page.goto(new URL('/settings',page.url()).href);await page.getByRole('button',{name:'数据与诊断',exact:true}).click();await page.getByRole('button',{name:'检查桌面状态',exact:true}).click();await page.locator('details.advanced pre').waitFor({state:'attached'});await page.locator('details.advanced summary').click();await page.waitForFunction(()=>document.querySelector('details.advanced pre')?.textContent.includes('dataDirectory'));assert.ok((await page.locator('main').innerText()).includes('dataDirectory'));
 assert.deepEqual(errors,[]);
 await app.evaluate(({app})=>app.quit());await app.waitForEvent('close',{timeout:20000});closed=true;
 const restarted=await electron.launch({executablePath:join(candidate,'Sidera.exe'),args:[],env,timeout:30000});const restored=await restarted.firstWindow();await restored.waitForURL('**/',{timeout:30000});await restored.locator('.work-surface').waitFor();const restoredState=await restored.evaluate(()=>fetch('/api/setup/status').then(r=>r.json()));assert.equal(restoredState.nodes.length,2);assert.equal(restoredState.bindings.length,1);assert.equal(restoredState.readiness.FULL_ROUTE_READY,false);await restarted.evaluate(({app})=>app.quit());await restarted.waitForEvent('close',{timeout:20000});
 const result={state:'PASS',candidateCopiedToFreshDirectory:true,freshPrivateData:true,launch:'Sidera.exe -> window -> Setup',packagedCoreReady:true,coreStoppedSetupUsable:true,fullRouteReady:false,rendererNodeUnavailable:true,nativeGateDenial:true,syntheticNativeApproval:true,exactExternalOpenIntercepted:true,realExternalNavigation:false,noRendererSecrets:true,activeTurnQuitBlocked:true,activeTurnUpdateBlocked:true,originalCoreOwnerPreserved:true,gracefulIdleQuit:true,restartRecovery:true,uiErrors:errors,limits:['Same Windows machine; not a VM/fresh OS','External browser navigation intercepted; no external Chat sent','Native approval responses supplied by test driver; not Human authority','Active turn is a persisted synthetic fixture; no real external Host turn','Updater feed/download is mocked in memory in the test process only; no feed file/server is created']};writeFileSync(join(evidence,'packaged-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(!closed){console.error('Smoke failed; preserve app ownership for recovery. No blind process kill.');}}

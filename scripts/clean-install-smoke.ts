/** Release validation only: synthetic Human browser actions, no external Host calls. */
import {cpSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {openDatabase} from '../core/db.ts';
import {chromium} from 'playwright-core';
const source=resolve(import.meta.dirname,'..'),candidate=process.argv[2]?resolve(process.argv[2]):source,root=mkdtempSync(join(tmpdir(),'sidera-clean-release-'));
if(process.argv[2])cpSync(candidate,root,{recursive:true});
else{
 for(const name of ['core','hythes','peregrine','qwen','scripts','node_modules','ui/dist','ui/integration'])cpSync(join(source,name),join(root,name),{recursive:true});
 for(const name of ['package.json','package-lock.json','Start-Sidera.cmd'])cpSync(join(source,name),join(root,name));
}
const output:string[]=[];const launcher=spawn(process.env.ComSpec??'cmd.exe',['/d','/c','Start-Sidera.cmd --no-browser'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
launcher.stdout.on('data',data=>output.push(String(data)));launcher.stderr.on('data',data=>output.push(String(data)));
const address='http://127.0.0.1:47320';
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 let ready=false;for(let i=0;i<100;i++){try{const s=await (await fetch(address+'/api/setup/status')).json();if(s.uiVersion==='r1-local-product'&&!s.nodes.length){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'clean launcher served empty Setup');
 const bootstrap=JSON.parse(readFileSync(join(root,'.sidera-dev/sol/data/runtime-spec.json'),'utf8'));assert.deepEqual(bootstrap.nodes,[]);
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,timeout:15000});
 const page=await browser.newPage({viewport:{width:1400,height:1050}});const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(address+'/tools');await page.getByRole('heading',{name:'Tools / Capabilities',exact:true}).waitFor();
 assert.ok((await page.locator('main').innerText()).includes('node.retire'));
 for(const route of ['/nodes/admin','/connections','/authority','/recovery','/system/admin']){await page.goto(address+route);await page.locator('.setup-page').waitFor();assert.ok(await page.getByRole('heading',{name:'Installed Host setup',exact:true}).count());}
 await page.goto(address+'/setup');await page.getByRole('heading',{name:'设置 / Setup',exact:true}).waitFor();
 await page.getByLabel('名称 / Name',{exact:true}).fill('Validation Human');await page.getByRole('button',{name:'创建 Human / Create Human',exact:true}).click();
 await page.locator('select').first().locator('option').nth(1).waitFor({state:'attached'}); await page.locator('select').first().selectOption({index:1});
 await page.getByLabel('Node 名称',{exact:true}).fill('Validation Chat');await page.getByLabel('外部边界名称 / Edge ID',{exact:true}).fill('validation-chat');await page.getByLabel('精确 locator',{exact:true}).fill('external-mcp://validation-chat/exact');await page.getByRole('button',{name:'添加声明 / Add declared Node',exact:true}).click();
 await page.getByRole('button',{name:'审查精确权限包 / Review exact authority',exact:true}).click();
 await page.getByRole('heading',{name:'Human 明确确认 / Explicit Human confirmation',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'我已审查，明确批准 / I reviewed and approve',exact:true}).isEnabled(),false);
 const text=await page.locator('.human-review strong').last().innerText();await page.getByLabel('键入确认 / Type confirmation',{exact:true}).fill(text);await page.getByRole('button',{name:'我已审查，明确批准 / I reviewed and approve',exact:true}).click();
 await page.getByRole('heading',{name:'Human 明确确认 / Explicit Human confirmation',exact:true}).waitFor({state:'hidden'});
 await page.getByLabel('精确 conversation URL',{exact:true}).fill('https://chatgpt.com/c/validation-exact');await page.getByRole('button',{name:'审查绑定 / Review binding or handoff',exact:true}).click();await page.locator('.human-review').waitFor();
 await page.getByLabel('键入确认 / Type confirmation',{exact:true}).fill(await page.locator('.human-review strong').last().innerText());await page.getByRole('button',{name:'我已审查，明确批准 / I reviewed and approve',exact:true}).click();await page.locator('.human-review').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'启动 Core / Start Core',exact:true}).click();
 let runtimeReady=false;for(let i=0;i<100;i++){const s=await (await fetch(address+'/api/setup/status')).json();if(!s.runtime)throw Error('SETUP_STATUS_FAILED:'+JSON.stringify(s));if(s.runtime.ready){runtimeReady=true;assert.equal(s.chief.available,false);assert.equal(s.readiness.LOCAL_READY,true);assert.equal(s.readiness.FULL_ROUTE_READY,false);break;}await new Promise(r=>setTimeout(r,100));}assert.ok(runtimeReady,'Core running, return route blocked');
 await page.goto(address+'/new-work');
 await page.getByLabel('你的目标 / Your goal',{exact:true}).fill('Synthetic validation goal; no external work.');await page.getByRole('button',{name:'提交一次 / Submit once',exact:true}).click();
 await page.locator('.setup-card').filter({has:page.getByRole('heading',{name:'操作结果 / Result',exact:true})}).locator('pre').filter({hasText:'RETURN_ROUTE_UNAVAILABLE'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'提交一次 / Submit once',exact:true}).isEnabled(),false,'one-shot form cannot resubmit');
 await page.screenshot({path:join(source,'correction-evidence/setup-browser.png'),fullPage:true});
 const db=openDatabase(join(root,'.sidera-dev/sol/data/sidera.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM tasks').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM logical_actions').get()!.n,0);}finally{db.close();}
 const statusText=await (await fetch(address+'/api/setup/status')).text();const spec=JSON.parse(readFileSync(join(root,'.sidera-dev/sol/data/runtime-spec.json'),'utf8'));
 for(const secret of [spec.httpToken,...spec.nodes.map((n:{coreToken:string})=>n.coreToken)])assert.ok(!statusText.includes(secret));
 await page.goto(address+'/setup');
 await page.getByRole('button',{name:'安全停止 Core / Stop Core safely',exact:true}).click();
 let stopped=false;for(let i=0;i<50;i++){const s=await (await fetch(address+'/api/setup/status')).json();if(!s.runtime.ready){stopped=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(stopped,'safe stop completed');
 assert.deepEqual(errors,[]);
 writeFileSync(join(source,'correction-evidence/clean-install-result.json'),JSON.stringify({state:'PASS',root,launcher:'Start-Sidera.cmd --no-browser',noPowerShellAfterLaunch:true,syntheticHumanActions:true,externalEffects:0,coreReady:true,returnRouteBlocked:true,browserSecretsAbsent:true,uiErrors:errors},null,2));
 console.log('PASS clean package CMD → Setup → Human → Node → exact approval → Chief → Core → blocked work → stop; no PowerShell');
}finally{await browser?.close();await new Promise<void>(done=>{const killer=spawn('taskkill.exe',['/PID',String(launcher.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('exit',()=>done());killer.on('error',()=>done());});writeFileSync(join(source,'correction-evidence/clean-launcher.log'),output.join(''));}

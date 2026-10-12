import {_electron as electron} from '../node_modules/playwright-core/index.mjs';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const repo=resolve(import.meta.dirname,'..');
const candidate=resolve(process.argv[2]||join(repo,'candidates/r1-desktop'));
const data=mkdtempSync(join(tmpdir(),'sidera-console-fresh-user-'));
const evidence=resolve(process.argv[3]||join(repo,'desktop-evidence/console-product'));
mkdirSync(evidence,{recursive:true});
const env={...process.env,SIDERA_DESKTOP_TEST_DATA:data};
delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:join(candidate,'Sidera.exe'),env,timeout:30000});
let closed=false,errors=[];
try{
 const page=await app.firstWindow();
 page.on('pageerror',e=>errors.push(String(e)));
 await page.locator('.sc-shell').waitFor({timeout:25000});
 assert.equal(await page.locator('.sc-rail nav a').count(),2,'Console must expose exactly two primary tabs');
 assert.equal(await page.locator('.work-composer').count(),0);
 assert.equal(await page.locator('.communication-composer').count(),0);
 assert.equal(await page.evaluate(()=>typeof process),'undefined','Electron renderer must not have Node');
 assert.equal(await page.evaluate(()=>typeof require),'undefined','Electron renderer must not have require');
 const live=await page.evaluate(()=>fetch('/api/r1/snapshot').then(r=>r.json()));
 assert.equal(live.source,'live');
 assert.equal(live.readStatus,'available','Fresh empty local profile should open directly with no Human identity selection');
 assert.deepEqual(live.projects,[],'No invented projects');
 assert.deepEqual(live.tasks,[],'No invented tasks');
 assert.deepEqual(live.nodes,[],'No invented nodes');
 assert.equal(await page.locator('.sc-unavailable').count(),0,'Empty is not an authentication error');
 await page.screenshot({path:join(evidence,'fresh-private-profile.png'),fullPage:true});
 const l=(zh,en)=>({'zh-CN':zh,en});
 const demo={source:'live',readStatus:'available',access:'authorized',capturedAt:new Date().toISOString(),worldId:'synthetic',
  projects:[{id:'project-demo',displayName:l('演示项目（合成）','Synthetic demonstration'),goal:l('只用于 UI 验收','Only for UI acceptance'),state:'waiting',progress:{kind:'state-only'},taskIds:['task-demo'],recent:[]}],
  tasks:[{id:'task-demo',projectId:'project-demo',displayName:l('检查 Codex 返回链','Verify Codex return route'),canonicalName:'task-demo',state:'waiting',progress:{kind:'state-only'},goal:l('必须保留已验证的 Host 回执','Require confirmed Host receipt'),next:l('等待真实执行证据','Awaiting real evidence'),groups:[{groupId:'one',step:l('节点分配','Assignment'),parallel:false,assignments:[{nodeId:'node-demo',state:'waiting',role:l('执行','Execute')}]}],outputs:[],runIds:['run-demo']}],
  nodes:[{id:'node-demo',displayName:'Codex',health:'unknown',dispatchAuthorization:'denied',modelBinding:{id:'unknown',provider:'unknown',modelId:'unknown'},sessions:[{id:'session-demo',state:'active',hostId:'unknown',hytheId:'codex',hostKind:'codex-app-server',locatorRef:'unavailable',health:{state:'unknown'}}],executors:[{executorRef:'e-demo',runtimeSessionId:'session-demo',state:'UNAVAILABLE',contextState:'usable',reason:'Exact Host has not been verified'}]}],
  runs:[{id:'run-demo',taskId:'task-demo',sequence:1,state:'uncertain',rawState:'unknown',targetSessionId:'session-demo',hostTurnEnded:false,checkpoint:l('缺少明确 Host 终态','No confirmed Host terminal state'),execution:{state:'unknown',authoritativeRunning:false},attempts:[]}],
  dependencies:[],effects:[],resources:[],events:[],connections:[],responsibilities:[]};
 await page.route('**/api/r1/snapshot',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(demo)}));
 await page.getByRole('button',{name:'刷新'}).click();
 await page.locator('.sc-task').waitFor();
 await page.locator('.sc-task').first().click();
 await page.locator('.sc-run-trigger').waitFor();
 assert.equal(await page.locator('.sc-project').count(),1);
 assert.equal(await page.locator('.sc-task').count(),1);
 assert.equal(await page.locator('.sc-run-trigger').count(),1);
 await page.locator('.sc-run-trigger').click();
 assert.equal(await page.locator('.sc-run-details').count(),1);
 await page.screenshot({path:join(evidence,'synthetic-project-task-run.png'),fullPage:true});
 await page.locator('.sc-rail nav a[href="/nodes"]').click();
 await page.locator('.sc-node').first().click();
 await page.locator('.sc-node-detail').waitFor();
 assert.equal(await page.locator('.sc-auth-banner').count(),1);
 await page.screenshot({path:join(evidence,'synthetic-nodes.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 const result={state:'PASS',artifact:'portable Sidera.exe + existing Core and Console',packagedExecutable:join(candidate,'Sidera.exe'),
  freshPrivateProfile:true,realReadState:live.readStatus,showedDemoOnRealError:false,
  consoleTabs:2,projectTaskRunClick:true,nodeExecutorTruth:true,legacyControlsHidden:true,
  syntheticScreenshots:true,realHostTasksTriggered:0,modelCalls:0,
  note:'The project/node screenshots use explicit synthetic fixture data; production observations are separately checked.'};
 writeFileSync(join(evidence,'packaged-console-smoke.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 const close=app.waitForEvent('close',{timeout:20000});
 await app.evaluate(({app})=>app.quit());
 await close;closed=true;
}finally{if(!closed)console.error('Desktop cleanup requires owner reconciliation; do not blindly kill a live Core');}

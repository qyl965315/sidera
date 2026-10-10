import {_electron as electron} from '../node_modules/playwright-core/index.mjs';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {detectInstalled} from '../core/installed-detection.ts';
const repo=resolve(import.meta.dirname,'..'),out=join(repo,'desktop-evidence/onboarding');mkdirSync(out,{recursive:true});
const detection=detectInstalled('codex-app-server');writeFileSync(join(out,'machine-detection.json'),JSON.stringify(detection,null,2));
const env={...process.env,SIDERA_DESKTOP_TEST_DATA:mkdtempSync(join(tmpdir(),'sidera-onboarding-'))};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:join(repo,'desktop/node_modules/electron/dist/electron.exe'),args:[join(repo,'desktop')],env});
try{const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.waitForURL('**/setup');const base=new URL(page.url()).origin;
await page.goto(base+'/integrations');await page.waitForFunction(()=>!document.querySelector('.loading'));await page.getByRole('button',{name:'设置服务',exact:true}).click();await page.getByRole('dialog').getByText('已安装',{exact:false}).waitFor();
const dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('button',{name:'连接 Codex',exact:true}).isEnabled(),true);
assert.equal(/locatorRef|codexHome|RuntimeSpec|Hythe|服务位置/.test(await dialog.innerText()),false);await page.screenshot({path:join(out,'codex-detected.png')});
await dialog.getByRole('button',{name:'连接 Codex',exact:true}).click();await dialog.getByText('操作已记录',{exact:true}).waitFor();
await dialog.getByText('高级设置',{exact:true}).click();await page.screenshot({path:join(out,'codex-advanced.png')});assert.ok((await dialog.innerText()).includes(detection.executable));assert.ok((await dialog.innerText()).includes('isolated-hosts'));assert.ok((await dialog.innerText()).includes('installed://'));
await page.getByRole('button',{name:'关闭',exact:true}).click();
await page.route('**/api/setup/desktop-management',r=>r.fulfill({json:{onboarding:[{adapter:'codex-app-server',configuration:'Not configured',detection:{installed:false,supported:false,signIn:'UNVERIFIED'}}],mcp:[],navigation:{}}}));
await page.goto(base+'/integrations');await page.waitForFunction(()=>!document.querySelector('.loading'));await page.getByRole('button',{name:'设置服务',exact:true}).click();await dialog.getByText('未安装',{exact:false}).waitFor();assert.equal(await dialog.getByRole('button',{name:'查看安装方式',exact:true}).isEnabled(),true);await page.screenshot({path:join(out,'codex-not-installed-simulation.png')});
assert.deepEqual(errors,[]);writeFileSync(join(out,'visual.json'),JSON.stringify({state:'PASS',detected:'Real machine detection, isolated Sidera desktop profile',advanced:'Real automatic configuration saved through UI without paths, isolated generated directories, no Host launch',missing:'Explicit intercepted read-only not-installed simulation',externalCalls:0,configured:true,errors},null,2));console.log('PASS onboarding screenshots and visible disclosure');
}finally{await app.evaluate(({app})=>app.quit());}

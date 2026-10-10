import {_electron as electron} from '../node_modules/playwright-core/index.mjs';
import {mkdtempSync,cpSync,renameSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),test=mkdtempSync(join(tmpdir(),'sidera-desktop-startup-error-')),candidate=join(test,'app');
cpSync(join(root,'candidates/Sidera-Desktop-R1-Windows-x64'),candidate,{recursive:true});renameSync(join(candidate,'resources/node.exe'),join(candidate,'resources/node-unavailable.exe'));
const env={...process.env,SIDERA_DESKTOP_TEST_DATA:join(test,'private')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:join(candidate,'Sidera.exe'),env,timeout:30000});const page=await app.firstWindow();
await page.getByText('Startup failed / unavailable. Setup could not start. No automatic retry.',{exact:true}).waitFor();assert.ok((await page.locator('body').innerText()).includes('Sidera'));
const closeEvent=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await closeEvent;
const result={state:'PASS',missingBundledNodeErrorInApp:true,startupFailureCanQuit:true,externalEffects:0};writeFileSync(join(root,'desktop-evidence/startup-error.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));

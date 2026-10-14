import {_electron as electron} from '../node_modules/playwright-core/index.mjs';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const repo=resolve(import.meta.dirname,'..');
const candidate=resolve(process.argv[2]||join(repo,'candidates/r1-desktop'));
const evidence=resolve(process.argv[3]||join(repo,'desktop-evidence/packaged-boot'));
mkdirSync(evidence,{recursive:true});
const data=mkdtempSync(join(tmpdir(),'sidera-packaged-boot-'));
const env={...process.env,SIDERA_DESKTOP_TEST_DATA:data};
delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
env.PATH=join(process.env.SystemRoot??'C:\\Windows','System32');
const app=await electron.launch({executablePath:join(candidate,'Sidera.exe'),args:[],env,timeout:30000});
try{
  const page=await app.firstWindow();
  await page.waitForURL(url=>/\/(first-use|setup)\b/.test(url.pathname),{timeout:30000});
  assert.equal(await page.evaluate(()=>typeof process),'undefined','renderer has no Node');
  assert.equal(await page.evaluate(()=>typeof require),'undefined','renderer has no require');
  const bridge=await page.evaluate(()=>Object.keys(window.sideraDesktop??{}).sort());
  await page.screenshot({path:join(evidence,'packaged-first-window.png'),fullPage:true});
  console.log(JSON.stringify({ok:true,url:page.url(),title:await page.title(),bridge,data}));
}finally{await app.close().catch(()=>{});}
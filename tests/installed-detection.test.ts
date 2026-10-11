import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectInstalled} from '../core/installed-detection.ts';
import {LocalSetup} from '../core/local-setup.ts';
test('bounded native discovery distinguishes wrapper, missing and unsupported filenames without authentication claims',()=>{
 const root=mkdtempSync(join(tmpdir(),'sidera-detection-'));
 assert.equal(detectInstalled('codex-app-server',{PATH:root}).installed,false);
 writeFileSync(join(root,'codex.cmd'),'fixture');
 assert.equal(detectInstalled('codex-app-server',{PATH:root}).wrapperOnly,true);
 writeFileSync(join(root,'powershell.exe'),'fixture');
 assert.equal(detectInstalled('codex-app-server',{PATH:root}).supported,false);
 const bin=join(root,'OpenAI','Codex','bin','fixture-1');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'codex.exe'),'fixture');
 const result=detectInstalled('codex-app-server',{LOCALAPPDATA:root,PATH:root});
 assert.equal(result.supported,true);assert.equal(result.executable,join(bin,'codex.exe'));assert.equal(result.signIn,'UNVERIFIED');
});
test('automatic setup needs no path, isolates directories and preserves unverified identity and replacement gate',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sidera-automatic-'));const old=process.env.LOCALAPPDATA,oldPath=process.env.PATH;
 try{process.env.LOCALAPPDATA=root;process.env.PATH='';const bin=join(root,'OpenAI','Codex','bin','fixture');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'codex.exe'),'fixture');
 const s=new LocalSetup(root);s.bootstrap();s.writeSpec({...s.spec(),corePort:49733,mcpPort:49734});const result=await s.addExecutableHost({automatic:true,hostKind:'codex-app-server'});
 const n=s.spec().nodes[0]!;assert.equal(n.locatorRef,`installed://${n.nodeId}/${n.sessionId}`);assert.equal(result.authenticated,false);assert.equal(result.presence,false);
 const dirs=['workspace','home','temp','codexHome'].map(k=>String(n.options[k]));assert.equal(new Set(dirs).size,4);assert.ok(dirs.every(d=>d.startsWith(join(root,'Sidera','isolated-hosts'))));assert.equal(n.options.model,'auto');
 await assert.rejects(()=>s.addExecutableHost({automatic:true,hostKind:'codex-app-server'}),/HOST_REPLACEMENT_REQUIRES_NODE_HANDOFF/);
 }finally{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;}
});

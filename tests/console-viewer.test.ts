import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {LocalSetup} from '../core/local-setup.ts';
import {startConsoleViewer} from '../scripts/console-viewer.ts';
const sha=(file:string)=>existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null;
const root=resolve(import.meta.dirname,'..');
test('a new Console opens an empty canonical local World without identity selection or invented nodes',async(t)=>{
 if(!existsSync(join(root,'ui','dist','index.html'))){t.skip('ui/dist is not built; run: npm --prefix ui ci and npm --prefix ui run build');return;}
 const temp=mkdtempSync(join(tmpdir(),'sidera-console-viewer-'));
 const setup=new LocalSetup(temp);setup.bootstrap();
 const db=join(temp,'.sidera-dev','sol','data','sidera.sqlite');
 const files=[db,db+'-wal',db+'-shm'];
 const before=files.map(sha);
 const viewer=await startConsoleViewer(temp,0,{assetRoot:root});
 try{
  const res=await fetch(viewer.address+'/api/r1/snapshot');
  assert.equal(res.status,200);
  const s=await res.json();
  assert.equal(s.source,'live');
  assert.equal(s.readStatus,'available');
  assert.deepEqual(s.projects,[]);
  assert.deepEqual(s.tasks,[]);
  assert.deepEqual(s.nodes,[]);
  const status=await fetch(viewer.address+'/api/setup/status').then(r=>r.json());
  assert.equal(status.viewOnly,true);
  assert.equal(status.runtime.ready,false);
  const mut=await fetch(viewer.address+'/api/setup/profile-review',{method:'POST',
   headers:{Origin:viewer.address,'Content-Type':'application/json'},body:'{}'});
  assert.equal(mut.status,405);
  assert.equal((await mut.json()).code,'READ_ONLY_CONSOLE');
  const foreign=await fetch(viewer.address+'/api/r1/snapshot',{headers:{Origin:'https://unknown.example'}});
  assert.equal(foreign.status,403);
  const page=await fetch(viewer.address+'/projects');
  assert.equal(page.status,200);
  assert.match(await page.text(),/root/);
 }finally{await viewer.close();}
 assert.deepEqual(files.map(sha),before,'opening/closing Console must not write SQLite or WAL');
});


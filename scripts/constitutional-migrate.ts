import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {openDatabase} from '../core/db.ts';
import {readLocalSovereignty} from '../core/sovereignty-store.ts';
import {currentOmega,readHistory,projectHistory} from '../core/history.ts';
import {hasCoreOwner} from '../hythes/core-client.ts';
import {captureBuildIdentity} from '../core/build-identity.ts';

/** Local operator migration, not a Node capability. Never reads Host credentials or dispatches work. */
const root=resolve(process.env.SIDERA_PROJECT_ROOT??process.cwd()),data=join(root,'.sidera-dev','sol','data');
const path=join(data,'sidera.sqlite'),spec=JSON.parse(readFileSync(join(data,'runtime-spec.json'),'utf8'));
if(process.argv[2]!=='--apply')throw Error('Usage: node scripts/constitutional-migrate.ts --apply (Core must be stopped)');
if(await hasCoreOwner(spec.corePort))throw Error('Stop the exact Core owner through its graceful lifecycle before migration');
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const read=new DatabaseSync(path,{readOnly:true});
const bindings=read.prepare("SELECT * FROM chief_conversations ORDER BY binding_id").all();
const counts=Object.fromEntries(['nodes','tasks','task_runs','grants','messages'].map(t=>[t,Number(read.prepare(`SELECT count(*) n FROM ${t}`).get()!.n)]));
assert.equal(Number(read.prepare("SELECT count(*) n FROM task_runs WHERE turn_open=1 OR state IN ('running','queued','waiting_dependency')").get()!.n),0,'Active work must finish before this operator migration');
const oldSubjects=read.prepare('SELECT * FROM node_subjectivity ORDER BY node_id').all();
const subjects=oldSubjects.map(row=>{
 const nodeId=String(row.node_id),segment=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(nodeId)?nodeId:'ref-'+createHash('sha256').update(nodeId).digest('hex');
 const file=join(path+'.sovereignty',segment,'current.json');
 const current=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{description:row.description,explanation:row.explanation,revision:row.revision};
 return {nodeId,digest:fingerprint([current.description,current.explanation,Number(current.revision)])};
});
read.close();
let db=openDatabase(path);
try{
 assert.deepEqual(db.prepare('SELECT * FROM chief_conversations ORDER BY binding_id').all(),bindings,'Human binding must survive exactly');
 for(const [table,n] of Object.entries(counts))assert.equal(Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),n,`${table} count changed`);
 for(const before of subjects){const after=readLocalSovereignty(db,before.nodeId);assert.equal(fingerprint([after.description,after.explanation,after.revision]),before.digest,'Private D/E migration mismatch');}
 assert.equal(Number(db.prepare("SELECT count(*) n FROM node_subjectivity WHERE description<>'' OR explanation<>''").get()!.n),0,'SQL retains private canonical content');
 const history=readHistory(db),omega=currentOmega(db);
 assert.equal(JSON.stringify(omega),JSON.stringify([...projectHistory(history).values()]),'Omega differs from canonical replay');
 assert.equal(Object.values(db.prepare('PRAGMA quick_check').get()!)[0],'ok');
 const stable=fingerprint({history,omega});db.close();db=openDatabase(path);
 assert.equal(fingerprint({history:readHistory(db),omega:currentOmega(db)}),stable,'Reopen should not append new migration Effects');
 const receipt={kind:'R1 constitutional migration',state:'PASS',observedAt:new Date().toISOString(),
  buildIdentity:captureBuildIdentity(root,path),preservedCounts:counts,bindings:bindings.map(b=>({bindingId:b.binding_id,project:b.project_space_id,communicatorNodeRef:b.chief_node_id,conversationRef:b.conversation_ref,state:b.state})),
  privateSubjectsMigrated:subjects.length,privateContentPreserved:true,sqlitePrivateContentRemoved:true,integrity:'ok',reopenIdempotent:true,historyRecords:history.length,omegaTargets:omega.length,
  externalHostCalls:0,tasksCreated:0,grantsCreated:0,browserLaunches:0,externalE2E:'NOT_RUN'};
 writeFileSync(join(data,'constitutional-migration-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
}finally{db.close();}

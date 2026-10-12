import assert from 'node:assert/strict';
import {projectWorld,liveSnapshot,rpc} from '../integration/live.mjs';
const w={readOnly:true,semantics:{source:'canonical_records'},worldId:'test',
 responsibilities:[{responsibilityId:'r',title:'Real responsibility',scope:'Scope',state:'active',updatedAt:'2026-10-05'}],
 chiefConversations:[{projectRef:'sidera://project/alpha',projectSpaceId:'alpha'}],nodes:[],supervisions:[],
 tasks:[
 {taskId:'accepted',projectRef:'sidera://project/alpha',taskSummary:'A confirmed task instruction',state:'running',executingNodeId:'n',
  workerNodeIds:[],provenance:{responsibilityId:'r'},runs:[{runId:'run',sessionId:'s',turnOpen:true,state:'running',execution:{authoritativeRunning:false,state:'host_confirmed'}}],messages:[{hostAccepted:true}]},
 {taskId:'orphan',projectRef:null,state:'completed',provenance:{},runs:[],finalResult:{taskCompleted:true,messageId:'result',deliveryState:'uncertain'}}
 ]};
const p=projectWorld(w,'2026-10-05T00:00:00Z');
assert.equal(p.tasks[0].state,'uncertain','No Host evidence = no claimed running task');
assert.equal(p.tasks[0].groups[0].parallel,false);
assert.equal(p.tasks[0].groups[0].assignments[0].state,'uncertain');
assert.deepEqual(p.projects.find(x=>x.id==='sidera://project/alpha').taskIds,['accepted']);
assert.equal(p.tasks[0].displayName['zh-CN'],'A confirmed task instruction');
assert.equal(p.tasks[1].projectId,'unassigned','Orphan Task never becomes a fabricated standalone Project');
assert.deepEqual(p.projects.find(x=>x.id==='unassigned').taskIds,['orphan']);
assert.equal(p.tasks[1].state,'completed');
assert.ok(p.tasks[1].outputs.every(o=>!o['zh-CN'].includes('resultMessageId')));
assert.equal(p.tasks[0].error,undefined);
assert.throws(()=>rpc({},'task.submit'),/READ_ONLY/);
assert.throws(()=>projectWorld({...w,readOnly:false},''),/INVALID_CANONICAL_READ/);
if(process.argv.includes('--projection-only')){
 console.log('PASS Console canonical Project/Task/Run projection boundaries (synthetic fixture)');
 process.exit(0);
}
const spec=process.env.SIDERA_RUNTIME_SPEC??'D:/Sidera-R1-v0.1.0/.sidera-dev/sol/data/runtime-spec.json';
const live=await liveSnapshot(spec,{localHuman:true});
assert.equal(live.source,'live');assert.equal(live.readStatus,'available');
assert.ok(live.projects.some(p=>p.id==='sidera://project/local'));
assert.ok(live.nodes.length>0);
assert.ok(live.health.some(h=>h.title.includes('world.inspect')));
for(const task of live.tasks)assert.ok(live.projects.some(p=>p.id===task.projectId&&p.taskIds.includes(task.id)));
console.log(JSON.stringify({result:'PASS real local Human Console read',capturedAt:live.capturedAt,
 projects:live.projects.length,tasks:live.tasks.length,nodes:live.nodes.length,truncated:live.truncated,
 health:live.health},null,2));

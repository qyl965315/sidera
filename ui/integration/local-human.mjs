/** Trusted loopback Workbench adapter: inspect *one* registered local Human's
 * World in read-only mode. No identity selector in the browser, no Node bearer
 * impersonation, no grant, no Host wake. Exact canonical IDs remain internal.
 *
 * This function MUST only be called by an already local-bound, same-origin
 * Workbench route. It is not a general public MCP endpoint.
 */
import { readFileSync,existsSync,copyFileSync,mkdtempSync,rmSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import { dirname,join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectWorld } from '../../core/inspection.ts';
import { canUseCapability } from '../../core/authority.ts';
const sha=(file)=>{const h=createHash('sha256');h.update(readFileSync(file));return h.digest('hex');};
export function readLocalHumanWorld(specPath){
 const dir=dirname(specPath);
 const source=join(dir,'sidera.sqlite');
 // Source DB is never opened by this viewer. Copy DB/WAL into an ephemeral
 // consistent snapshot; SQLite may create its own -shm only inside that temp.
 const temporary=mkdtempSync(join(tmpdir(),'sidera-console-snapshot-'));
 let db;
 try {
  const paths=[source,source+'-wal'];
  const before=paths.map(file=>existsSync(file)?sha(file):null);
  if(!before[0])throw Object.assign(Error('LOCAL_DB_NOT_FOUND'),{code:'unavailable'});
  paths.forEach((file,i)=>{if(before[i])copyFileSync(file,join(temporary,i===0?'sidera.sqlite':'sidera.sqlite-wal'));});
  const after=paths.map(file=>existsSync(file)?sha(file):null);
  if(before.some((digest,i)=>digest!==after[i]||
    digest!==null&&digest!==sha(join(temporary,i===0?'sidera.sqlite':'sidera.sqlite-wal'))))
    throw Object.assign(Error('LOCAL_SNAPSHOT_CHANGED_DURING_READ'),{code:'uncertain'});
  db=new DatabaseSync(join(temporary,'sidera.sqlite'),{readOnly:true});
  db.exec('PRAGMA query_only=ON');
  const selection=JSON.parse(readFileSync(join(dir,'setup-world.json'),'utf8'));
  const worldId=selection?.worldId;
  if(typeof worldId!=='string'||!worldId)throw Object.assign(Error('LOCAL_WORLD_NOT_BOUND'),{code:'denied'});
  const humans=db.prepare('SELECT DISTINCT human_id FROM world_humans WHERE world_id=?').all(worldId);
  if(humans.length===0){
    // First launch: an entirely empty, trusted local World is safe to show as
    // empty. This creates no Human identity, permission or mock Task.
    const count=db.prepare("SELECT count(*) n FROM world_records WHERE world_id=? AND table_name IN ('nodes','tasks','responsibilities')").get(worldId)?.n;
    if(Number(count)!==0)throw Object.assign(Error('HUMAN_REQUIRED_FOR_NONEMPTY_WORLD'),{code:'denied'});
    return {worldId,readOnly:true,emptyFreshProfile:true,responsibilities:[],tasks:[],
      supervisions:[],nodes:[],recentProgress:[],chiefConversations:[],truncated:false,
      semantics:{source:'canonical_records',hostAcceptanceIsCompletion:false,
        subjectivityIncluded:false,inspectionAuthorizesRetry:false}};
  }
  if(humans.length!==1)
    throw Object.assign(Error('LOCAL_HUMAN_SELECTION_REQUIRED'),{code:'denied'});
  const world=inspectWorld(db,{kind:'human',id:humans[0].human_id},{worldId,limit:200});
  // Human desktop-only display metadata, derived from canonical records.
  // Do not enlarge the networked Node/MCP world.inspect payload.
  const project=db.prepare('SELECT project_ref FROM task_rule_context WHERE task_id=?');
  const summary=db.prepare("SELECT body FROM messages WHERE task_id=? AND kind='task' ORDER BY created_at LIMIT 1");
  const tasks=world.tasks.map(t=>{
   const ref=project.get(t.taskId)?.project_ref;
   const first=summary.get(t.taskId)?.body;
   // This is a Human-only short preview, not a model-generated classification.
   const preview=typeof first==='string'?first.replace(/[\u0000-\u001F\u007F]+/g,' ').trim().slice(0,160):null;
   return {...t,projectRef:typeof ref==='string'?ref:null,taskSummary:preview||null};
  });
  // Availability is a separate Host/Executor question. This is only an
  // effective grant check for the existing Project→Chief role(s), read-only.
  const activeSession=db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'");
  const nodes=world.nodes.map(node=>{
   if(node.kind!=='Operator')return {...node,dispatchAuthorization:'not_applicable'};
   const allowed=(world.chiefConversations??[]).some(role=>{
    const chief=role.communicatorNodeRef;
    const session=chief?activeSession.get(chief)?.session_id:null;
    if(typeof chief!=='string'||typeof session!=='string'||typeof role.projectRef!=='string')return false;
    return canUseCapability(db,{subjectNodeId:chief,sessionId:session,
      capability:'task.dispatch',resource:'node/'+node.nodeId,
      requestId:'human-console-capability-read',projectRef:role.projectRef});
   });
   return {...node,dispatchAuthorization:allowed?'authorized':'denied'};
  });
  return {...world,tasks,nodes};
 }finally{try{db?.close();}finally{rmSync(temporary,{recursive:true,force:true});}}
}
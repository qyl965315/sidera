import assert from "node:assert/strict";
import {test} from "node:test";
import {openDatabase} from "../core/db.ts";
import {migrateOntology,readNodeOntology,communicationForm,registerNodeOntology,chiefConversationRole} from "../core/ontology.ts";
import {executorPool,selectDispatchExecutor,setExecutorContext,assignExecutor,taskExecutorAssignments,reviewExecutorPolicy,admitExecutorRuntime,isExecutorRuntimeSession} from "../core/executors.ts";
import {bindChiefConversation,handoffChiefConversation} from "./fixtures/chief.ts";
import {readHistory} from "../core/history.ts";
import {appendHistory} from "../core/history.ts";
import {DesktopManagement} from "../core/desktop-management.ts";
import {LocalSetup} from "../core/local-setup.ts";
import {SemanticStore} from "../core/semantics.ts";
import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BASIC_RULES_VERSION} from "../core/constitution.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";

function fixture(){const db=openDatabase(":memory:"),at=new Date().toISOString();
 for(const n of ['chat','worker','other']){db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(n,n,at);
  db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run(n+'-runtime',n,'mock://'+n,at);
  recordFixtureHostAvailable(db,n+'-runtime');}
 const binding=bindChiefConversation(db,{kind:'human',id:'fixture'},{projectSpaceId:'project',projectRef:'project',chiefNodeId:'chat',frontendKind:'chatgpt-web',conversationRef:'https://chatgpt.com/c/human-owned'});
 return {db,binding};}
function task(db:ReturnType<typeof openDatabase>,id:string,center='worker',workers:string[]=[]){db.prepare("INSERT INTO tasks VALUES (?,?,?, ?,?,'queued',NULL,?)").run(id,id,'chat',center,JSON.stringify(workers),new Date().toISOString());}

test('Chief migration preserves Human-owned exact binding and NodeRef; Chief is a Conversation role',()=>{
 const {db,binding}=fixture();try{
  const before=db.prepare("SELECT * FROM chief_conversations").get();migrateOntology(db);migrateOntology(db);
  assert.deepEqual(db.prepare("SELECT * FROM chief_conversations").get(),before);
  assert.equal(readNodeOntology(db,'chat').kind,'Communicator');assert.equal(db.prepare("SELECT count(*) n FROM nodes").get()!.n,3);
  assert.deepEqual(chiefConversationRole(db,'project'),{bindingId:binding.bindingId,projectRef:'project',projectSpaceId:'project',conversationRef:binding.conversationRef,communicatorNodeRef:'chat',role:'ChiefConversation'});
  const next=handoffChiefConversation(db,{kind:'human',id:'fixture'},{requestId:'handoff',expectedBindingId:binding.bindingId,frontendKind:'chatgpt-web',conversationRef:'https://chatgpt.com/c/human-selected'});
  assert.equal(chiefConversationRole(db,'project')?.conversationRef,next.conversationRef);assert.equal(db.prepare("SELECT count(*) n FROM project_chief_roles WHERE state='active'").get()!.n,1);
 }finally{db.close();}
});

test('communication semantics preserve all four participant forms on shared substrate',()=>{
 const {db}=fixture();try{registerNodeOntology(db,'other',{kind:'Communicator'});
  assert.equal(communicationForm(db,'Human','chat'),'Conversation');assert.equal(communicationForm(db,'chat','other'),'Discussion');
  assert.equal(communicationForm(db,'chat','worker'),'Thread');registerNodeOntology(db,'other',{kind:'Operator',operatorKind:'Bot'});
  assert.equal(communicationForm(db,'worker','other'),'Messaging');assert.throws(()=>communicationForm(db,'Human','worker'),{code:'conflict'});
 }finally{db.close();}
});

test('idle Executor reuse precedes new-context admission; unusable context is unavailable',()=>{
 const {db}=fixture();try{
  const selected=selectDispatchExecutor(db,{operatorNodeRef:'worker'});assert.equal(selected.state,'selected');if(selected.state!=='selected')throw Error();
  assert.equal(selected.executor.runtimeSessionId,'worker-runtime');
  db.prepare("INSERT INTO sessions VALUES ('extra','worker','mock','mock','mock://extra','standby','now')").run();
  recordFixtureHostAvailable(db,'extra');
  assert.throws(()=>admitExecutorRuntime(db,{operatorNodeRef:'worker',sessionId:'extra',reviewRef:'absent'}),/Reuse an idle/);
  setExecutorContext(db,{nodeId:'worker',sessionId:'worker-runtime'},{executorRef:selected.executor.executorRef,state:'exhausted',reason:'Context limit reached'});
  assert.equal(selectDispatchExecutor(db,{operatorNodeRef:'worker'}).state,'machine_review_required');
  assert.equal(executorPool(db,'worker').find(e=>e.runtimeSessionId==='worker-runtime')?.state,'UNAVAILABLE');
  assert.throws(()=>setExecutorContext(db,{nodeId:'other',sessionId:'other-runtime'},{executorRef:selected.executor.executorRef,state:'usable',reason:'Not owned'}),{code:'denied'});
 }finally{db.close();}
});

test('Task records multiple distinct Executor assignments under explicit scheduling policy, never new subjects',()=>{
 const {db}=fixture();try{task(db,'multi','worker',['other']);const a=executorPool(db,'worker')[0],b=executorPool(db,'other')[0];
  assignExecutor(db,{taskRef:'multi',executorRef:a.executorRef});assert.throws(()=>assignExecutor(db,{taskRef:'multi',executorRef:b.executorRef}),{code:'denied'});
  assignExecutor(db,{taskRef:'multi',executorRef:b.executorRef,allowMultiple:true});assert.equal(taskExecutorAssignments(db,'multi').length,2);
  assert.equal(selectDispatchExecutor(db,{operatorNodeRef:'worker'}).state,'machine_review_required');
  assert.equal(db.prepare("SELECT count(*) n FROM nodes").get()!.n,3);
  assert.equal(readHistory(db).filter(h=>h.source==='executor.assignment').length,2);
 }finally{db.close();}
});

test('no idle Executor requires real completed Chief review; accepted command or prose cannot authorize open',()=>{
 const {db,binding}=fixture();try{
  const selected=executorPool(db,'worker')[0];setExecutorContext(db,{nodeId:'worker',sessionId:'worker-runtime'},{executorRef:selected.executorRef,state:'corrupted',reason:'Bad context'});
  db.prepare("INSERT INTO sessions VALUES ('extra','worker','mock','mock','mock://extra','standby','now')").run();
  recordFixtureHostAvailable(db,'extra');
  const input={requestId:'review',projectRef:'project',operatorNodeRef:'worker',reviewTaskRef:'review-task',decision:'open' as const,reason:'Open one parallel context'};
  task(db,'review-task','chat');assert.throws(()=>reviewExecutorPolicy(db,{nodeId:'chat',sessionId:'chat-runtime'},input),/completed Task/);
  db.prepare("UPDATE tasks SET state='completed' WHERE task_id='review-task'").run();
  assert.throws(()=>reviewExecutorPolicy(db,{nodeId:'chat',sessionId:'chat-runtime'},input),/canonical result/);
  // Fixture models a completed canonical result, not a real Host acceptance claim.
  db.prepare("INSERT INTO messages VALUES ('review-message','review-request','review-task','chat','chat','chat-runtime',1,'task','Review','observed','turn',NULL,'now')").run();
  db.prepare("INSERT INTO task_runs VALUES ('review-run','review-task','chat-runtime','review-message','completed',0,'','now')").run();
  const marker={bindingId:binding.bindingId,conversationRef:binding.conversationRef,operatorNodeRef:'worker',decision:'open',executorRef:null,reason:input.reason};
  db.prepare("INSERT INTO messages VALUES ('review-result','result:review-run','review-task','chat','chat','chat-runtime',2,'result',?,'delivered','turn',NULL,'now')").run('SIDERA_EXECUTOR_REVIEW_V1\n'+JSON.stringify(marker));
  const review=reviewExecutorPolicy(db,{nodeId:'chat',sessionId:'chat-runtime'},input);
  const extra=admitExecutorRuntime(db,{operatorNodeRef:'worker',sessionId:'extra',reviewRef:review.reviewRef});
  assert.equal(extra.state,'IDLE');assert.equal(isExecutorRuntimeSession(db,'worker','extra'),true);
  assert.equal(isExecutorRuntimeSession(db,'other','extra'),false);
  assert.equal(selectDispatchExecutor(db,{operatorNodeRef:'worker'}).state,'selected');
  assert.equal(db.prepare("SELECT state FROM sessions WHERE session_id='extra'").get()!.state,'standby');
 }finally{db.close();}
});

test('Console reads real public History and Omega conflicts without becoming a Node or exposing private D/E',()=>{
 const setup=new LocalSetup(mkdtempSync(join(tmpdir(),'sidera-console-')));setup.bootstrap();const db=setup.db(),world=setup.world();
 const node=new SemanticStore(db,world).registerNode('Console fixture Operator');
 try{
  appendHistory(db,{kind:'Claim',source:'fixture:claim',worldRef:world,nodeRef:node,payload:{claim:'I believe X is 12'}});
  const at=new Date().toISOString(),delta={target:'fixture:X',baseRevision:null,nextValue:10,source:'fixture:interface',causalParents:[],rulesVersions:{Basic:BASIC_RULES_VERSION},effectiveAt:at,recordedAt:at};
  appendHistory(db,{kind:'Effect',source:'fixture:interface',worldRef:world,payload:{},deltaOmega:[delta]});
  appendHistory(db,{kind:'Effect',source:'fixture:interface',worldRef:world,payload:{},deltaOmega:[{...delta,nextValue:11}]});
 }finally{db.close();}
 const view=new DesktopManagement(setup).consoleProjection();assert.equal(view.kind,'Console');assert.equal(view.isNode,false);assert.equal(view.privateSovereigntyIncluded,false);
 assert.equal(view.nodes.length,1);assert.equal(view.nodes[0].kind,'Operator');assert.equal(view.conflicts.find(c=>c.target==='fixture:X')?.state,'UNRESOLVED');
 assert.equal(view.history.some(h=>h.kind==='Claim'),true);assert.equal(view.nodes[0].capabilities[0].availability,'unavailable');assert.equal(view.nodes[0].capabilities[0].freshness,'UNKNOWN');
 assert.equal('description' in view.nodes[0],false);assert.equal('explanation' in view.nodes[0],false);
});

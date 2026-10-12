/** Pure Console projection of already authorized canonical read data.
 * Project is the top-level organization: never synthesize one project per Task,
 * make a Responsibility/Session into a Project, or show a mock in production.
 */
const L=value=>({
  'zh-CN': value==null || value==='unknown' ? '未提供' : String(value),
  en: value==null || value==='unknown' ? 'Not provided' : String(value),
});
const progress={kind:'state-only'};
const states={
  completed:'completed', running:'working',active:'working',
  queued:'waiting',waiting:'waiting',waiting_dependency:'waiting',
  failed:'error',blocked:'error',cancelled:'error',expired:'error',
  uncertain:'uncertain',unknown:'uncertain',
};
const state=s=>states[String(s??'unknown').toLowerCase()]??'uncertain';
const titleForProject=ref=>{
  if(ref==='sidera://project/local')return { 'zh-CN':'本地项目','en':'Local project'};
  const part=String(ref).split('/').filter(Boolean).at(-1)??String(ref);
  const display=decodeURIComponent(part).replace(/[-_]/g,' ').slice(0,70);
  return L(display||'Project');
};
const short=value=>String(value??'').replace(/\s+/g,' ').trim().slice(0,130);
const humanSummary=(t,s,r,index)=>{
  const primary=short(t.taskSummary??'');
  if(primary && !/^Sidera message\b|^Task [0-9a-f-]{16,}/i.test(primary))return primary;
  const supervised=short(s?.goal);
  if(supervised && supervised!=='unknown')return supervised;
  const purpose=short(r?.title);
  if(purpose && purpose!=='unknown')return purpose;
  return '任务 '+String(index+1);
};
const isAuthoritativeRun=r=>r?.execution?.authoritativeRunning===true;
const readableNodeState=s=>['available','ready','active','live','idle','busy','running'].includes(String(s??'').toLowerCase())
  ? String(s).toLowerCase() : String(s??'unknown').toLowerCase()==='unavailable'?'unavailable':'unknown';
function projectState(tasks) {
  if(tasks.some(t=>t.state==='uncertain'))return 'uncertain';
  if(tasks.some(t=>t.state==='error'))return 'error';
  if(tasks.some(t=>t.state==='working'))return 'working';
  if(tasks.some(t=>t.state==='waiting'))return 'waiting';
  return tasks.length?'completed':'waiting';
}
/** Includes canonical, scoped opaque IDs for internal routing; ordinary UI uses display names. */
export function projectWorld(w,capturedAt,health=[]){
  if(w.readOnly!==true||w.semantics?.source!=='canonical_records'||
    !Array.isArray(w.tasks)||!Array.isArray(w.responsibilities)||
    !Array.isArray(w.nodes??[])||!Array.isArray(w.chiefConversations??[]))
    throw Error('INVALID_CANONICAL_READ');
  const originalTasks=w.tasks, responsibilities=new Map(w.responsibilities.map(r=>[r.responsibilityId,r]));
  const supervisions=new Map((w.supervisions??[]).map(s=>[s.supervisionId,s]));
  const projects=new Map();
  for(const role of w.chiefConversations??[]){
    const ref=role?.projectRef;
    if(typeof ref!=='string'||!ref.trim())continue;
    if(!projects.has(ref))projects.set(ref,{
      id:ref, displayName:titleForProject(ref),goal:L('项目下已记录的任务与执行结果'),
      state:'waiting',progress,taskIds:[],recent:[],role:'recorded',
    });
  }
  const tasks=originalTasks.map((t,i)=>{
    const r=responsibilities.get(t.provenance?.responsibilityId);
    const s=supervisions.get(t.supervisionId);
    const exactProject=typeof t.projectRef==='string' && t.projectRef.trim() ? t.projectRef : null;
    const projectId=exactProject??'unassigned';
    let status=state(t.state);
    if(status==='working' && !(t.runs??[]).some(isAuthoritativeRun))status='uncertain';
    const nodes=[t.executingNodeId,...(t.workerNodeIds??[])].filter(Boolean);
    const summary=humanSummary(t,s,r,i);
    const completed=Boolean(t.finalResult?.taskCompleted && status==='completed');
    const outputs=completed && t.finalResult?.body
      ? [L(String(t.finalResult.body).slice(0,2200))]
      : completed && t.finalResult?.messageId
        ? [L('有已完成的结果记录，可在运行详情中查看关联证据')]
        : [];
    return {
      id:t.taskId, projectId, displayName:L(summary), canonicalName:t.taskId,
      state:status,progress, goal:L(t.taskSummary??s?.goal??r?.scope),
      next:L(s?.nextAction??t.runs?.at(-1)?.checkpointOutcome??t.runs?.at(-1)?.execution?.state),
      groups:nodes.length?[{
        groupId:t.taskId,step:L('执行节点'),parallel:false,
        assignments:[...new Set(nodes)].map(nodeId=>({
          nodeId,state:status,role:L(nodeId===t.executingNodeId?'执行':'参与'),
        })),
      }]:[],outputs,runIds:(t.runs??[]).map(run=>run.runId),
      responsibilityId:r?.responsibilityId,
      ...(status==='uncertain'?{uncertainty:L('任务进度或执行效果尚未取得足够证据。')}:{}),
      ...(status==='error'?{error:{code:'TASK_'+String(t.state).toUpperCase(),
        category:'task-state',reason:L('需要检查原任务的失败或阻塞证据。')}}:{}),
      createdAt:t.createdAt??null,
    };
  });
  for(const t of tasks){
    if(!projects.has(t.projectId))projects.set(t.projectId,t.projectId==='unassigned'
      ? {id:'unassigned',displayName:{'zh-CN':'未归属项目','en':'Unassigned tasks'},goal:L('缺少可确认的项目关联'),
          state:'waiting',progress,taskIds:[],recent:[],role:'unassigned'}
      : {id:t.projectId,displayName:titleForProject(t.projectId),goal:L('来源于任务的项目关联'),
          state:'waiting',progress,taskIds:[],recent:[],role:'task-record'});
    projects.get(t.projectId).taskIds.push(t.id);
  }
  for(const p of projects.values())p.state=projectState(tasks.filter(t=>t.projectId===p.id));
  const nodes=(w.nodes??[]).map(n=>{
    const sessions=Array.isArray(n.sessions)?n.sessions:[];
    const active=sessions.find(s=>s.state==='active');
    const knownHealth=active?.health?.state??'unknown';
    return {
      id:n.nodeId,displayName:n.displayName,health:readableNodeState(knownHealth),
      kind:n.kind??'unknown',operatorKind:n.operatorKind??null,lifecycle:n.lifecycle??'unknown',dispatchAuthorization:n.dispatchAuthorization??'not_evaluated',
      executors:(n.executors??[]).map(e=>({
        executorRef:e.executorRef,runtimeSessionId:e.runtimeSessionId,
        state:e.state??'UNAVAILABLE',contextState:e.contextState??'unusable',
        reason:e.reason??null,hostCondition:e.hostCondition??null,
      })),
      modelBinding:{id:'unknown',provider:'unknown',modelId:'unknown'},
      sessions:sessions.map(s=>({
        id:s.sessionId,state:s.state,hostId:'unknown',hytheId:s.adapterId,
        hostKind:s.hostKind??'unknown',locatorRef:'unavailable',
        health:s.health??{state:'unknown'},
      })),
    };
  });
  const runs=originalTasks.flatMap(t=>(t.runs??[]).map((r,i)=>{
    const evidence=(t.effects??[]).filter(a=>a.messageId===r.messageId)
      .map(a=>({id:a.attemptId,knowledge:a.knowledge??'UNKNOWN',
        events:(a.evidence??[]).map(e=>({kind:e.kind,at:e.at,eventId:e.eventId}))}));
    const message=(t.messages??[]).find(m=>m.messageId===r.messageId);
    return {
      id:r.runId,taskId:t.taskId,sequence:i+1,state:state(r.state),
      rawState:r.state,targetSessionId:r.sessionId,hostTurnEnded:!r.turnOpen,
      checkpoint:L(r.checkpointOutcome),createdAt:r.createdAt??null,
      execution:r.execution??null,attempts:evidence,
      messageState:message?.state??'UNKNOWN',
    };
  }));
  return {
    source:'live',capturedAt,access:'authorized',readStatus:'available',
    worldId:w.worldId,truncated:!!w.truncated,health,
    projects:[...projects.values()],tasks,nodes,runs,
    dependencies:originalTasks.flatMap(t=>(t.dependencies??[]).map(d=>({
      id:d.parentRunId+':'+d.childTaskId,...d,
    }))),
    effects:[],resources:[],
    events:(w.recentProgress??[]).map(e=>({
      id:e.eventId,title:L(e.kind+' · '+e.createdAt),attests:[],
    })),
    connections:[],responsibilities:w.responsibilities.map(r=>({
      id:r.responsibilityId,state:r.state,
      deferReason:r.deferredReason?L(r.deferredReason):undefined,
    })),
  };
}
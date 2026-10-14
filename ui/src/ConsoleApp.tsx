import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {Activity,AlertCircle,ArrowRight,BookOpen,CheckCircle2,ChevronDown,ChevronRight,
  CircleHelp,Clock3,Cpu,ExternalLink,Folder,GitBranch,Layers3,MoreHorizontal,
  Network,Radio,RefreshCw,Server,ShieldAlert,Workflow} from 'lucide-react';
import {backendAdapter} from './data/backendAdapter';
import type {SystemSnapshot,TaskView,ProjectView,NodeView,RunView} from './contracts';
import LocalExecute from './LocalExecute';
import './console.css';

type Loc={'zh-CN':string;en:string};
type XNode=NodeView & {kind?:string;operatorKind?:string|null;lifecycle?:string;dispatchAuthorization?:'authorized'|'denied'|'not_evaluated'|'not_applicable';executors?:Array<{executorRef:string;runtimeSessionId:string;state:string;contextState:string;reason?:string|null;hostCondition?:{state:string;reason?:string}|null}>;sessions:Array<NodeView['sessions'][number] & {hostKind?:string}>};
type XRun=RunView & {createdAt?:string|null;messageState?:string;execution?:{state:string;authoritativeRunning?:boolean}|null;attempts?:Array<{id:string;knowledge:string;events:Array<{kind:string;at:string;eventId:string}>}>};
type XTask=TaskView & {createdAt?:string|null};
type RuntimeRead={runtime?:{ready?:boolean;state?:string};gateway?:{state?:string};viewOnly?:boolean};
const segment=(id:string)=>encodeURIComponent(id);
const restore=(id:string|undefined)=>{try{return decodeURIComponent(id||'')}catch{return ''}};
const statusKey=(x:unknown)=>String(x??'unknown').toLowerCase();
function useWords(){
 const [lang,setLang]=useState<'zh-CN'|'en'>(()=>localStorage.getItem('sidera.console.lang')==='en'?'en':'zh-CN');
 const translate=(zh:string,en:string)=>lang==='en'?en:zh;
 const value=(v:Loc|string|undefined|null)=>typeof v==='string'?v:(v?.[lang]??v?.['zh-CN']??'');
 const toggle=()=>setLang(x=>{const next=x==='en'?'zh-CN':'en';localStorage.setItem('sidera.console.lang',next);return next});
 return {lang,translate,value,toggle};
}
function Badge({state,lang}:{state:string;lang:'zh-CN'|'en'}){
 const code=statusKey(state);
 const labels:Record<string,[string,string]>={
  working:['执行中','Running'],running:['执行中','Running'],active:['活跃','Active'],
  available:['可用','Available'],ready:['就绪','Ready'],live:['在线','Live'],
  idle:['空闲','Idle'],busy:['忙碌','Busy'],completed:['已完成','Completed'],
  waiting:['等待中','Waiting'],queued:['排队中','Queued'],pending:['待处理','Pending'],
  uncertain:['待核验','Unverified'],unknown:['未知','Unknown'],
  error:['异常','Issue'],failed:['失败','Failed'],blocked:['受阻','Blocked'],
  unavailable:['不可用','Unavailable'],unusable:['不可用','Unavailable']};
 const good=['working','running','active','available','ready','live','idle','completed'].includes(code);
 const danger=['error','failed','blocked','unavailable','unusable'].includes(code);
 return <span className={'sc-badge '+(good?'good':danger?'danger':'pending')}><i/>{(labels[code]??labels.unknown)[lang==='en'?1:0]}</span>;
}
function Empty({icon:Icon,title,detail}:{icon:typeof Folder;title:string;detail:string}){
 return <div className="sc-empty"><Icon size={27} strokeWidth={1.4}/><h3>{title}</h3><p>{detail}</p></div>;
}
function time(s:string|null|undefined,lang:'zh-CN'|'en'){
 return s&&Number.isFinite(Date.parse(s))?new Date(s).toLocaleString(lang==='en'?'en-US':'zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
}
function projectProgress(project:ProjectView,tasks:TaskView[]){
 const own=tasks.filter(t=>t.projectId===project.id);
 return {total:own.length,done:own.filter(t=>t.state==='completed').length};
}
export default function ConsoleApp(){
 const location=useLocation(),navigate=useNavigate(),{lang,translate:t,value,toggle}=useWords();
 const mode=location.pathname.startsWith('/nodes')?'nodes':'projects';
 const [snapshot,setSnapshot]=useState<SystemSnapshot|null>(null),[runtime,setRuntime]=useState<RuntimeRead|null>(null);
 const [loading,setLoading]=useState(true),[failed,setFailed]=useState(false),[menu,setMenu]=useState(false),[openRun,setOpenRun]=useState<string|null>(null),[synced,setSynced]=useState<string|null>(null),[clock,setClock]=useState(Date.now());
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  const results=await Promise.allSettled([
   backendAdapter.readSnapshot(signal,'live'),
   fetch('/api/setup/status',{signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('STATUS_UNAVAILABLE');return await r.json() as RuntimeRead}),
  ]);
  if(signal?.aborted)return;
  if(results[0].status==='fulfilled'){const data=results[0].value;setSnapshot(data);setFailed(data.source!=='live'||data.readStatus!=='available'||data.access!=='authorized')}
  else {setSnapshot(null);setFailed(true)}
  setRuntime(results[1].status==='fulfilled'?results[1].value:null);
  setSynced(new Date().toISOString());setLoading(false);
 },[]);
 useEffect(()=>{const ctrl=new AbortController();void refresh(ctrl.signal);const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(ctrl.signal)},20000);return()=>{ctrl.abort();clearInterval(timer)}},[refresh]);
 useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),10000);return()=>clearInterval(timer)},[]);
 useEffect(()=>setOpenRun(null),[location.pathname]);
 const healthy=Boolean(snapshot&&snapshot.source==='live'&&snapshot.readStatus==='available'&&snapshot.access==='authorized'&&!failed);
 const projects=healthy?snapshot!.projects:[],tasks=healthy?snapshot!.tasks:[],runs=(healthy?snapshot!.runs:[]) as XRun[],nodes=(healthy?snapshot!.nodes:[]) as XNode[];
 const parts=location.pathname.split('/').filter(Boolean);
 const requestedProject=parts[0]==='projects'?restore(parts[1]):'';
 const requestedTask=parts[2]==='tasks'?restore(parts[3]):'';
 const requestedNode=parts[0]==='nodes'?restore(parts[1]):'';
 const project=projects.find(x=>x.id===requestedProject)??projects[0]??null;
 const task=project&&requestedTask?tasks.find(x=>x.id===requestedTask&&x.projectId===project.id)??null:null;
 const node=nodes.find(x=>x.id===requestedNode)??nodes[0]??null;
 const projectTasks=useMemo(()=>tasks.filter(x=>x.projectId===project?.id),[tasks,project?.id]);
 const taskRuns=task?runs.filter(x=>x.taskId===task.id).sort((a,b)=>a.sequence-b.sequence):[];
 const nodeTasks=useMemo(()=>tasks.filter(task=>task.groups.some(g=>g.assignments.some(a=>a.nodeId===node?.id))),[tasks,node?.id]);
 const attention=tasks.filter(x=>x.state==='uncertain'||x.state==='error').length;
 const projectHref=(id:string)=>'/projects/'+segment(id);
 const taskHref=(pid:string,id:string)=>projectHref(pid)+'/tasks/'+segment(id);
 const nodeHref=(id:string)=>'/nodes/'+segment(id);
 const nodeName=(id:string)=>nodes.find(x=>x.id===id)?.displayName??t('未命名节点','Unnamed node');
 const stale=Boolean(snapshot?.capturedAt&&clock-Date.parse(snapshot.capturedAt)>70000);
 const connected=healthy&&runtime?.runtime?.ready===true;
 return <div className="sc-shell" lang={lang}>
  <aside className="sc-rail">
   <Link to="/projects" className="sc-brand" title="Sidera Console" aria-label="Sidera Console">S<i/></Link><small className="sc-brand-caption">CONSOLE</small>
   <nav aria-label={t('主导航','Navigation')}>
    <Link to="/projects" className={'sc-nav'+(mode==='projects'?' selected':'')} aria-current={mode==='projects'?'page':undefined}><Layers3 size={21}/><span>{t('项目','Projects')}</span></Link>
    <Link to="/nodes" className={'sc-nav'+(mode==='nodes'?' selected':'')} aria-current={mode==='nodes'?'page':undefined}><Network size={21}/><span>{t('节点','Nodes')}</span></Link>
   </nav>
   {runtime?.viewOnly!==true&&<button className="sc-nav sc-bottom" type="button" onClick={()=>setMenu(v=>!v)} aria-expanded={menu}><MoreHorizontal size={21}/><span>{t('更多','More')}</span></button>}
  </aside>
  <div className="sc-body">
   <header className="sc-topbar">
    <div className="sc-brand-title"><small>SIDERA / CONSOLE</small><strong>{mode==='projects'?t('项目任务','Projects & tasks'):t('节点监控','Node monitoring')}</strong></div>
    <div className="sc-top-actions">
     {attention>0&&<span className="sc-alert"><AlertCircle size={14}/>{attention} {t('项待核验','need review')}</span>}
     <span className={'sc-core'+(connected?' connected':'')}><i/>{connected?t('核心运行中','Core running'):healthy?t('任务通道未就绪','Work not ready'):t('状态未知','Status unknown')}</span>
     <button aria-label={t('刷新','Refresh')} title={t('刷新','Refresh')} onClick={()=>{setLoading(true);void refresh()}}><RefreshCw size={16}/></button>
     <button onClick={toggle} className="sc-lang" aria-label={t('切换英文','Switch to Chinese')}>{lang==='zh-CN'?'EN':'中文'}</button>
    </div>
   </header>
   {menu&&<div className="sc-menu" role="menu">
    <small>{t('高级管理（按需使用）','Advanced management')}</small>
    <Link to="/integrations?technical=1" onClick={()=>setMenu(false)}><Server size={15}/>{t('连接或管理节点','Manage connections')}<ExternalLink size={12}/></Link>
    <Link to="/status?technical=1" onClick={()=>setMenu(false)}><Activity size={15}/>{t('高级诊断','Advanced diagnostics')}<ExternalLink size={12}/></Link>
    <Link to="/settings?technical=1" onClick={()=>setMenu(false)}><ShieldAlert size={15}/>{t('权限与系统设置','Permissions & settings')}<ExternalLink size={12}/></Link>
   </div>}
   {!healthy?<div className="sc-unavailable"><AlertCircle size={32}/><h2>{t('无法读取真实运行状态','Live status is unavailable')}</h2>
    <p>{t('不会用演示任务填充界面。请检查本机服务与读取权限。','No demo tasks will be substituted. Check the local service and read permissions.')}</p>
    <button onClick={()=>{setLoading(true);void refresh()}}><RefreshCw size={16}/>{t('重新读取','Retry')}</button>
    {loading&&<small>{t('正在连接 Core…','Connecting to Core…')}</small>}</div>:
    <>
     {stale&&<div className="sc-stale"><Clock3 size={14}/>{t('快照已超过一分钟，当前状态需要重新核实。','Snapshot is over one minute old; refresh to verify.')}</div>}
     {mode==='projects'?<main className="sc-layout sc-project-layout">
      {(runtime as any)?.viewOnly!==true&&(()=>{
        const humans=((runtime as any)?.humans??[]) as Array<{human_id?:string}>;
        const local=((runtime as any)?.nodes??[]) as Array<{hostKind?:string;nodeId?:string}>;
        const executor=local.find(n=>n.hostKind==='peregrine-local');
        const humanId=humans[0]?.human_id;
        if(!executor||!humanId||!connected)return null;
        return <LocalExecute humanId={humanId} executorNodeId={String(executor.nodeId??'')} english={lang==='en'} onExecuted={()=>void refresh()}/>;
      })()}
      <section className="sc-panel sc-projects">
       <div className="sc-panel-header"><small>01 / PROJECTS</small><h2>{t('项目','Projects')}<em>{projects.length}</em></h2></div>
       <div className="sc-scroll" aria-label={t('项目列表','Projects')}>
        {projects.length?projects.map(p=>{const f=projectProgress(p,tasks);return <Link className={'sc-project'+(p.id===project?.id?' selected':'')} key={p.id} to={projectHref(p.id)}>
         <span className="sc-project-icon"><Folder size={17}/></span><span className="sc-project-info"><strong>{value(p.displayName)}</strong>
         <small>{f.total?String(f.done)+' / '+String(f.total)+' '+t('已完成','completed'):t('尚无任务','No tasks yet')}</small></span><ChevronRight size={16}/></Link>})
         :<Empty icon={Folder} title={t('暂无项目','No projects')} detail={t('这里仅展示 Core 已登记的项目。','Only recorded projects appear here.')}/>}
       </div><div className="sc-panel-footer"><CircleHelp size={14}/>{t('来自真实的 Core 记录','Sourced from Core records')}</div>
      </section>
      <section className="sc-panel sc-tasks">
       <div className="sc-panel-header"><small>02 / TASKS</small><h2>{project?value(project.displayName):t('任务','Tasks')}<em>{projectTasks.length}</em></h2><p>{t('选择任务，查看执行记录','Select a task to inspect its runs')}</p></div>
       <div className="sc-scroll" aria-label={t('任务列表','Tasks')}>
        {projectTasks.length?projectTasks.map((x,i)=><Link key={x.id} to={taskHref(x.projectId,x.id)} className={'sc-task'+(task?.id===x.id?' selected':'')}>
         <div className="sc-task-top"><span>{String(i+1).padStart(2,'0')}</span><Badge state={x.state} lang={lang}/></div>
         <strong>{value(x.displayName)}</strong><small>{x.groups.flatMap(g=>g.assignments).map(a=>nodeName(a.nodeId)).join(' · ')||t('尚无执行者','No assigned node')}
         {(x as XTask).createdAt?' · '+time((x as XTask).createdAt,lang):''}</small>
         {['uncertain','error'].includes(x.state)&&<div className="sc-task-alert"><AlertCircle size={12}/>{t('执行证据需核验','Evidence needs review')}</div>}
        </Link>)
         :<Empty icon={Layers3} title={t('暂无任务','No tasks recorded')} detail={t('由 CC 建立的任务会出现在所属项目。本页不是任务起点。','Tasks created by CC appear here. This page is not a task launcher.')}/>}
       </div><div className="sc-panel-footer">{t('Task → Run · 不产生模型调用','Task → Run · No model call')}</div>
      </section>
      <section className="sc-panel sc-detail">
       {task?<><div className="sc-detail-header"><small>03 / TASK DETAIL</small><h1>{value(task.displayName)}</h1><Badge state={task.state} lang={lang}/></div>
        <div className="sc-scroll sc-detail-inner">
         <div className="sc-detail-block"><h3>{t('目标与进展','Goal & progress')}</h3><p>{value(task.goal)||t('暂无目标摘要','No goal summary')}</p>
          <div className="sc-next">{value(task.next)||t('等待真实进度记录','Awaiting sourced progress')}</div></div>
         <div className="sc-detail-block"><div className="sc-title-row"><h3>{t('执行节点','Assigned nodes')}</h3><span>{task.groups.flatMap(g=>g.assignments).length}</span></div>
          <div className="sc-pills">{task.groups.flatMap(g=>g.assignments).map((a,i)=><Link key={a.nodeId+':'+i} to={nodeHref(a.nodeId)}><Cpu size={14}/>{nodeName(a.nodeId)}<ArrowRight size={12}/></Link>)}
          {!task.groups.length&&<span className="sc-muted">{t('尚未分配','Not assigned')}</span>}</div></div>
         <div className="sc-detail-block"><div className="sc-title-row"><h3>{t('运行记录','Runs')}</h3><span>{taskRuns.length}</span></div>
          {taskRuns.length?<div className="sc-runs">{taskRuns.map(r=><div className="sc-run" key={r.id}>
           <button className="sc-run-trigger" onClick={()=>setOpenRun(p=>p===r.id?null:r.id)} aria-expanded={openRun===r.id}>
            <span className="sc-run-num">{String(r.sequence).padStart(2,'0')}</span><span className="sc-run-name"><strong>{t('第 '+r.sequence+' 次执行','Run '+r.sequence)}</strong>
             <small>{time(r.createdAt,lang)||t('时间未记录','Time unavailable')}</small></span>
             <Badge state={r.state} lang={lang}/><ChevronDown size={15} className={openRun===r.id?'sc-expanded':''}/>
           </button>
           {openRun===r.id&&<div className="sc-run-details">
            <div><span>{t('Host 回合','Host turn')}</span><strong>{r.hostTurnEnded?t('已结束','Ended'):t('尚未结束','Not ended')}</strong></div>
            <div><span>{t('实际执行','Actual execution')}</span><strong>{r.execution?.authoritativeRunning?t('已确认执行中','Confirmed running'):t('未证实运行','Not proven running')}</strong></div>
            <div><span>{t('消息状态','Message state')}</span><strong>{r.messageState??t('未知','Unknown')}</strong></div>
            <p>{value(r.checkpoint)||t('暂无检查点记录','No checkpoint recorded')}</p>
            {r.attempts?.length?r.attempts.map(a=><div className="sc-evidence" key={a.id}><strong>{a.knowledge}</strong><small>{a.events.map(e=>e.kind).join(' · ')||t('无来源事件','No sourced events')}</small></div>)
              :<p className="sc-muted">{t('暂无关联的效果记录','No correlated effect record')}</p>}
           </div>}
          </div>)}</div>
           :<Empty icon={Workflow} title={t('还没有 Run','No runs yet')} detail={t('任务登记不等于 Host 已执行。','Registering a task does not prove Host execution.')}/>}
         </div>
         {!!task.outputs.length&&<div className="sc-detail-block"><h3>{t('确认的成果','Confirmed outputs')}</h3>
          {task.outputs.map((o,i)=><div key={i} className="sc-output"><CheckCircle2 size={16}/><p>{value(o)}</p></div>)}</div>}
         {!!snapshot?.dependencies?.filter(d=>task.runIds.includes(d.parentRunId)).length&&<div className="sc-detail-block"><h3>{t('关联子任务','Dependencies')}</h3>
          {snapshot!.dependencies.filter(d=>task.runIds.includes(d.parentRunId)).map(d=><div className="sc-related" key={d.id}><GitBranch size={15}/>
           <span>{tasks.find(x=>x.id===d.childTaskId)?value(tasks.find(x=>x.id===d.childTaskId)!.displayName):t('关联任务','Related task')}</span><Badge state={d.state} lang={lang}/></div>)}</div>}
        </div></>:<Empty icon={BookOpen} title={t('选择任务','Select a task')} detail={t('右侧将显示目标、执行节点、Run 和真实证据。','See its goal, assigned nodes, runs and sourced evidence here.')}/>}
      </section>
     </main>:
     <main className="sc-layout sc-node-layout">
      <section className="sc-panel sc-node-list"><div className="sc-panel-header"><small>01 / NODES</small><h2>{t('节点','Nodes')}<em>{nodes.length}</em></h2></div>
       <div className="sc-scroll">{nodes.length?nodes.map(n=><Link to={nodeHref(n.id)} className={'sc-node'+(node?.id===n.id?' selected':'')} key={n.id}>
        <span className="sc-node-icon"><Cpu size={20}/></span><span className="sc-node-name"><strong>{n.displayName}</strong><small>{n.sessions[0]?.hostKind??n.sessions[0]?.hytheId??t('未知宿主','Unknown Host')}</small>{n.dispatchAuthorization==='denied'&&<small className='sc-auth-warning'>{t('尚无派发授权','No dispatch Grant')}</small>}</span><Badge state={n.health} lang={lang}/>
        </Link>):<Empty icon={Network} title={t('尚无节点','No nodes')} detail={t('在高级管理中连接已有 AI 服务。','Connect an AI service from advanced management.')}/>}</div>
       <div className="sc-panel-footer">{runtime?.viewOnly===true?t('只读观察 · 不修改运行服务','Read-only observer · Core untouched'):<Link to="/integrations?technical=1">{t('连接与管理','Manage connections')} <ExternalLink size={12}/></Link>}</div>
      </section>
      <section className="sc-panel sc-node-detail">{node?<><div className="sc-detail-header"><small>02 / NODE DETAIL</small>
       <div className="sc-node-heading"><span className="sc-node-icon"><Cpu size={25}/></span><div><h1>{node.displayName}</h1><p>{node.sessions[0]?.hostKind??t('Host 未确认','Host unverified')}</p></div></div>
       <Badge state={node.health} lang={lang}/></div>
       {node.dispatchAuthorization==='denied'&&<div className="sc-auth-banner"><AlertCircle size={16}/>
         {t('当前尚无可生效的任务派发授权；节点登记不等于可以执行。','No effective Task dispatch grant is recorded; registration does not authorize work.')}</div>}
       <div className="sc-scroll sc-detail-inner"><div className="sc-stats">
        <div><span>{t('类型','Type')}</span><strong>{node.kind??t('未知','Unknown')}</strong></div>
        <div><span>Session</span><strong>{node.sessions.length}</strong></div>
        <div><span>Executor</span><strong>{node.executors?.length??0}</strong></div>
        <div><span>{t('关联任务','Tasks')}</span><strong>{nodeTasks.length}</strong></div>
       </div>
       <div className="sc-detail-block"><div className="sc-title-row"><h3>{t('执行实例','Executors')}</h3><span>{node.executors?.length??0}</span></div>
        {node.executors?.length?node.executors.map(x=><div key={x.executorRef} className="sc-executor"><Server size={17}/><div><strong>{t('执行实例','Executor')}</strong>
         <small>{x.reason||x.hostCondition?.reason||t('暂无宿主证据','No Host evidence')}</small></div><Badge state={x.state} lang={lang}/></div>)
         :<p className="sc-muted">{t('没有已登记的执行实例','No recorded Executors')}</p>}</div>
       <div className="sc-detail-block"><div className="sc-title-row"><h3>{t('相关任务','Associated tasks')}</h3><span>{nodeTasks.length}</span></div>
        {nodeTasks.length?nodeTasks.map(x=><Link className="sc-related" to={taskHref(x.projectId,x.id)} key={x.id}><span>{value(x.displayName)}</span><Badge state={x.state} lang={lang}/><ChevronRight size={15}/></Link>)
         :<p className="sc-muted">{t('目前没有关联任务','No related tasks')}</p>}</div>
       <div className="sc-detail-block"><h3>{t('Host 与会话','Host & sessions')}</h3>
        {node.sessions.map(s=><div className="sc-related" key={s.id}><span>{s.hostKind??s.hytheId} · {s.state}</span><Badge state={s.health?.state??'unknown'} lang={lang}/></div>)}
        <p className="sc-muted">{t('注册不等于在线，状态来自真实证据。','Registration does not prove Presence.')}</p></div>
       </div></>:<Empty icon={Network} title={t('选择节点','Select a node')} detail={t('查看工作、执行实例和 Host 状态。','Inspect work, Executors and Host state.')}/>}</section>
     </main>}
    </>}
   <footer className="sc-footer"><span><Radio size={13}/>{healthy?t('只读 · 真实记录','Read-only · Sourced data'):t('状态未确认','Status unverified')}{snapshot?.truncated?' · '+t('已截断','Truncated'):''}</span>
    <span>{synced?t('最近读取 ','Last read ')+time(synced,lang):t('正在连接…','Connecting…')}</span></footer>
  </div>
 </div>;
}
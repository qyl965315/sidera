import {useState} from 'react';
type Projection={kind:'Console';isNode:false;nodes:Record<string,any>[];chiefConversations:Record<string,any>[];
 history:Record<string,any>[];omega:Record<string,any>[];conflicts:Record<string,any>[];grants:Record<string,any>[];responsibility:Record<string,any>[];rules?:Record<string,any>[];ruleProposals?:Record<string,any>[]};
/** Public Boundaries projection only. This component has no subject identity or D/E API. */
export default function ConsolePanel({data,english,onReviewRule,busy=false}:{data?:Projection;english:boolean;onReviewRule?:(proposalId:string,reviewTaskIds?:string[])=>void;busy?:boolean}){
 const [tab,setTab]=useState('nodes'),c=(zh:string,en:string)=>english?en:zh;
 const choices=[['nodes',c('主体与主对话','Nodes and Chief Conversations')],['history',c('共享历史','Shared History')],
  ['omega',c('当前状态 Ω','Current state Ω')],['conflicts',c('状态冲突','State conflicts')],['rules',c('规则与审阅','Rules and review')],['grants',c('权限记录','Grants')],['responsibility',c('责任来源','Responsibility provenance')]];
 return <section className="section" aria-label="Console" data-sidera-console="Boundaries"><h2>{c('控制台','Console')}</h2>
  <p>{c('这里是 Human 管理边界的界面，不是一个节点。主体的描述与解释保存在各自的私有区域。','This is the Human interface to Boundaries, not a Node. Each subject keeps its Description and Explanation private.')}</p>
  {!data?<p>{c('未取得控制台投影；状态未知。','Console projection unavailable; state is unknown.')}</p>:<>
   <nav className="tabs" aria-label={c('控制台视图','Console views')}>{choices.map(([key,label])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}>{label}</button>)}</nav>
   {tab==='nodes'?<><p>{c('主对话属于 Communicator；Executor 属于 Operator。','Chief Conversations belong to Communicators; Executors belong to Operators.')}</p>
    {data.nodes.map(n=><article key={n.nodeRef}><h3>{n.displayName}</h3><p>{n.kind}{n.operatorKind?' / '+n.operatorKind:''} · {n.lifecycle}</p>
     {n.executors?.map((e:any)=><p key={e.executorRef}>Executor · {e.state}{e.reason?' · '+e.reason:''}</p>)}
     {n.capabilities?.map((cap:any)=><p key={cap.operation}>{cap.operation} · {cap.availability} · {cap.freshness}</p>)}</article>)}
    <details><summary>{c('精确主对话绑定','Exact Chief Conversation bindings')}</summary><pre>{JSON.stringify(data.chiefConversations,null,2)}</pre></details></>:
    tab==='rules'?<><p>{c('谁审阅、是否必须独立、是否需要 Human，由适用的上级规则版本决定；在尚无已采纳规则时使用版本化的 R1 bootstrap 治理策略（该策略下 World 由 Human 采纳，Project 需完成机器审阅并由 Human 确认精确版本，Task 由 Chief Conversation 审阅）。','Who reviews, whether reviewers must be independent and whether a Human is involved come from the applicable adopted parent Rule. Until one exists, the versioned R1 bootstrap governance policy applies (Human adopts World Rules; Project Rules need a completed machine review plus exact Human confirmation; Task Rules use Chief Conversation review).')}</p>
     {(data.ruleProposals??[]).map(p=><article key={p.proposalId}><h3>{p.object.level} · {p.object.scopeRef}</h3><details><summary>{c('精确提案与审阅来源','Exact proposal and review provenance')}</summary><pre>{JSON.stringify(p,null,2)}</pre></details>
      <RuleAdoptionControls proposal={p} english={english} busy={busy} onReviewRule={onReviewRule}/>
     </article>)}<details><summary>{c('已采纳的规则版本','Adopted Rules versions')}</summary><pre>{JSON.stringify(data.rules??[],null,2)}</pre></details></>:
    <><p>{c('记录数量：','Records: ')}{(data as any)[tab]?.length??0}</p><details open={tab==='conflicts'}><summary>{choices.find(x=>x[0]===tab)?.[1]}</summary><pre>{JSON.stringify((data as any)[tab]??[],null,2)}</pre></details></>}
   </>}
 </section>;
}

function RuleAdoptionControls({proposal:p,english,busy,onReviewRule}:{proposal:Record<string,any>;english:boolean;busy:boolean;onReviewRule?:(id:string,reviewTaskIds?:string[])=>void}){
 const [selected,setSelected]=useState<string[]>([]),c=(zh:string,en:string)=>english?en:zh,policy=p.reviewPolicy;
 if(!policy)return <p>{c('适用的审阅策略未知。','Applicable review policy is unknown.')}</p>;
 if(policy.humanInvolvement==='none')return <p>{c('适用策略由提案发起主体完成采纳，无 Human 采纳步骤。','The applicable policy assigns adoption to the proposing subject without a Human adoption step.')}</p>;
 const count=policy.reviewerCount,eligible=(p.reviews??[]).filter((r:any)=>r.state==='completed'&&
   (policy.reviewerSelection!=='AuthorizedOperator'||r.reviewerKind==='Operator')&&
   (!(policy.independentRequired||!policy.allowSelfReview)||r.reviewer_node_id!==p.proposerNodeId));
 const picked=eligible.filter((r:any)=>selected.includes(r.task_id)),subjects=new Set(picked.map((r:any)=>r.reviewer_node_id));
 const valid=count===0||(picked.length>=count&&subjects.size===picked.length);
 return <><p>{c('Human 参与：','Human involvement: ')}{policy.humanInvolvement} · {c('机器审阅主体至少：','Minimum machine reviewer subjects: ')}{count}</p>
  {count>0&&eligible.map((r:any)=><label key={r.task_id}><input type="checkbox" disabled={busy} checked={selected.includes(r.task_id)}
   onChange={e=>setSelected(old=>e.target.checked?[...old,r.task_id]:old.filter(id=>id!==r.task_id))}/>{r.reviewer_node_id} · {r.task_id}</label>)}
  {count>0&&!valid&&<p>{c('请选择足够数量、来自不同主体的已完成审阅；最终确认会复核精确对象和结果。','Select enough completed reviews from distinct subjects; final confirmation verifies their exact object and result.')}</p>}
  <button disabled={busy||!onReviewRule||!valid} onClick={()=>onReviewRule?.(p.proposalId,count>0?picked.map((r:any)=>r.task_id):undefined)}>{c('核对并审阅此精确版本','Check and review this exact version')}</button>
 </>;
}

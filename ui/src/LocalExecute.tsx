import {useState} from 'react';

/** One bounded, Human-confirmed local execution. This is the product entry to
 * the built-in executor: it sends a literal instruction to the workbench API,
 * which records the Human intent and dispatches through canonical Core gates.
 * It is deliberately small: one simple-named text artifact per confirmed act. */
export default function LocalExecute({humanId,executorNodeId,english,onExecuted}:{
  humanId:string;executorNodeId:string;english:boolean;onExecuted?:()=>void;
}){
 const c=(zh:string,en:string)=>english?en:zh;
 const [fileName,setFileName]=useState('SIDERA_LOCAL_TASK.txt');
 const [content,setContent]=useState('Sidera built-in local executor ran this exact bounded instruction.');
 const [busy,setBusy]=useState(false),[result,setResult]=useState<Record<string,unknown>|null>(null),[error,setError]=useState<string|null>(null);
 const submit=async()=>{setBusy(true);setError(null);setResult(null);
  try{
   const response=await fetch('/api/setup/local-execute',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({humanId,fileName,content})});
   const value=await response.json() as Record<string,unknown>;
   if(!response.ok)setError(String(value?.code??response.status));
   else {setResult(value);onExecuted?.();}
  }catch{setError(c('本机执行入口不可用（只读观察模式）','Local execution endpoint unavailable (read-only viewer mode)'));}
  finally{setBusy(false)};
 };
 const state=typeof result?.state==='string'?result.state:null;
 return <section className="sc-panel" style={{gridColumn:'1 / -1'}} data-sidera-local-execute="bounded"
   aria-label={c('本机执行','Local execution')}>
  <div className="sc-panel-header"><small>LOCAL EXECUTOR</small>
   <h2>{c('在本机执行一个真实小任务','Run one real bounded task on this computer')}</h2>
   <p>{c('写入一个简单命名的文本文件作为可核验成果；不依赖外部账户或任何私有桥。仅在 Human 原生确认后执行。',
     'Writes one simple-named text artifact as verifiable evidence; no external account and no private bridge. Runs only after native Human confirmation.')}</p></div>
  <div style={{display:'flex',gap:'0.75rem',flexWrap:'wrap',alignItems:'flex-end'}}>
   <label style={{display:'flex',flexDirection:'column',gap:'0.25rem'}}>{c('文件名','File name')}
    <input value={fileName} onChange={event=>setFileName(event.target.value)} maxLength={100} disabled={busy}/></label>
   <label style={{display:'flex',flexDirection:'column',gap:'0.25rem',flex:1,minWidth:'16rem'}}>{c('内容','Content')}
    <textarea value={content} onChange={event=>setContent(event.target.value)} maxLength={200000} rows={2} disabled={busy}/></label>
   <button type="button" disabled={busy||!fileName.trim()||!content} onClick={()=>void submit()}>
    {busy?c('执行中…','Running…'):c('在本机执行','Run on this computer')}</button>
  </div>
  {executorNodeId&&<p className="sc-muted">{c('执行节点','Executor node')}: {executorNodeId}</p>}
  {error&&<p role="alert">{c('未执行或未确认','Not executed or not confirmed')}: {error}</p>}
  {state&&<p role="status" data-local-execute-state={state}>{c('派发状态','Dispatch state')}: {state}{result?.requestId?` · requestId ${String(result.requestId)}`:''}</p>}
  {result&&<details><summary>{c('派发回执','Dispatch receipt')}</summary><pre>{JSON.stringify(result,null,2)}</pre></details>}
 </section>;
}
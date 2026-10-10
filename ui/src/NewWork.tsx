import {useEffect,useState,useRef} from 'react';
import {Link} from 'react-router-dom';
export default function NewWork(){
 const [status,setStatus]=useState<any>(),[human,setHuman]=useState(''),[body,setBody]=useState(''),[result,setResult]=useState<any>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const submitted=useRef(false);
 useEffect(()=>{fetch('/api/setup/status',{cache:'no-store'}).then(r=>r.json()).then(s=>{setStatus(s);setHuman(s.humans?.[0]?.human_id??'');}).catch(e=>setError(String(e)));},[]);
 async function send(submit:boolean){if(busy||submitted.current)return;if(submit)submitted.current=true;setBusy(true);setError('');try{
  const r=await fetch('/api/setup/intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({humanId:human,body,submit})});const value=await r.json();setResult(value);
  if(!r.ok)setError(value.code);
 }catch{setError('WORK_UNCERTAIN: inspect original records; do not resubmit.');submitted.current=true;}finally{setBusy(false);}}
 return <div className="setup-page"><div className="page-heading"><h1>新工作 / New Work</h1><p>原样保存目标，提交一次。未知结果需核对原始记录，不自动重试。</p><Link to="/">工作首页</Link> · <Link to="/setup">设置</Link></div><section className="setup-card"><p>LOCAL_READY: {String(status?.readiness?.LOCAL_READY??false)} · FULL_ROUTE_READY: {String(status?.readiness?.FULL_ROUTE_READY??false)}</p>{!status?.readiness?.LOCAL_READY&&<p>先完成本地设置并启动 Core。</p>}<label>Human<select value={human} onChange={e=>setHuman(e.target.value)}>{status?.humans?.map((h:any)=><option key={h.human_id} value={h.human_id}>{h.label}</option>)}</select></label><label>你的目标 / Your goal<textarea rows={7} value={body} onChange={e=>setBody(e.target.value)} disabled={submitted.current}/></label><div className="setup-actions"><button disabled={busy||!human||!body.trim()||submitted.current} onClick={()=>void send(false)}>保存意图 / Save intent</button><button disabled={busy||!human||!body.trim()||!status?.readiness?.LOCAL_READY||submitted.current} onClick={()=>void send(true)}>提交一次 / Submit once</button></div>{error&&<p role="alert">{error}</p>}</section>{result&&<section className="setup-card"><h2>操作结果 / Result</h2><pre>{JSON.stringify(result,null,2)}</pre></section>}</div>;
}

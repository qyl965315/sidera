import React, { useEffect, useState } from 'react';

type Status = { humans?: Array<{human_id:string;label:string}>; nodes?: Array<{nodeId:string;hostKind:string;enrollment?:{state:string}}>; authority?:{actId?:string}; bindings?: unknown[] };
type Review = { reviewId:string; exactStatement?:string; summary?:{en?:string}; };

/** A deliberately small first-use surface.  It performs no automatic login,
 * provider call, grant, Presence assertion, or retry; every privileged step
 * creates the existing server-held review and requires the native dialog. */
export default function NativeFirstUse(){
 const [status,setStatus]=useState<Status>({}),[label,setLabel]=useState(''),[modelId,setModelId]=useState(''),[locatorRef,setLocatorRef]=useState(''),[review,setReview]=useState<Review>(),[notice,setNotice]=useState('');
 const refresh=async()=>{try{const r=await fetch('/api/setup/status',{cache:'no-store'});if(!r.ok)throw Error();setStatus(await r.json());}catch{setNotice('Local status is unavailable; no action was retried.');}};
 useEffect(()=>{void refresh();},[]);
 const post=async(path:string,body:unknown)=>{const r=await fetch('/api/setup/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),value=await r.json();if(!r.ok){setNotice(String(value.code??'Operation blocked or uncertain.'));return undefined;}if(value.reviewId)setReview(value);else {setNotice(String(value.state??'Recorded.'));await refresh();}return value;};
 const approve=async()=>{if(!review||!window.sideraDesktop){setNotice('Native desktop confirmation is required; no approval was recorded.');return;}try{const result=await window.sideraDesktop.approveReview(review.reviewId);setReview(undefined);setNotice(result.ok?'Reviewed action recorded.':String(result.code??'Native approval was not given.'));await refresh();}catch{setNotice('Approval outcome is unavailable; inspect the original review before another action.');}};
 const human=status.humans?.[0]?.human_id,host=status.nodes?.find(n=>n.hostKind==='antigravity-cli-headless');
 return <section className="section" aria-label="Native first use">
   <h1>Native first use</h1><p>Use an already-owned Antigravity stream-json conversation. Configuration never proves sign-in, Presence, authority, or a model identity.</p>
   {!human&&<div><label>Human label <input value={label} onChange={e=>setLabel(e.target.value)}/></label><button disabled={!label.trim()} onClick={()=>void post('human',{label})}>Declare Human</button></div>}
   {human&&!host&&<div><label>Selected model <input value={modelId} placeholder="exact listed model ID" onChange={e=>setModelId(e.target.value)}/></label><label>Native conversation ID <input value={locatorRef} placeholder="exact stream-json conversation_id" onChange={e=>setLocatorRef(e.target.value)}/></label><button disabled={!modelId||!locatorRef} onClick={()=>void post('executable-host',{automatic:true,hostKind:'antigravity-cli-headless',modelId,locatorRef})}>Save exact native host</button></div>}
   {human&&host&&!status.authority?.actId&&<button onClick={()=>void post('profile-review',{humanId:human,mode:'workspace'})}>Review required local grant</button>}
   {human&&host&&status.authority?.actId&&!host.enrollment&&<button onClick={()=>void post('antigravity-enrollment-review',{humanId:human,nodeId:host.nodeId})}>Review native session enrollment</button>}
   {human&&host&&host.enrollment?.state==='completed'&&!status.bindings?.length&&<button onClick={()=>void post('native-chief-review',{humanId:human})}>Review local Chief Chat</button>}
   {human&&host&&host.enrollment?.state==='completed'&&(status.bindings?.length??0)>0&&<button onClick={()=>void post('core-start',{})}>Start once, then verify</button>}
   {host?.enrollment?.state==='blocked'&&<p role="alert">HOLD: native enrollment was consumed but did not verify. Inspect the recorded reason; no automatic retry is available.</p>}
   {review&&<div role="dialog"><p>{review.summary?.en??'Review this exact operation in the native desktop dialog.'}</p><pre>{review.exactStatement}</pre><button onClick={()=>void approve()}>Approve in native desktop dialog</button><button onClick={()=>setReview(undefined)}>Cancel</button></div>}
   {notice&&<p role="status">{notice}</p>}<button onClick={()=>void refresh()}>Refresh exact status</button>
 </section>;
}

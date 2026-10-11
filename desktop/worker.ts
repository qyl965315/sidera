import {startWorkbench} from '../scripts/local-launcher.ts';
import {stopLocalCore} from '../core/local-lifecycle.ts';
import {hasCoreOwner} from '../hythes/core-client.ts';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DesktopManagement} from '../core/desktop-management.ts';
import {detectInstalled} from '../core/installed-detection.ts';
const pending=new Map<string,(answer:boolean)=>void>();let serial=0;
import {browserSafe} from '../core/browser-redaction.ts';
const askNative=(statement:string):Promise<boolean>=>new Promise(resolve=>{const id=String(++serial);pending.set(id,resolve);process.send?.({type:'human-review',id,statement});setTimeout(()=>{if(pending.delete(id))resolve(false);},60000).unref();});
const app=await startWorkbench(process.env.SIDERA_PROJECT_ROOT!,Number(process.env.SIDERA_DESKTOP_PORT),{assetRoot:process.env.SIDERA_ASSET_ROOT,approveHuman:askNative});
const initial=await app.setup.status();
const native=initial.nodes.find((node:{hostKind:string})=>node.hostKind==='antigravity-cli-headless');
const nativeFirstUsePending=Boolean(native&&((native.enrollment?.state??'')!=='completed'||!initial.bindings.length));
process.send?.({type:'ready',address:app.address,setupRequired:!initial.nodes.length||!initial.humans.length||!initial.authority.actId||nativeFirstUsePending});
process.on('message',async(message:unknown)=>{
 const m=message as {type:string;id:string;approved?:boolean;bindingId?:string;key?:string;credentialRef?:string;adapter?:string;reviewId?:string};
 if(m.type==='product-location'&&['codex-app-server','dsh-harness-acp','antigravity-cli-headless'].includes(m.adapter??'')){const found=detectInstalled(m.adapter!);const configured=app.setup.spec().nodes.find(n=>n.hostKind===m.adapter);process.send?.({type:'response',id:m.id,value:{path:found.executable??found.desktop,codexHome:configured?.options.codexHome,dshHome:configured?.options.dshHome,apiCredentialNames:app.setup.spec().nodes.filter(n=>['generic-api','openai-compatible-api'].includes(n.hostKind)).map(n=>(n.options.provider as {credentialRef?:string})?.credentialRef).filter((r):r is string=>typeof r==='string'&&/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(r)).map(r=>r.slice(4))}});}
 if(m.type==='approve-review'){try{const review=app.setup.nativeReview({reviewId:m.reviewId});const value=await askNative(review.statement)?{ok:true,result:browserSafe(review.apply(),app.setup.spec())}:{ok:false,code:'NATIVE_HUMAN_CONFIRMATION_REQUIRED'};process.send?.({type:'response',id:m.id,value});}catch(error){process.send?.({type:'response',id:m.id,value:{ok:false,code:(error as {code?:string}).code??'INVALID_REVIEW'}});}}
 if(m.type==='credential'&&typeof m.key==='string'&&typeof m.credentialRef==='string'&&/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(m.credentialRef)){const name=m.credentialRef.slice(4);process.env[name]=m.key;process.env.SIDERA_API_CREDENTIAL_NAMES=[...new Set([...(process.env.SIDERA_API_CREDENTIAL_NAMES??'').split(',').filter(Boolean),name])].join(',');}
 if(m.type==='human-answer'){pending.get(m.id)?.(m.approved===true);pending.delete(m.id);}
 if(m.type==='bindings'){const status=await app.setup.status();process.send?.({type:'response',id:m.id,value:status.bindings});}
 if(m.type==='navigation'){process.send?.({type:'response',id:m.id,value:new DesktopManagement(app.setup).navigation()});}
 if(m.type==='summary'){process.send?.({type:'response',id:m.id,value:{integrations:new DesktopManagement(app.setup).onboarding().map(n=>({hostKind:n.adapter,configured:n.configuration==='Configured'}))}});}
 if(m.type==='diagnostics'){let lifecycle:string[]=[];try{lifecycle=readFileSync(join(app.setup.data,'launcher.log'),'utf8').split('\n').filter(line=>/^\d{4}-\d\d-\d\dT[\d:.Z-]+ [A-Z_]+$/.test(line)).slice(-50);}catch{}process.send?.({type:'response',id:m.id,value:{lifecycle}});}
 if(m.type==='quit'){
  try{if(await hasCoreOwner(app.setup.spec().corePort)){const result=await stopLocalCore(app.setup.root) as {stop?:string};if(result.stop!=='accepted')throw Error('CORE_STOP_BLOCKED');}
   const deadline=Date.now()+8000;while(await hasCoreOwner(app.setup.spec().corePort)){if(Date.now()>deadline)throw Error('STOP_UNCERTAIN');await new Promise(r=>setTimeout(r,100));}
   await app.close();process.send?.({type:'response',id:m.id,value:{closed:true}});process.exit(0);
  }catch{process.send?.({type:'response',id:m.id,value:{closed:false,code:'CORE_STOP_BLOCKED_OR_UNCERTAIN'}});}
 }
});

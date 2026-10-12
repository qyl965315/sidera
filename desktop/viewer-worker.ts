/** One-purpose Electron child for existing-runtime observation.
 * Never launches or stops Core. No privileged Human admission handlers here.
 */
import {startConsoleViewer} from '../scripts/console-viewer.ts';
const root=process.env.SIDERA_CONSOLE_VIEW_ROOT;
const assets=process.env.SIDERA_ASSET_ROOT;
const port=Number(process.env.SIDERA_DESKTOP_PORT??0);
if(!root||!assets||!Number.isInteger(port)||port<=0)throw Error('CONSOLE_VIEWER_CONFIG_REQUIRED');
const viewer=await startConsoleViewer(root,port,{assetRoot:assets});
process.send?.({type:'ready',address:viewer.address,setupRequired:false});
let closing=false;
process.on('message',async(msg:unknown)=>{
 const m=msg as {type?:string;id?:string};
 if(m.type==='quit'){
  if(closing)return;
  closing=true;
  try{
   await viewer.close();
   process.send?.({type:'response',id:m.id,value:{closed:true,coreStopped:false,readOnly:true}});
   setTimeout(()=>process.exit(0),20).unref();
  }catch{
   closing=false;
   process.send?.({type:'response',id:m.id,value:{closed:false,code:'VIEWER_STOP_UNCERTAIN'}});
  }
  return;
 }
 if(m.type==='diagnostics')process.send?.({type:'response',id:m.id,value:{lifecycle:['VIEWER_READ_ONLY'],readOnly:true}});
 else if(m.type==='summary')process.send?.({type:'response',id:m.id,value:{integrations:[]}});
 else if(m.type==='navigation')process.send?.({type:'response',id:m.id,value:{}});
 else if(m.type==='bindings')process.send?.({type:'response',id:m.id,value:[]});
 else if(m.id)process.send?.({type:'response',id:m.id,value:{ok:false,code:'READ_ONLY_CONSOLE'}});
});

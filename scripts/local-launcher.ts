import {SimpleMcpManager} from '../core/mcp-simple.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LocalSetup, SetupError } from '../core/local-setup.ts';
import { launchCore } from '../core/launch.ts';
import { stopLocalCore } from '../core/local-lifecycle.ts';
import { hasCoreOwner } from '../hythes/core-client.ts';
import { ZodError } from 'zod';
import { browserSafe } from '../core/browser-redaction.ts';
import {DesktopManagement,normalInstalledHost} from '../core/desktop-management.ts';
// @ts-expect-error Server-only canonical projection shared with Vite.
import { liveSnapshot } from '../ui/integration/live.mjs';
const FALLBACK_PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
export function localBrowserRequest(req:IncomingMessage,port:number,mutation:boolean){
 const origin=`http://127.0.0.1:${port}`;
 if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${port}`)return false;
 if(req.headers.origin&&req.headers.origin!==origin)return false;
 if(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'&&req.headers['sec-fetch-site']!=='none')return false;
 return !mutation||(!req.headers.authorization&&req.headers.origin===origin&&req.headers['content-type']==='application/json');
}
export async function startWorkbench(root:string,port=47320,options:{assetRoot?:string;approveHuman?:(statement:string)=>Promise<boolean>}={}){
 const setup=new LocalSetup(root);setup.bootstrap();
 const management=new DesktopManagement(setup);const simpleMcp=new SimpleMcpManager(setup);
 const log=(code:string)=>appendFileSync(join(setup.data,'launcher.log'),new Date().toISOString()+' '+code+'\n');
 let child:ReturnType<typeof launchCore>|undefined,starting=false,mutationBusy=false,coreState='STOPPED';
 const start=async()=>{
  if(starting)throw new SetupError('CORE_STARTING');
  if(!setup.spec().nodes.length)return {state:'SETUP_REQUIRED',code:'ADD_NODE_REQUIRED'};
  if(child&&child.exitCode===null&&child.signalCode===null)return {state:coreState,code:'EXISTING_LAUNCHER_OWNER'};
  if(await hasCoreOwner(setup.spec().corePort))return {state:'EXISTING_LISTENER',code:'CORE_ALREADY_RUNNING',verified:false};
  starting=true;try{coreState='STARTING';log('CORE_START_REQUESTED');child=launchCore(setup.root,undefined,'ignore');
   child.once('error',()=>{coreState='START_FAILED';log('CORE_START_FAILED');});
   child.once('exit',()=>{coreState='STOPPED';log('CORE_EXITED_NO_REPLAY');});return {state:'STARTING',automaticRetry:false};
  }finally{starting=false;}
 };
 const server=createServer(async(req,res)=>{
  const path=(req.url??'/').split('?')[0]!,mutation=req.method==='POST';
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
  const json=(status:number,value:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(browserSafe(value,setup.spec())));};
  if(!localBrowserRequest(req,port,mutation))return json(403,{code:'LOCAL_SAME_ORIGIN_REQUIRED'});
  try{
   if(path==='/api/r1/snapshot'&&req.method==='GET')return json(200,await liveSnapshot(setup.specPath(),{localHuman:true}));
   if(path==='/api/communication/view'&&req.method==='GET'){
    const q=new URL(req.url??'/',`http://127.0.0.1:${port}`).searchParams;
    return json(200,await setup.conversationView({humanId:q.get('humanId'),bindingId:q.get('bindingId')}));
   }
   if(path==='/api/setup/status'&&req.method==='GET')return json(200,{...await setup.status(),launcher:{state:coreState},uiVersion:'r1-local-product'});
   if(path==='/api/setup/desktop-management'&&req.method==='GET')return json(200,{onboarding:management.onboarding(),mcp:management.inventory(),integrations:simpleMcp.list(),navigation:management.navigation(),console:management.consoleProjection()});
   if(path.startsWith('/api/')){
    if(!mutation)return json(405,{code:'METHOD_NOT_ALLOWED'});
    if(mutationBusy)return json(409,{code:'ADMIN_OPERATION_IN_PROGRESS'});
    mutationBusy=true;
    try{
     let body='';for await(const data of req){body+=data;if(Buffer.byteLength(body)>100000)throw new SetupError('INPUT_TOO_LARGE');}
     let input:unknown;try{input=JSON.parse(body);}catch{throw new SetupError('INVALID_INPUT');}
     let result:unknown;
     switch(path){
       case '/api/setup/mcp-preview':result=simpleMcp.preview(input);break;
       case '/api/setup/service-check':result=management.checkService(input);break;
       case '/api/setup/mcp-apply':result=await simpleMcp.apply(input);break;
       case '/api/setup/mcp-discover':result=simpleMcp.discovery();break;
       case '/api/setup/mcp-simple-change':result=await simpleMcp.change(input);break;
       case '/api/setup/mcp-simple-health':result=await simpleMcp.health(input);break;
       case '/api/setup/navigation':result=management.setNavigation(input);break;
      case '/api/setup/mcp-change':result=await management.change(input);break;
      case '/api/setup/mcp-health':result=await management.health(input);break;
      case '/api/setup/human':result=await setup.createHuman(input);break;
      case '/api/setup/config':result=await setup.configure(input);break;
      case '/api/setup/provision':if(options.approveHuman&&!await options.approveHuman('Provision the already admitted Human permission package: '+JSON.stringify(input)))throw new SetupError('NATIVE_HUMAN_CONFIRMATION_REQUIRED');result=setup.provision(input);break;
      case '/api/setup/node':result=await setup.addNode(input);break;
       case '/api/setup/api-host':result=await setup.addApiHost(input);break;
        case '/api/setup/local-executor':result=await setup.addLocalExecutor(input);break;
       case '/api/setup/local-execute':if(options.approveHuman&&!await options.approveHuman('Run one bounded local executor instruction as this exact Human act: '+String((input as Record<string,unknown>)?.fileName??'')))throw new SetupError('NATIVE_HUMAN_CONFIRMATION_REQUIRED');result=await setup.localExecute(input);break;
case '/api/setup/executable-host':result=await setup.addExecutableHost((input as Record<string,unknown>)?.automatic===true?input:normalInstalledHost(input));break;
       case '/api/setup/revoke-review':result=setup.revoke(input);break;
       case '/api/setup/intent-revise-review':result=setup.revise(input);break;
      case '/api/setup/route':result=await setup.configureRoute(input);break;
      case '/api/setup/native-route':result=await setup.configureNative(input);break;
      case '/api/setup/rename-review':result=setup.rename(input);break;
      case '/api/setup/profile-review':result=setup.profile(input);break;
      case '/api/setup/rules-adoption-review':result=setup.rulesAdoption(input);break;
      case '/api/setup/chief-review':result=setup.chief(input);break;
      case '/api/setup/native-chief-review':result=setup.nativeChief(input);break;
       case '/api/setup/native-session-create-review':result=setup.nativeSessionCreate(input);break;
      case '/api/setup/reconcile-review':result=setup.reconciliation(input);break;
      case '/api/setup/host-recovery-review':result=setup.hostRecovery(input);break;
      case '/api/setup/approve':
      case '/api/setup/confirm':throw new SetupError('NATIVE_HUMAN_CONFIRMATION_REQUIRED');
      case '/api/setup/intent':if(options.approveHuman&&!await options.approveHuman('Capture this literal Human intent and requested submission: '+JSON.stringify(input)))throw new SetupError('NATIVE_HUMAN_CONFIRMATION_REQUIRED');result=await setup.intent(input);break;
      case '/api/communication/send':result=await setup.conversationSend(input);break;
      case '/api/setup/core-start':if(JSON.stringify(input)!=='{}')throw new SetupError('INVALID_INPUT');result=await start();break;
      case '/api/setup/core-stop':if(JSON.stringify(input)!=='{}')throw new SetupError('INVALID_INPUT');result=await stopLocalCore(setup.root);break;
      default:return json(404,{code:'UNKNOWN_ADMIN_OPERATION'});
     }
       if(result&&typeof result==='object'&&'reviewId' in result){const {confirmationText,...view}=result as Record<string,unknown>;return json(200,view);}
       return json(200,result);
    }finally{mutationBusy=false;}
   }
   if(req.method!=='GET')return json(405,{code:'METHOD_NOT_ALLOWED'});
   const dist=join(options.assetRoot??setup.root,'ui/dist');const asset=/^\/assets\/[A-Za-z0-9._-]+$/.test(path)?join(dist,path):['/sidera.png','/favicon.png'].includes(path)?join(dist,path):join(dist,'index.html');
   if(!existsSync(asset)){if(path==='/sidera.png'){res.statusCode=200;res.setHeader('Content-Type','image/png');res.end(FALLBACK_PNG);return;}return json(503,{code:'UI_BUILD_REQUIRED'});}
   res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'} as Record<string,string>)[extname(asset)]??'application/octet-stream');res.end(readFileSync(asset));
  }catch(error){const code=error instanceof SetupError?error.code:error instanceof ZodError?'INVALID_INPUT':(error as {code?:string}).code==='conflict'?'ADMIN_CONFLICT':(error as {code?:string}).code==='denied'?'ADMIN_DENIED':'ADMIN_UNAVAILABLE_OR_UNCERTAIN';log(code);json(400,{code,automaticRetry:false,next:'Refresh status and inspect original records before any new action. No automatic retry.'});}
 });
 await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
 try{await start();}catch{log('CORE_START_UNAVAILABLE');}
 return {server,setup,address:`http://127.0.0.1:${port}`,close:()=>new Promise<void>((ok,no)=>server.close(e=>e?no(e):ok()))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const root=resolve(import.meta.dirname,'..');
 try{const app=await startWorkbench(root);console.log('Sidera local UI: '+app.address+'/setup');console.log('Stop Core in Setup before closing this window. No authority or Chat is created automatically.');
  if(!process.argv.includes('--no-browser'))spawn('explorer.exe',[app.address+'/setup'],{windowsHide:true,stdio:'ignore'}).on('error',()=>console.log('Open the printed local address in your browser.'));
 }catch(error){if((error as NodeJS.ErrnoException).code==='EADDRINUSE')console.error('UI port occupied. Verify http://127.0.0.1:47320/setup. No additional Core started.');else console.error('Launcher unavailable; inspect local configuration. No retry.');process.exitCode=1;}
}

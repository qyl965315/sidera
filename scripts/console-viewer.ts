/** Sidera Console observer for an existing authorized local Core.
 * Local loopback / read-only / no Core owner / no Node grant / no scheduler.
 * Close only this HTTP listener; never stop someone else's Core or P5.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
// @ts-expect-error Shared server-side canonical projection (typed API is checked in integration tests).
import {liveSnapshot,rpc} from '../ui/integration/live.mjs';

export function localViewerRequest(req:IncomingMessage,port:number){
 const remote=req.socket.remoteAddress;
 const host='127.0.0.1:'+port,origin='http://'+host;
 if(remote!=='127.0.0.1'||req.headers.host!==host)return false;
 if(req.headers.origin&&req.headers.origin!==origin)return false;
 if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return false;
 return true;
}
export async function startConsoleViewer(viewRoot:string,port=0,options:{assetRoot:string}){
 const root=realpathSync(resolve(viewRoot));
 const spec=join(root,'.sidera-dev','sol','data','runtime-spec.json');
 const world=join(root,'.sidera-dev','sol','data','setup-world.json');
 const database=join(root,'.sidera-dev','sol','data','sidera.sqlite');
 if(![spec,world,database].every(existsSync))throw Error('EXISTING_LOCAL_SIDERA_RUNTIME_REQUIRED');
 const dist=join(resolve(options.assetRoot),'ui','dist');
 if(!existsSync(join(dist,'index.html')))throw Error('CONSOLE_UI_BUILD_REQUIRED');
 const server=createServer(async(req,res)=>{
  const addr=server.address(),actualPort=addr&&typeof addr==='object'?addr.port:port;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
  const sendJson=(code:number,data:unknown)=>{
   res.statusCode=code;res.setHeader('Content-Type','application/json; charset=utf-8');
   res.end(JSON.stringify(data));
  };
  if(!localViewerRequest(req,actualPort))return sendJson(403,{code:'LOCAL_ORIGIN_REQUIRED'});
  if(req.method!=='GET')return sendJson(405,{code:'READ_ONLY_CONSOLE'});
  const path=(req.url??'/').split('?')[0]!;
  try {
   if(path==='/api/r1/snapshot')
    return sendJson(200,await liveSnapshot(spec,{localHuman:true}));
   if(path==='/api/setup/status'){
    // No second SQLite snapshot for the status strip. Ask existing Core directly
    // through its authenticated, read-only RPC method.
    const config=JSON.parse(readFileSync(spec,'utf8')) as {chiefNodeId:string;corePort:number;mcpPort:number;nodes:Array<{nodeId:string;coreToken?:string}>};
    const node=config.nodes.find(n=>n.nodeId===config.chiefNodeId);
    let ready=false;
    if(node?.coreToken)try{
      const status=await rpc({corePort:config.corePort,token:node.coreToken},'runtime.status');
      ready=status?.ready===true;
    }catch{/* No inference from an unavailable Core. */}
    return sendJson(200,{viewOnly:true,runtime:{ready,state:ready?'READY':'UNVERIFIED'},
     gateway:{state:'UNKNOWN'},lastObservedAt:new Date().toISOString()});
   }
   if(path.startsWith('/api/'))return sendJson(404,{code:'VIEWER_API_NOT_SUPPORTED'});
   const asset=/^\/assets\/[A-Za-z0-9._-]+\.(js|css|svg|png)$/.test(path)
    ?join(dist,path.slice(1)) : path==='/sidera.png'||path==='/favicon.png'
      ?join(dist,path.slice(1)) :join(dist,'index.html');
   if(!existsSync(asset))return sendJson(503,{code:'VIEWER_ASSET_MISSING'});
   res.statusCode=200;
   res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8',
     '.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
     '.svg':'image/svg+xml','.png':'image/png'} as Record<string,string>)[extname(asset)]??'application/octet-stream');
   res.end(readFileSync(asset));
  }catch(error){
   return sendJson(503,{code:'VIEWER_READ_UNAVAILABLE',automaticRetry:false});
  }
 });
 await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok)});
 const address=server.address();
 if(!address||typeof address==='string')throw Error('VIEWER_BIND_UNAVAILABLE');
 return {address:'http://127.0.0.1:'+address.port,
  close:()=>new Promise<void>((ok,no)=>server.close(e=>e?no(e):ok()))};
}

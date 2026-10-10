import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_TOOL_NAMES, TARGET_EDGES, writeGeneratedConfig, type GatewayWorkspaceConfig } from "./mcp-gateway.ts";
import { projectCondition, type ConditionEvidence } from "../core/condition.ts";

export function gatewayIngressDigest(config:GatewayWorkspaceConfig):string {
  return createHash("sha256").update(JSON.stringify({port:config.gatewayPort,host:config.host,
    publicBaseUrl:config.publicBaseUrl??null,edges:config.edges.map(e=>({id:e.id,boundNodeId:e.boundNodeId}))})).digest("hex");
}
type Health={healthy?:boolean;instanceId?:string;surface?:string[]};
/** Volatile, per-instance authenticated HTTP arrival receipt. Holds no bearer,
 * OAuth state, tool parameters, conversation identifier or model content.
 */
const authenticatedIngress=new Map<string,{instanceId:string;observedAt:string;evidenceRef:string}>();
export function recordGatewayAuthenticatedIngress(edgeId:string,instanceId:string,observedAt:string):void {
  if(!edgeId||!instanceId||!Number.isFinite(Date.parse(observedAt)))return;
  authenticatedIngress.set(edgeId,{instanceId,observedAt,evidenceRef:"auth-inbound:"+instanceId+":"+edgeId+":"+observedAt});
}
function gatewayHealth(value:Health):boolean {
  return value?.healthy===true&&typeof value.instanceId==="string"&&Array.isArray(value.surface)&&
    GATEWAY_TOOL_NAMES.every(name=>value.surface!.includes(name));
}
/** Bounded protocol observations; no auth refresh, frontend, model inference or Task polling. */
export async function observeGatewayIngress(config:GatewayWorkspaceConfig) {
  const one=async(url:string):Promise<Health|null>=>{
    try{const r=await fetch(url,{signal:AbortSignal.timeout(4000),redirect:"error"});return r.status===200?await r.json() as Health:null;}
    catch{return null;}
  };
  let publicHealth:string|null=null;
  if(config.publicBaseUrl)try{const u=new URL(config.publicBaseUrl);
    if(u.protocol==="https:"&&!u.username&&!u.password&&!u.search&&!u.hash)publicHealth=new URL("/healthz",u).href;
  }catch{/* Unknown external address stays unavailable. */}
  const [local,remote]=await Promise.all([one("http://127.0.0.1:"+config.gatewayPort+"/healthz"),publicHealth?one(publicHealth):null]);
  const localReady=Boolean(local&&gatewayHealth(local));
  const remoteReady=Boolean(localReady&&remote&&gatewayHealth(remote)&&local!.instanceId===remote.instanceId);
  const at=new Date().toISOString(),digest=gatewayIngressDigest(config);
  const edges=config.edges.map(e=>{
    const network=TARGET_EDGES.find(target=>target.id===e.id)?.transport==="network-http";
    const ready=network?remoteReady:localReady;
    const generation=digest+":"+(local?.instanceId??"unknown");
    const evidence:ConditionEvidence={subject:{kind:"edge",ref:e.id,generation},
      evidenceClass:"TRANSPORT_POLL",outcome:ready?"AVAILABLE":"NEGATIVE",
      observedAt:at,validUntil:new Date(Date.parse(at)+90_000).toISOString(),
      evidenceRef:"gateway:"+String(local?.instanceId??"unknown")+":"+e.id+":"+at,
      source:"gateway-protocol-health-observation"};
    const authenticated=authenticatedIngress.get(e.id);
    const authenticatedIngressEvidence:ConditionEvidence|null=authenticated &&
      authenticated.instanceId===local?.instanceId &&
      Date.parse(authenticated.observedAt)<=Date.parse(at) &&
      Date.parse(at)-Date.parse(authenticated.observedAt)<90_000
      ? {subject:{kind:"edge",ref:e.id,generation},evidenceClass:"AUTHENTICATED_INGRESS",
         outcome:"AVAILABLE",observedAt:authenticated.observedAt,
         validUntil:new Date(Date.parse(authenticated.observedAt)+90_000).toISOString(),
         evidenceRef:authenticated.evidenceRef,source:"gateway-authenticated-http-post"}:null;
    return {edgeId:e.id,boundNodeId:e.boundNodeId,transportReady:ready,conditionEvidence:evidence,
      authenticatedIngressEvidence,
      basis:network?"Public health response must match this listener's live instance ID":"Local Gateway protocol observation"};
  });
  return {version:1,at,configDigest:digest,
    source:"gateway-protocol-health-observation",localReady,remoteReady,instanceId:local?.instanceId??null,edges,
    exactPresenceVerified:false,returnRouteVerified:false,chatgptDispatchVerified:false};
}
/** Public ingress observation is separate from authenticated connector and exact Chat Presence. */
export function startGatewayIngressObservation(file:string,config:GatewayWorkspaceConfig) {
  let closed=false,busy=false;
  const refresh=async()=>{
    if(closed||busy)return;
    busy=true;
    try{const value=await observeGatewayIngress(config);if(!closed)writeGeneratedConfig(file,value);}
    catch{/* Missing observation is reported UNKNOWN by the reader. */}
    finally{busy=false;}
  };
  const timer=setInterval(()=>{void refresh();},30_000);timer.unref();void refresh();
  return {close:()=>{closed=true;clearInterval(timer);writeGeneratedConfig(file,{version:1,at:new Date().toISOString(),
    configDigest:gatewayIngressDigest(config),source:"gateway-listener-stopped",localReady:false,remoteReady:false,edges:[],
    exactPresenceVerified:false,returnRouteVerified:false,chatgptDispatchVerified:false});}};
}
export function readGatewayIngress(project:string,nodeRef?:string,at=Date.now()):Record<string,unknown>|null {
  try{
    const data=join(project,".sidera-dev","sol","data");
    const config=JSON.parse(readFileSync(join(data,"gateway.json"),"utf8")) as GatewayWorkspaceConfig;
    const cached=JSON.parse(readFileSync(join(data,"gateway-ingress.json"),"utf8"));
    if(cached.version!==1||cached.configDigest!==gatewayIngressDigest(config))return null;
    const digest=gatewayIngressDigest(config);
    const matches:Array<{edgeId:string;boundNodeId?:string;conditionEvidence?:ConditionEvidence;authenticatedIngressEvidence?:ConditionEvidence}>=
      (Array.isArray(cached.edges)?cached.edges:[]).filter((e:{boundNodeId?:string})=>Boolean(nodeRef)&&e.boundNodeId===nodeRef);
    const projected=matches.map((e:{edgeId:string;conditionEvidence?:ConditionEvidence})=>{
      const evidence=e.conditionEvidence;
      if(!evidence || evidence.subject.ref!==e.edgeId ||
         evidence.subject.generation!==digest+":"+cached.instanceId ||
         evidence.observedAt!==cached.at)
        return projectCondition({kind:"edge",ref:e.edgeId,generation:digest+":"+cached.instanceId},null,at);
      return projectCondition(evidence.subject,evidence,at);
    });
    const authenticatedConditions=matches.map((e:{edgeId:string;authenticatedIngressEvidence?:ConditionEvidence})=>
      projectCondition({kind:"edge",ref:e.edgeId,generation:digest+":"+cached.instanceId},
        e.authenticatedIngressEvidence,at));
    const ready=projected.some(c=>c.state==="AVAILABLE");
    const hasStale=projected.some(c=>c.state==="STALE");
    return {...cached,state:ready?"healthy":"unknown",lastKnownAt:cached.at,
      observation:ready?"live":hasStale?"last-known":"unknown",
      transportReady:ready,conditions:projected,authenticatedIngressConditions:authenticatedConditions,
      authenticatedIngressObserved:authenticatedConditions.some(c=>c.state==="AVAILABLE"),
      chatgptDispatchVerified:false,exactPresenceVerified:false,returnRouteVerified:false};
  }catch{return null;}
}

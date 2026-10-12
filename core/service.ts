import { configuredChiefIngressScope, hasCoreOwner } from "../hythes/core-client.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve,join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openDatabase,withTransaction } from "./db.ts";
import { CoreRuntime } from "./runtime.ts";
import { hasPendingStandaloneTurn } from "./continuations.ts";
import { CoreRpcServer } from "./rpc.ts";
import { ChiefDispatch, type ChiefFrontend } from "./chief.ts";
import { reconcileSpecs,activateLostSession,activateApprovedEnrollments,type NodeHostSpec } from "./onboarding.ts";
import { sessionStrategy,nodeWakeStrategy } from "./session-strategy.ts";
import { hostFactories } from "../hythes/host-factories.ts";
import type { FrontendSpec } from "../hythes/frontend-registry.ts";
import { frontendFactory } from "../hythes/frontend-factory.ts";
import { startGptHythe } from "../hythes/gpt-mcp.ts";
import { ActivationController,type LiveObservation,type Presence } from "./activation.ts";
import { latestFrontendPresence, recordFrontendPresence } from "./frontend-presence.ts";
import { recordWorld } from "./worlds.ts";
import { incidentTrace } from "../hythes/transport-incident.ts";
import type { Hythe } from "../hythes/types.ts";
import { LocalPeregrineManager } from "../peregrine/local.ts";
import { captureBuildIdentity } from "./build-identity.ts";
import { repairCodexPins } from "./codex-pin.ts";
import { probeHostHealth } from "./host-health.ts";
import { readSessionHostCondition } from "./condition.ts";

export interface RuntimeFrontendSpec {nodeId:string;port:number;httpToken:string;
 /** Human-owned exact deployment scope. Never inferred from metadata or the first Project. */
 chiefConversationRef?:string;chiefBindingId?:string;chiefProviderSession?:{sessionId:string;subjectId?:string};}
export interface RuntimeSpec {version:1;corePort:number;mcpPort:number;httpToken:string;chiefNodeId:string;
 nodes:NodeHostSpec[];frontend?:FrontendSpec;frontends?:RuntimeFrontendSpec[];}
export async function startLocalService(root=process.cwd()) {
 const project=resolve(root),data=join(project,".sidera-dev","sol","data");
 const buildIdentity=captureBuildIdentity(project,join(data,"sidera.sqlite"));
 const specPath=join(data,"runtime-spec.json"),specText=readFileSync(specPath,"utf8");
 const spec=JSON.parse(specText) as RuntimeSpec;
 if (spec.version!==1 || !Array.isArray(spec.nodes)) throw new Error("Human-owned RuntimeSpec v1 required");
 // Reject a second listener owner before startup recovery can touch any Run.
 const occupied=await hasCoreOwner(spec.corePort);
 if(occupied)throw new Error("Existing Core listener owns this runtime; do not start or reconcile another owner");
 const db=openDatabase(join(data,"sidera.sqlite"));
 const hythes=new Map<string,Hythe>();
 let runtime:CoreRuntime|undefined,frontend:ChiefFrontend|undefined,rpc:CoreRpcServer|undefined,mcp:Awaited<ReturnType<typeof startGptHythe>>|undefined,chiefRef:ChiefDispatch|undefined;
 const mcpServers:Array<Awaited<ReturnType<typeof startGptHythe>>>=[];
 let closed=false,claimedOwnerId:string|undefined;
 const close=async()=>{if(closed)return;closed=true;try{chiefRef?.close();runtime?.close();
  await rpc?.close();for(const server of mcpServers)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await frontend?.close?.();for(const hythe of hythes.values())await (hythe as Hythe & {close?:()=>Promise<void>}).close?.();
 }finally{if(claimedOwnerId)db.prepare("UPDATE execution_owners SET state='exited' WHERE owner_id=?").run(claimedOwnerId);db.close();}};
 try {
 const ownerId=process.env.SIDERA_CORE_OWNER_ID ?? randomUUID();
 withTransaction(db,"claim_owner",()=>{
  const owners=db.prepare("SELECT owner_id,pid FROM execution_owners WHERE state='active'").all() as {owner_id:string;pid:number}[];
  for(const owner of owners){let alive=true;try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")alive=false;else throw error;}
   if(alive)throw new Error("Existing live Core owner is still initializing or running; preserve its Runs");
   db.prepare("UPDATE execution_owners SET state='exited' WHERE owner_id=?").run(owner.owner_id);
  }
  db.prepare("INSERT INTO execution_owners VALUES (?,?,'active',?)").run(ownerId,process.pid,new Date().toISOString());
 });
 claimedOwnerId=ownerId;
 repairCodexPins(db,spec,specPath,specText);
 for (const node of spec.nodes) {
  const factory=hostFactories[node.hostKind]; if(!factory) throw new Error(`Host adapter missing: ${node.hostKind}`);
  const hythe=factory(node,db,spec.corePort); if(hythe.hytheId!==node.hytheId) throw new Error("Host identity disagrees with spec");
  if(hythes.has(hythe.hytheId)) throw new Error("Each configured Host resource needs an independent Hythe binding");
  hythes.set(hythe.hytheId,hythe);
 }
 reconcileSpecs(db,spec.nodes,hythes);
 const persistEnrollmentSpec=()=>{const temporary=specPath+'.tmp';writeFileSync(temporary,JSON.stringify(spec,null,2)+'\n',{mode:0o600});renameSync(temporary,specPath);};
 await activateApprovedEnrollments(db,spec.nodes,hythes,persistEnrollmentSpec);
 reconcileSpecs(db,spec.nodes,hythes);
 // A recovery is never inferred from CONFIRMED_LOST and is never retried by a
 // later Core start.  The only executable request is an exact Human-reviewed
 // marker written by LocalSetup; mark it attempting durably before the first
 // provider boundary so a crash leaves a blocker, not an automatic replay.
 const persistRecoverySpec=()=>{const temporary=specPath+'.tmp';writeFileSync(temporary,JSON.stringify(spec,null,2)+'\n',{mode:0o600});renameSync(temporary,specPath);};
 for(const node of spec.nodes.filter(n=>n.recovery?.state==='approved')){
  const recovery=node.recovery!;recovery.state='attempting';persistRecoverySpec();
  const hythe=hythes.get(node.hytheId)!;
  try{
   if(readSessionHostCondition(db,node.sessionId).state!=='CONFIRMED_LOST')throw new Error('HOST_RECOVERY_REQUIRES_CONFIRMED_LOSS');
   const request={...node,recoverLostSession:true};
   if(!await activateLostSession(db,request,hythe))throw new Error('HOST_RECOVERY_NOT_SUPPORTED');
   node.sessionId=request.sessionId;node.locatorRef=request.locatorRef;recovery.state='completed';persistRecoverySpec();
   reconcileSpecs(db,spec.nodes,hythes);
  }catch(error){
   // The request is consumed even when the outcome is unavailable.  A Human
   // must inspect the recorded activation/effect evidence and explicitly make
   // another proposal; Core startup itself cannot resend or replace it.
   recovery.state='blocked';persistRecoverySpec();
   db.prepare("INSERT INTO events VALUES (?,?,'session.recovery_blocked',?,?)").run(randomUUID(),node.nodeId,
    JSON.stringify({requestId:recovery.requestId,nodeId:node.nodeId,sessionId:node.sessionId,
      code:error instanceof Error?error.message:'HOST_RECOVERY_UNAVAILABLE',replay:false}),new Date().toISOString());
  }
 }
 // Operator override is one-way: it can only add maintenance. Readiness itself
 // is always derived from durable facts plus a current live observation.
 const forcedMaintenance=process.env.SIDERA_OBSERVATION_ONLY==="1";
 let frontendRef:ChiefFrontend|undefined;
 const activeSession=(nodeId:string)=>String((db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(nodeId) as {session_id:string}|undefined)?.session_id ?? "");
 const sessionField=(sessionId:string,field:"hythe_id"|"locator_ref")=>sessionId?String((db.prepare(`SELECT ${field} FROM sessions WHERE session_id=?`).get(sessionId) as Record<string,string>|undefined)?.[field] ?? ""):"";
 // Local, browser-free transport evidence. Asking the tunnel's own management
 // endpoint proves authentication and connectivity without ever opening a
 // frontend, so it cannot walk into an anti-bot / CAPTCHA challenge.
 const tunnelHealthy=async(base:string)=>{
  const one=async(path:string)=>{try{const res=await fetch(base+path,{signal:AbortSignal.timeout(3000)});return res.status;}catch{return 0;}};
  return (await one("/healthz"))===200&&(await one("/readyz"))===200;
 }; const safeLocate=async(hythe:Hythe|undefined,locator:string)=>{
  if(!hythe||!locator)return false;
  try{const attempt=hythe.locate(locator);
   return chiefRef?Boolean(await chiefRef.observe(attempt,false)):Boolean(await attempt);}catch{return false;}};
 const activation=new ActivationController(db,{
  maintenanceForced:forcedMaintenance,
  base:()=>({worldId:recordWorld(db,"nodes",spec.chiefNodeId),chiefNodeId:spec.chiefNodeId,
   chiefSessionId:activeSession(spec.chiefNodeId)||spec.chiefNodeId,
   // Runtime-wide prerequisites do not require every worker to be LIVE. RPC
   // admission evaluates the exact requested target against this observation.
   required:[{capability:"self.*",resource:`node/${spec.chiefNodeId}/**`}]}),
  probe:async()=>{
   let frontendEvidence:unknown=null;
   const probeOne=async()=>{
    const chiefSessionId=activeSession(spec.chiefNodeId);
    // Runtime-wide readiness cannot pick one Project on a multi-Project Node.
    // Exact dispatch/return always resolves the request's configured scope.
    const bindings=chiefRef?.projects(spec.chiefNodeId)??[];
    const binding=bindings.length===1?chiefRef!.binding(spec.chiefNodeId,{bindingId:bindings[0]!.bindingId}):null;
    // A legal Human frontend Presence can only exist behind an admitted Human
    // source. Without one we must not launch a browser to "look" for it.
    const admittedSource=Boolean(db.prepare("SELECT 1 FROM human_frontend_sources WHERE world_id=? AND active=1")
      .get(recordWorld(db,"nodes",spec.chiefNodeId)));
    // Browser-free by construction. Opening the frontend to test whether the
    // frontend exists is a real Effect and walks straight into anti-bot
    // challenges, which is not a retryable path. Presence is read from durable
    // observations instead; a fresh local tunnel poll is recorded as transport
    // evidence, and an inbound authenticated dispatch is recorded as stronger
    // route evidence elsewhere.
    let frontendPresence:Presence="UNAVAILABLE";
    if(binding&&admittedSource){
     const worldId=recordWorld(db,"nodes",spec.chiefNodeId);
     try{
      const mgmt=process.env.SIDERA_TUNNEL_MANAGEMENT_URL ?? "http://127.0.0.1:8790";
      if(await tunnelHealthy(mgmt))
       recordFrontendPresence(db,{worldId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
        evidenceClass:"TRANSPORT_POLL",evidenceRef:`tunnel-healthz=200,readyz=200@${new Date().toISOString()}`,
        method:"local tunnel management endpoint"});
     }catch{/* evidence only; a probe failure is never fatal */}
     const ingress=(frontendRef?.ingress?.(binding) ?? {}) as {transportReady?:boolean;lastKnownAt?:string};
     if(ingress.transportReady===true&&typeof ingress.lastKnownAt==="string"){
      try{recordFrontendPresence(db,{worldId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
        evidenceClass:"TRANSPORT_POLL",evidenceRef:`tunnel-poll:${ingress.lastKnownAt}`,
        method:"local tunnel control-plane poll",observedAt:ingress.lastKnownAt});}catch{/* evidence only; never fatal */}
     }
     const presence=latestFrontendPresence(db,{worldId,bindingId:binding.bindingId,verifiedOnly:true});
     frontendPresence=presence.state==="LIVE"&&presence.evidenceClass==="ROUTE_VERIFIED"?"LIVE":"UNAVAILABLE";
     frontendEvidence=presence;
    }
    const chiefRuntimePresence:Presence=
      await safeLocate(hythes.get(sessionField(chiefSessionId,"hythe_id")),sessionField(chiefSessionId,"locator_ref"))
        ?"LIVE":"UNAVAILABLE";
    const targetPresence:Record<string,Presence>={[spec.chiefNodeId]:chiefRuntimePresence},
      effectProfiles:Record<string,string|null>={[spec.chiefNodeId]:hythes.get(sessionField(chiefSessionId,"hythe_id"))?.effectProfile?.("message.receive")?.id ?? null};
    const effectIdentityRequired:Record<string,boolean>={[spec.chiefNodeId]:Boolean(hythes.get(sessionField(chiefSessionId,"hythe_id"))?.effectProfile?.("message.receive")?.externalIdentityRequired)};
    for(const node of spec.nodes){
     if(node.nodeId===spec.chiefNodeId)continue;
     const row=db.prepare("SELECT session_id,hythe_id,locator_ref FROM sessions WHERE node_id=? AND state='active'")
       .get(node.nodeId) as {session_id:string;hythe_id:string;locator_ref:string}|undefined;
     const hythe=row?hythes.get(row.hythe_id):undefined;
     targetPresence[node.nodeId]=row&&(await probeHostHealth(db,hythes,row.session_id,"activation-explicit-probe")).live?"LIVE":"UNAVAILABLE";
     effectProfiles[node.nodeId]=hythe?.effectProfile?.("message.receive")?.id ?? null;
     effectIdentityRequired[node.nodeId]=Boolean(hythe?.effectProfile?.("message.receive")?.externalIdentityRequired);
    }
    return {frontendPresence,chiefRuntimePresence,targetPresence,effectProfiles,
      effectIdentityRequired,frontendEffectProfile:frontendRef?.effectProfile?.(binding??undefined)?.id ?? null,
      frontendIdentityRequired:Boolean(frontendRef?.effectProfile?.(binding??undefined)?.externalIdentityRequired)};
   };
   const unavailable:LiveObservation={frontendPresence:"UNAVAILABLE",chiefRuntimePresence:"UNAVAILABLE",
     targetPresence:{},effectProfiles:{}};
   return chiefRef?await chiefRef.observe(probeOne(),unavailable):await probeOne();
  }});
 runtime=new CoreRuntime(db,hythes,undefined,{observationOnly:forcedMaintenance,initialReady:false,ownerId,activation});
 runtime.buildIdentity=buildIdentity;
 runtime.continuations.prepareWake=sessionStrategy(db,hythes,id=>runtime!.receive(id));
 frontend=await frontendFactory(db,project,spec.frontend);
 const chief=new ChiefDispatch(db,hythes,frontend);chiefRef=chief;frontendRef=frontend;
 runtime.continuations.presentRootResult=id=>chief.present(id);
 runtime.reviewRootResult=(id,session,host,body)=>chief.review(id,session,host,body);
 const peregrines=new LocalPeregrineManager(db,join(project,".sidera-dev","peregrines"));
 const prepareNodeWake=nodeWakeStrategy(db,hythes,id=>runtime!.receive(id));
 runtime.continuations.prepareNodeWake=prepareNodeWake;
 rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:token=>{
  // This secret is held by the local Workbench process, never returned to the
  // renderer. It admits only the two typed Human Conversation methods in RPC.
  if(token===spec.httpToken)return {kind:"human" as const,id:"local-desktop-ingress"};
  const node=spec.nodes.find(n=>n.coreToken===token);if(!node)return null;
  const session=db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(node.nodeId) as {session_id:string}|undefined;
  return session?{kind:"node" as const,nodeId:node.nodeId,sessionId:session.session_id}:null;
 }},peregrines,project,chief,prepareNodeWake);
 await rpc.listen(spec.corePort);
 // Each inbound frontend authenticates as its own Node. Adapters and model
 // names never participate in cross-Node routing.
 const endpoints:RuntimeFrontendSpec[]=spec.frontends??[{nodeId:spec.chiefNodeId,port:spec.mcpPort,httpToken:spec.httpToken}];
 if(new Set(endpoints.map(e=>e.port)).size!==endpoints.length)throw new Error("Frontend ports must be unique");
 for(const endpoint of endpoints){
  const node=spec.nodes.find(n=>n.nodeId===endpoint.nodeId);
  if(!node)throw new Error("Frontend Node missing from configuration");
  const chiefIngressScope=configuredChiefIngressScope({nodeId:node.nodeId,edgeId:"native-mcp",
   conversationRef:endpoint.chiefConversationRef,bindingId:endpoint.chiefBindingId,providerSession:endpoint.chiefProviderSession});
  mcp=await startGptHythe({core:{port:spec.corePort,token:node.coreToken,chiefConversationRef:endpoint.chiefConversationRef,
    chiefIngressScope,
    observationCachePath:join(data,`chief-observations-${node.nodeId}.json`)},httpToken:endpoint.httpToken,port:endpoint.port,
   // MCP transport readiness is not a claim that every Node or Chat can execute.
   // Each real dispatch still obtains current scoped admission and its Effect gate.
   // A stale aggregate observation must not make tools/list/status inaccessible.
   readiness:()=>{const state=runtime!.maintenance(),ready=runtime!.ready&&!forcedMaintenance;
     return {ready,mode:ready?"serving":"unavailable",reasons:!runtime!.ready?["CORE_INITIALIZING"]:forcedMaintenance?["MAINTENANCE_FORCED"]:[],
       dispatchRequiresScopedAdmission:true,activation:state,buildIdentity};},
   trace:incidentTrace("local-mcp",`frontend:${node.nodeId}`)});
  mcpServers.push(mcp);
 }
 for(const node of spec.nodes) {
  const hythe=hythes.get(node.hytheId)!;
  // Inbound-only external clients have no proactively locatable Host context.
  // Configuration cannot establish Chat Presence, and absence of a proactive
  // protocol route is not a terminated resource or a failed Node.
  if (!hythe.capabilities().includes("message.receive")) continue;
  // Startup observes the registered exact Host. A negative/timeout observation
  // is UNKNOWN, not LossProof. Do not fence prior Effects or silently replace
  // Sessions until a separately authorized, owner-confirmed recovery is possible.
  const observed=await probeHostHealth(db,hythes,node.sessionId,"startup-exact-host-probe");
  if (!observed.live) {
    db.prepare("INSERT INTO events VALUES (?,?,'session.activation_unavailable',?,?)").run(randomUUID(),node.nodeId,
      JSON.stringify({nodeId:node.nodeId,sessionId:node.sessionId,
        code:"HOST_NOT_CURRENTLY_OBSERVED",evidenceRef:observed.evidenceRef??null,
        noResourceLossProof:true,replay:false}),new Date().toISOString());
    continue;
  }
  void runtime.receive(node.sessionId).catch(()=>{});
 }
 reconcileSpecs(db,spec.nodes,hythes);
 runtime.ready=true;
 // Startup/recovery owns preparation. Status queries never invoke this path.
  for(const nodeId of new Set(endpoints.map(e=>e.nodeId)))
   for(const binding of chief.projects(nodeId))await chief.prepareFrontend(nodeId,{bindingId:binding.bindingId});
 await runtime.activation?.refresh();
 if(!forcedMaintenance)await chief.recoverRequests();
 if(!forcedMaintenance) await runtime.continuations.wakeObservations();
  return {config:{corePort:spec.corePort,mcpPort:spec.mcpPort,nodes:spec.nodes.map(n=>({nodeId:n.nodeId,sessionId:n.sessionId,hytheId:n.hytheId,hostKind:n.hostKind}))},
  close,canStop:()=>!db.prepare("SELECT 1 FROM task_runs WHERE turn_open=1").get() && !hasPendingStandaloneTurn(db,undefined,{currentExecutorOnly:true})};
 }catch(error){await close();throw error;}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
 const service=await startLocalService(process.env.SIDERA_PROJECT_ROOT ?? process.cwd());
 process.stdout.write(`Sidera Core 127.0.0.1:${service.config.corePort}; MCP ${service.config.mcpPort}; ${service.config.nodes.length} declarative Nodes\n`);
 const stop=()=>{void service.close().then(()=>process.exit(0));};process.once("SIGINT",stop);process.once("SIGTERM",stop);
 process.on("message",message=>{if(message==="sidera:graceful-stop"){
  if(!service.canStop()){process.send?.({stop:"blocked",reason:"Open Host turn requires reconciliation; owner preserved"});return;}
  process.send?.({stop:"accepted"});stop();
 }});
}

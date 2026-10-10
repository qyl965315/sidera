import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Hythe } from "../hythes/types.ts";
import { operationEffect, type CapabilityManifest } from "../hythes/manifest.ts";
import { reserveCapability, settleReservation } from "./authority.ts";
import { controlHost } from "./host-control.ts";
import { SideraError } from "./types.ts";
import { capabilityTruth } from "./capability-truth.ts";
import {readSessionHostCondition} from "./condition.ts";

const registryReads=new Set(["node.inspect","node.capabilities","session.list","model.inspect","host.inspect","host.status"]);

export function discoverNode(db:DatabaseSync,hythes:ReadonlyMap<string,Hythe>,nodeId:string) {
  const node=db.prepare("SELECT node_id,display_name,lifecycle FROM nodes WHERE node_id=?").get(nodeId);
  if (!node) throw new SideraError("not_found","Logical Node not found");
  const session=db.prepare("SELECT * FROM sessions WHERE node_id=? AND state='active'").get(nodeId) as
    {session_id:string;hythe_id:string;host_kind:string;locator_ref:string} | undefined;
  const hythe=session && hythes.get(session.hythe_id);
  const stored=db.prepare("SELECT manifest_json FROM capability_manifests WHERE node_id=?").get(nodeId) as {manifest_json:string}|undefined;
  const manifest:CapabilityManifest|null=hythe?.manifest?.() ?? (stored?JSON.parse(stored.manifest_json):null);
  const health=session?readSessionHostCondition(db,session.session_id):null;
  if(manifest) {manifest.nodeId=nodeId;manifest.sessionId=session?.session_id ?? null;manifest.availability=health ?? {state:"unverified"};}
  if(manifest) manifest.operations=manifest.operations.map(o=>registryReads.has(o.operation)?
    {...o,supported:true,backend:"core:registry",routeClass:"native" as const}:o);
  const capabilities=manifest?.operations.map(o=>({...capabilityTruth(db,nodeId,session?.session_id??null,o.operation,registryReads.has(o.operation)),
    declaredSupported:o.supported,authority:"separate",controlMode:registryReads.has(o.operation)?"enforced":"audited",
    controlScope:registryReads.has(o.operation)?"core-operation":"Sidera entry is gated; autonomous Host effects remain audited"}))??[];
  return {node,session:session ?? null,manifest,capabilities,route:session?{backend:session.hythe_id,locatorRef:session.locator_ref,
    available:Boolean(hythe) && health?.canExecute===true,health:health ?? {state:"UNKNOWN"}}:null};
}

/** Caller names a Node and semantic operation. Protocol/Host details stay here. */
async function executeCapability(db:DatabaseSync,hythes:ReadonlyMap<string,Hythe>,caller:{nodeId:string;sessionId:string},
  request:{requestId:string;targetNodeId:string;operation:string;input:Record<string,unknown>;expectedSessionId?:string}) {
  const target=discoverNode(db,hythes,request.targetNodeId);
  if (!target.session) throw new SideraError("unavailable","Target has no active Session");
  if (request.expectedSessionId && request.expectedSessionId!==target.session.session_id)
    throw new SideraError("conflict","Target Session changed; exact routing requires reconciliation");
  const capability=`${caller.nodeId===request.targetNodeId?"self.":""}${request.operation}`;
  if (registryReads.has(request.operation)) {
    const permit=reserveCapability(db,{subjectNodeId:caller.nodeId,sessionId:caller.sessionId,
      requestId:`capability:${request.requestId}`,capability,resource:`node/${request.targetNodeId}`});
    let data:unknown=target;
    if (request.operation==="node.inspect") data=target.node;
    if (request.operation==="session.list") data=db.prepare("SELECT session_id,hythe_id,host_kind,locator_ref,state FROM sessions WHERE node_id=?").all(request.targetNodeId);
    if (request.operation==="model.inspect") data=db.prepare("SELECT binding_id,provider,model_id,reasoning_config FROM model_bindings WHERE node_id=? AND valid_until IS NULL").get(request.targetNodeId) ?? null;
    if (permit.reservationId) settleReservation(db,permit.reservationId,"consumed");
    const result={status:"host_confirmed",effect:"read_completed",operation:request.operation,targetNodeId:request.targetNodeId,
      targetSessionId:target.session.session_id,route:{backend:"core:registry",routeClass:"native"},agentTurnCompleted:null,
      taskCompleted:null,responsibilityCompleted:null,worldChanged:false,humanObserved:null,data};
    db.prepare("INSERT INTO events VALUES (?,?,'capability.observed',?,?)").run(randomUUID(),caller.nodeId,
      JSON.stringify({requestId:request.requestId,result}),new Date().toISOString());
    return result;
  }
  const operation=target.manifest?.operations.find(o=>o.operation===request.operation);
  if (!operation?.supported) {
    const permit=reserveCapability(db,{subjectNodeId:caller.nodeId,sessionId:caller.sessionId,requestId:`capability:${request.requestId}`,
      capability,resource:`node/${request.targetNodeId}/session/${target.session.session_id}`});
    if(permit.reservationId)settleReservation(db,permit.reservationId,"released");
    throw new SideraError("unavailable","Operation explicitly unsupported by target Host");
  }
  return controlHost(db,hythes,caller,{requestId:request.requestId,targetSessionId:target.session.session_id,
    operation:operation.backendOperation,input:request.input,authorizationCapability:capability});
}

/** Record denial/non-effect as an Effect stage without logging arbitrary caller args. */
export async function invokeCapability(db:DatabaseSync,hythes:ReadonlyMap<string,Hythe>,caller:{nodeId:string;sessionId:string},
 request:{requestId:string;targetNodeId:string;operation:string;input:Record<string,unknown>;expectedSessionId?:string}) {
 try{return await executeCapability(db,hythes,caller,request);}catch(error){
  const code=error instanceof SideraError?error.code:"unavailable";
  db.prepare("INSERT INTO events VALUES (?,?,'capability.rejected',?,?)").run(randomUUID(),caller.nodeId,
   JSON.stringify({requestId:request.requestId,targetNodeId:request.targetNodeId,operation:request.operation,code,
    effect:code==="uncertain"?"uncertain":"not_started",authority:code==="denied"?"AUTHORITY_DENIED":"checked",
    agentTurnCompleted:false,taskCompleted:false,responsibilityCompleted:false,worldChanged:code==="uncertain"?null:false,humanObserved:null}),new Date().toISOString());
  throw error;
 }
}

export interface RouteCandidate {id:string;routeClass:"native"|"protocol"|"ui-fallback";logicalLocator:string;
  invoke():Promise<Record<string,unknown>>}
/** Only a read or proof of rejection before effect can move to another exact route. */
export async function effectAwareRoute(operation:string,logicalLocator:string,routes:RouteCandidate[]) {
  const rank={native:0,protocol:1,"ui-fallback":2}; const errors:{route:string;error:string}[]=[];
  for (const route of [...routes].sort((a,b)=>rank[a.routeClass]-rank[b.routeClass])) {
    if (route.logicalLocator!==logicalLocator) continue;
    try {
      const effect=await route.invoke();
      if (operationEffect(operation)==="read" && ["unavailable","rejected"].includes(String(effect.status))) {
        errors.push({route:route.id,error:String(effect.reason??effect.status)});continue;
      }
      if (effect.status==="uncertain") return {status:"UNCERTAIN",route:route.id,effect,errors};
      if (effect.status==="rejected" && effect.beforeEffect===true) {errors.push({route:route.id,error:String(effect.reason ?? "rejected")});continue;}
      return {status:"PASS",route:route.id,effect,errors};
    } catch(error) {
      errors.push({route:route.id,error:error instanceof Error?error.message:String(error)});
      if (operationEffect(operation)!=="read") return {status:"UNCERTAIN",route:route.id,errors};
    }
  }
  return {status:"HOST_UNAVAILABLE",observationAvailable:false,beforeEffect:operationEffect(operation)==="write",errors};
}

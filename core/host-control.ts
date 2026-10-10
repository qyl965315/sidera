import { effectAwareRoute } from "./control-plane.ts";
import { operationEffect } from "../hythes/manifest.ts";
import { randomUUID } from "node:crypto";
import { recordCapabilityCheck } from "./capability-truth.ts";
import { isExecutorRuntimeSession } from "./executors.ts";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "./authority.ts";
import { rotateSessionIncarnation, sessionGeneration, withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { SemanticStore } from "./semantics.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import type { Hythe } from "../hythes/types.ts";
import { prepareEffect,effectBoundary,effectKnowledge,observeEffect,abandonPreparedEffect,type EffectBoundary } from "./effect-gate.ts";

/** Core owns authorization, fixed target identity, and uncertain-action recovery. */
export async function controlHost(db: DatabaseSync, hythes: ReadonlyMap<string, Hythe>,
  caller: { nodeId: string; sessionId: string }, request: {
    requestId: string; targetSessionId: string; operation: string; input: Record<string, unknown>;
    authorizationCapability?: string;
  }): Promise<Record<string, unknown>> {
  const target = db.prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(request.targetSessionId) as { node_id: string; hythe_id: string;
      locator_ref: string; state: string } | undefined;
  if (!target) throw new SideraError("not_found", "Target Session not found");
  const worldId = recordWorld(db, "nodes", caller.nodeId);
  requireWorld(db, worldId, "sessions", request.targetSessionId);
  if (target.state === "retired") throw new SideraError("conflict", "Target Session is retired");
  const hythe = hythes.get(target.hythe_id);
  const resource = `node/${target.node_id}/session/${request.targetSessionId}`;
  const own = target.node_id === caller.nodeId;
  // Discovery is authorized too. Capability exposure never grants access.
  const capability = request.authorizationCapability ?? `${own ? "self." : ""}host.${request.operation}`;
  const fingerprint = JSON.stringify({ callerSessionId: caller.sessionId,
    targetSessionId: request.targetSessionId, operation: request.operation, input: request.input, capability });
  const previous = db.prepare(`SELECT kind, payload FROM events WHERE actor_node_id = ?
    AND kind IN ('host.control.started', 'host.control.settled')
    AND json_extract(payload, '$.requestId') = ? ORDER BY rowid DESC LIMIT 1`)
    .get(caller.nodeId, request.requestId) as { kind: string; payload: string } | undefined;
  if (previous) {
    const record = JSON.parse(previous.payload);
    if (record.fingerprint !== fingerprint) throw new SideraError("conflict", "Request ID was used for another host action");
    if (previous.kind === "host.control.started")
      throw new SideraError("uncertain", "Prior host action is unresolved; reconcile without resending");
    // Check current caller/grant before returning cached host data.
    reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
      capability, resource, requestId: `host:${request.requestId}` });
    return record.result;
  }
  const record = (kind: string, payload: Record<string, unknown>) =>
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), caller.nodeId,
      kind, JSON.stringify({ requestId: request.requestId, fingerprint, ...payload }), new Date().toISOString());
  const permit = withTransaction(db, "host_control", () => {
    const permit = reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
      capability, resource, requestId: `host:${request.requestId}` });
    if (!hythe || (request.operation !== "capabilities" &&
        (!hythe.control || !hythe.controls?.().includes(request.operation))))
      throw new SideraError("unavailable", "Target Host control backend is unavailable");
    const semantics = new SemanticStore(db, worldId);
    const actionId = semantics.logicalAction(caller.nodeId, target.node_id, request.operation, `host:${caller.nodeId}:${request.requestId}`);
    const attemptId = semantics.attempt(actionId, request.targetSessionId);
    record("host.control.started", { logicalActionId: actionId, attemptId, targetSessionId: request.targetSessionId,
      locatorRef: target.locator_ref, capability, resource, reservationId: permit.reservationId });
    return { ...permit, actionId, attemptId };
  });
  let result: Record<string, unknown>;
  let boundary:EffectBoundary|undefined;
  try {
    if(operationEffect(request.operation)!=="read" && request.operation!=="capabilities") {
      const profile=hythe!.effectProfile?.(request.operation);
      if(!profile)throw new SideraError("unavailable","Host capability has no verified final-send boundary/profile");
      const effect={actionId:permit.actionId,attemptId:permit.attemptId,actorSessionId:caller.sessionId,
        capability,resource,requestId:`host:${request.requestId}`,reservationId:permit.reservationId,payload:request.input,profile,targetExecutes:request.operation==="conversation.send",
        hostResourceRecovery:own && caller.sessionId===request.targetSessionId && capability==="self.host.conversation.resume" && request.operation==="conversation.resume"};
      boundary=effectBoundary(db,prepareEffect(db,effect),effect);
    }
    const data:Record<string,unknown> = request.operation === "capabilities" ?
      { hytheId: hythe!.hytheId, hostKind: hythe!.hostKind,
        operations: hythe!.controls?.() ?? [], manifest: hythe!.manifest?.() ?? null,
        autonomousControlAvailable: hythe!.canStartTurn?.() ?? Boolean(hythe!.control) } :
      await (async()=>{
        // Custom fallbacks remain available for reads. Effects use only the
        // adapter's declared final boundary; a route closure cannot bypass it.
        const routes=(!boundary ? hythe!.controlRoutes?.(target.locator_ref,request.operation,request.input) : undefined) ?? [{id:hythe!.hytheId,
          routeClass:hythe!.manifest?.().operations.find(o=>o.backendOperation===request.operation)?.routeClass ?? "protocol" as const,
          logicalLocator:target.locator_ref,invoke:()=>hythe!.control!(target.locator_ref,request.operation,request.input,boundary)}];
        const routed=await effectAwareRoute(request.operation,target.locator_ref,routes);
        if(routed.status==="UNCERTAIN")throw new SideraError("uncertain",JSON.stringify(routed));
        if(routed.status==="HOST_UNAVAILABLE" && routed.beforeEffect)return {status:"rejected",beforeEffect:true,routeErrors:routed.errors};
        if(routed.status==="HOST_UNAVAILABLE")throw new SideraError("unavailable",JSON.stringify(routed.errors));
        return {...routed.effect!,selectedRoute:routed.route,routeErrors:routed.errors};
      })();
    // Preserve the backend's evidence level. A notification write has no Host ACK.
    if (data.status === "uncertain") throw new SideraError("uncertain", "Backend effect is uncertain");
    if(boundary) {
      if(effectKnowledge(db,permit.attemptId)==="prepared") {
        if(data.status!=="rejected")throw new SideraError("denied","Adapter did not cross the final Effect boundary");
        abandonPreparedEffect(db,permit.attemptId,"Local pre-boundary rejection; callback fenced");
      } else {
        if(data.status==="rejected")throw new SideraError("uncertain","Negative response after crossing is insufficient no-effect evidence");
        observeEffect(db,permit.attemptId,data.status==="transport_admitted"?"uncertain":"accepted",String(data.hostRef??request.requestId));
      }
    }
    const status = data.status === "transport_admitted" || data.status === "accepted" ||
      data.status === "rejected" ? data.status : "host_confirmed";
    result = { status, effect: status === "accepted" ? "host_accepted" :
      status === "host_confirmed" ? "host_control_completed" : status,
      agentTurnCompleted: null, taskCompleted: null, humanPresentationObserved: null, operation: request.operation,
      targetSessionId: request.targetSessionId, data };
    if(boundary && own && caller.sessionId===request.targetSessionId && request.operation==="conversation.resume" && status==="host_confirmed") {
      // A new governed resume can restore the exact resource. It cannot revive
      // a fenced Attempt or replay any uncertain Task.
      if(!await hythe!.locate(target.locator_ref))throw new SideraError("uncertain","Resumed Host did not materialize the exact locator");
      withTransaction(db,"host_recovery_observed",()=>{
        const current=db.prepare("SELECT state,locator_ref,hythe_id FROM sessions WHERE session_id=?").get(request.targetSessionId);
        if(!current || (current.state!=="active" && !isExecutorRuntimeSession(db,caller.nodeId,request.targetSessionId)) || current.locator_ref!==target.locator_ref || current.hythe_id!==target.hythe_id)
          throw new SideraError("uncertain","Exact Session changed during Host resume");
        // The old resource-loss receipt is irrevocably scoped to the previous
        // incarnation, even if the provider reused the same locator string.
        rotateSessionIncarnation(db,request.targetSessionId);
        const generation=sessionGeneration(db,request.targetSessionId);
        if(!generation)throw new SideraError("unavailable","Resumed Host has no persisted incarnation");
        const eventId=randomUUID(),at=new Date().toISOString();
        db.prepare("INSERT INTO events VALUES (?,?,'host.health.changed',?,?)").run(eventId,target.node_id,
          JSON.stringify({targetNodeId:target.node_id,sessionId:request.targetSessionId,generation,state:"available",source:"authorized-exact-host-resume",attemptId:permit.attemptId}),at);
        db.prepare("INSERT INTO session_health VALUES (?,'available',?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,event_id=excluded.event_id,updated_at=excluded.updated_at")
          .run(request.targetSessionId,eventId,at);
      });
    }
  } catch (error) {
    if(operationEffect(request.operation)!=="read" && ["not_prepared","allocated","prepared","confirmed_no_effect"].includes(effectKnowledge(db,permit.attemptId))) {
      abandonPreparedEffect(db,permit.attemptId,"Final boundary not crossed; callback fenced");
      if(permit.reservationId)settleReservation(db,permit.reservationId,"released");
      record("host.control.settled",{result:{status:"rejected",beforeEffect:true,reason:error instanceof Error?error.message:String(error)}});
      throw error;
    }
    if (operationEffect(request.operation)==="read" && !(error instanceof SideraError && error.code==="uncertain")) {
      const known=db.prepare(`SELECT payload,created_at FROM events WHERE kind='host.control.settled'
        AND actor_node_id=? AND json_extract(payload,'$.fingerprint')=? AND json_extract(payload,'$.result.status')!='unavailable' ORDER BY rowid DESC LIMIT 1`)
        .get(caller.nodeId,fingerprint) as {payload:string;created_at:string}|undefined;
      result={status:"unavailable",effect:"observation_unavailable",operation:request.operation,
        targetSessionId:request.targetSessionId,observationAvailable:false,lastKnown:known?JSON.parse(known.payload).result:null,
        lastKnownAt:known?.created_at ?? null,rawRouteErrors:[{backend:target.hythe_id,error:error instanceof Error?error.message:String(error)}]};
      if (permit.reservationId) settleReservation(db,permit.reservationId,"released");
      record("host.control.settled",{result}); return result;
    }
    // Even a backend exception may follow a side effect. Preserve the durable start.
    if(["may_have_effect","accepted","uncertain"].includes(effectKnowledge(db,permit.attemptId)))observeEffect(db,permit.attemptId,"uncertain","Host result unavailable");
    record("host.control.uncertain",{targetSessionId:request.targetSessionId,operation:request.operation,
      rawError:error instanceof Error?error.message:String(error),replay:false});
    throw new SideraError("uncertain", "Host action outcome requires reconciliation; do not resend");
  }
  withTransaction(db, "host_settle", () => {
    if (permit.reservationId) settleReservation(db, permit.reservationId, result.status === "rejected" ? "released" : "consumed");
    record("host.control.settled", { result });
    recordCapabilityCheck(db,{nodeRef:target.node_id,sessionRef:request.targetSessionId,operation:request.operation,
      available:["host_confirmed","accepted"].includes(String(result.status)),sourceRef:`host-control:${caller.nodeId}:${request.requestId}`});
  });
  return result;
}

import { registerArtifact,getArtifactReference,previewContextHandoff,createContextHandoff,getContextHandoff,type ArtifactInput,type ContextHandoffInput } from "./shared-transfer.ts";
import { startCooperation } from "./cooperation.ts";
import { withTransaction } from "./db.ts";
import { inspectWorld,inspectWork } from "./inspection.ts";
import { invokeCapability } from "./control-plane.ts";
import { createServer, type Server, type Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { ackMessage, deliverMessage, getMessage, sendMessage } from "./bus.ts";
import { getTask } from "./scheduler.ts";
import { CoreRuntime } from "./runtime.ts";
import { Registry, registryAuthority } from "./registry.ts";
import { IdentityStore, renameNode } from "./identity.ts";
import { getSubjectivity, reviseSubjectivity } from "./subjectivity.ts";
import { SideraError } from "./types.ts";
import {rpcProblem} from "./problem.ts";
import type { Hythe } from "../hythes/types.ts";
import type { LocalPeregrineManager } from "../peregrine/local.ts";
import { writeE2EMarker } from "../peregrine/e2e.ts";
import { readOwnedText, writeOwnedText } from "../peregrine/text.ts";
import { controlHost } from "./host-control.ts";
import { acceptGptResult } from "./gpt-result.ts";
import { issueGrant, listGrants,reserveCapability,settleReservation } from "./authority.ts";
import { appointRole, createResponsibility, getResponsibility,
  listResponsibilities, listRoles, transferResponsibility,
  completeResponsibility, raiseEscalation } from "./organization.ts";
import { acceptResponsibility, deferResponsibility, deferEscalation } from "./organization.ts";
import { listTensions, mutateTension, type TensionKind, type TensionStatus, type SourceRef } from "./tensions.ts";
import { readProjectSource } from "./source.ts";
import { handoffChiefConversation, type ChiefDispatch } from "./chief.ts";
import { openSupervision, supervisionView, linkTaskToSupervision } from "./supervision.ts";
import { uncertainEffects, reconcileEffect, type EffectResolution } from "./effects.ts";
import { canUseCapability } from "./authority.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { listResources, putResource, readResource, resourceMetadata, scopeResource } from "./resources.ts";
import { SemanticStore, type SemanticBasis } from "./semantics.ts";
import { taskBasis } from "./semantics.ts";
import { randomUUID } from "node:crypto";
import { constitutionalRpc, isConstitutionalMethod } from "./constitutional-rpc.ts";
import { isExecutorRuntimeSession, selectDispatchExecutor, admitExecutorRuntime, executorPool } from "./executors.ts";
import { readNodeOntology } from "./ontology.ts";
import { probeHostHealth } from "./host-health.ts";
import {readSessionHostCondition} from "./condition.ts";
import { conversationView, dispatchConversation, requireUniqueLocalConversationHuman } from "./conversation.ts";

export type RpcPrincipal =
  | { kind: "human"; id: string; actId?:string }
  | { kind: "node"; nodeId: string; sessionId: string };

export interface RpcAuthenticator {
  authenticate(token: string): RpcPrincipal | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SideraError("conflict", "Expected an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SideraError("conflict", `${name} must be a nonempty string`);
  }
  return value;
}

/** Local, long-lived JSONL RPC. The authenticator maps tokens to principals. */
export class CoreRpcServer {
  private readonly db: DatabaseSync;
  private readonly runtime: CoreRuntime;
  private readonly hythes: ReadonlyMap<string, Hythe>;
  private readonly auth: RpcAuthenticator;
  private readonly registry: Registry;
  private readonly identities: IdentityStore;
  private readonly server: Server;
  private readonly socketPrincipals = new Map<Socket, RpcPrincipal>();
  private readonly unsubscribeResult: () => void;
  private readonly peregrines?: LocalPeregrineManager;
  private readonly project?: string;
  private readonly chief?: ChiefDispatch;
  private readonly prepareNodeWake?: (wakeId:string,nodeId:string,sessionId:string,commitWake?:(nextSessionId:string)=>void)=>Promise<string>;

  constructor(db: DatabaseSync, runtime: CoreRuntime,
    hythes: ReadonlyMap<string, Hythe>, auth: RpcAuthenticator, peregrines?: LocalPeregrineManager, project?: string,
    chief?: ChiefDispatch, prepareNodeWake?: (wakeId:string,nodeId:string,sessionId:string,commitWake?:(nextSessionId:string)=>void)=>Promise<string>) {
    this.db = db;
    this.runtime = runtime;
    this.hythes = hythes;
    this.auth = auth;
    this.peregrines = peregrines;
    this.project = project;
    this.chief = chief;
    this.prepareNodeWake = prepareNodeWake;
    if(chief)chief.dispatchNext=async(caller,input)=>{
      const s=supervisionView(db,input.supervisionId);
      const round=db.prepare("SELECT task_id,agent_node_id FROM supervision_rounds WHERE supervision_id=? AND round_index=?").get(input.supervisionId,input.roundIndex);
      if(!round?.task_id || Number(s.lastDecision?.round_index)!==input.roundIndex)return;
      const nextRequestId=`supervision:${input.supervisionId}:${input.roundIndex+1}`;
      const already=db.prepare("SELECT task_id FROM tasks WHERE origin_node_id=? AND request_id=?").get(caller.nodeId,nextRequestId);
      if(already)return {taskId:already.task_id,replayed:false};
      const count=Number(db.prepare("SELECT count(*) n FROM supervision_tasks WHERE supervision_id=?").get(input.supervisionId)!.n);
      if(count>input.roundIndex)return {state:"already_scheduled",replayed:false};
      if(count>=s.maxRounds){db.prepare("UPDATE supervisions SET state='budget_exhausted',updated_at=? WHERE supervision_id=?").run(new Date().toISOString(),input.supervisionId);return {state:"budget_exhausted"};}
      try{const result=await this.call({kind:"node",...caller},"task.submit",{requestId:nextRequestId,
        centerNodeId:input.nextNodeId??String(round.agent_node_id),body:input.instruction,supervisionId:input.supervisionId,basis:taskBasis(db,String(round.task_id))});
        if((result as {state?:string}).state==='BLOCKED')throw new SideraError("unavailable",JSON.stringify((result as {reasons?:string[]}).reasons??[]));
        return result;}
      catch(error){const created=db.prepare("SELECT task_id FROM tasks WHERE origin_node_id=? AND request_id=?").get(caller.nodeId,nextRequestId);
        const result={state:created?"needs_reconciliation":"blocked",reason:String(error),taskCreated:!!created,taskId:created?.task_id??null,
          recovery:created?"Inspect/reconcile the original Task; never replay":
            "No Task or Host effect was created. Inspect current candidates, then use a new task_dispatch in this same supervision for a suitable authorized Node. Preserve the recorded review; do not resubmit its decision or ask Human to relay.",replayed:false};
        db.prepare("INSERT INTO events VALUES (?,?,'supervision.advance_blocked',?,?)").run(randomUUID(),caller.nodeId,JSON.stringify({...input,...result}),new Date().toISOString());return result;}
    };
    this.registry = new Registry(db, {
      authorize: registryAuthority(db),
      getHythe: id => hythes.get(id),
    });
    this.identities = new IdentityStore(db);
    this.server = createServer(socket => this.handleSocket(socket));
    this.unsubscribeResult = runtime.onResult(event => {
      for (const [socket, principal] of this.socketPrincipals) {
        if (principal.kind === "node" && principal.nodeId === event.originNodeId &&
            socket.writable) {
          socket.write(`${JSON.stringify({ method: event.state === "delivered" ?
            "task.result" : "task.status", params: event })}\n`);
        }
      }
    });
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return address.port;
  }

  async close(): Promise<void> {
    this.unsubscribeResult();
    if(!this.server.listening)return;
    for(const socket of this.socketPrincipals.keys())socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
    });
  }

  hasConnectedSession(nodeId: string, sessionId: string): boolean {
    for (const [socket, principal] of this.socketPrincipals) {
      if (socket.writable && principal.kind === "node" &&
          principal.nodeId === nodeId && principal.sessionId === sessionId) return true;
    }
    return false;
  }

  private handleSocket(socket: Socket): void {
    socket.once("close", () => this.socketPrincipals.delete(socket));
    socket.on("error", () => this.socketPrincipals.delete(socket));
    socket.setEncoding("utf8");
    let pending = "";
    socket.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 1_000_000) {
        socket.destroy();
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        void this.respond(socket, line);
        newline = pending.indexOf("\n");
      }
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let id: unknown = null;
    try {
      const request = object(JSON.parse(line));
      id = request.id ?? null;
      const token = string(request.token, "token");
      const principal = this.auth.authenticate(token);
      if (!principal) throw new SideraError("denied", "Invalid RPC credential");
      if (principal.kind === "node") {
        const active = this.db.prepare(`SELECT 1 FROM sessions WHERE session_id = ?
          AND node_id = ? AND state = 'active'`)
          .get(principal.sessionId, principal.nodeId);
        if (!active && !isExecutorRuntimeSession(this.db,principal.nodeId,principal.sessionId)) throw new SideraError("denied", "Credential Session is not active or admitted Executor");
      }
      const existing = this.socketPrincipals.get(socket);
      if (existing && JSON.stringify(existing) !== JSON.stringify(principal)) {
        throw new SideraError("denied", "RPC connection cannot switch principals");
      }
      this.socketPrincipals.set(socket, principal);
      const result = await this.call(principal, string(request.method, "method"),
        object(request.params));
      if (socket.writable) socket.write(`${JSON.stringify({ id, result })}\n`);
    } catch (error) {
      const failure = error instanceof SideraError ? error :
        new SideraError("unavailable", "RPC request failed");
      // Stable machine-readable Problem augments (does not replace) the legacy
      // RPC error code/message. Unknown internal failures never leak raw text.
      const problem=rpcProblem(error);
      if (socket.writable) socket.write(`${JSON.stringify({ id, error: {
        code: failure.code, message: failure.message, problem,
      } })}\n`);
    }
  }

  private parseBasis(value: unknown, task: true): SemanticBasis;
  private parseBasis(value: unknown, task: false): Omit<SemanticBasis,"responsibilityId">;
  private parseBasis(value: unknown, task: boolean) {
    const p = object(value);
    if (!Array.isArray(p.contextBasis) || !p.contextBasis.every(ref => typeof ref === "string" && ref.length))
      throw new SideraError("conflict", "Explicit context basis references required");
    return { intentRevisionId: string(p.intentRevisionId,"intentRevisionId"), contextBasis: p.contextBasis as string[],
      ...(task ? {responsibilityId:string(p.responsibilityId,"responsibilityId")} : {}) };
  }

  private async call(principal: RpcPrincipal, method: string, p: Record<string, unknown>) {
    // A bearer Node cannot switch principal kind or manufacture Human ingress.
    // Human clients may reference only an act already admitted by trusted ingress.
    if(principal.kind==="human")principal={...principal,actId:typeof p.humanActId==="string"?p.humanActId:principal.actId};
    // Sovereignty is strictly the authenticated subject's own private region.
    // A caller may not even *name* another subject: a silently ignored selector
    // is still a misleading cross-subject API, so the request is refused.
    if(method.startsWith("subjectivity.") && ["nodeId","targetNodeId","nodeRef","subjectNodeId","targetNodeRef",
      "subjectRef","node","selfNodeId","ownerNodeId"].some(key=>Object.hasOwn(p,key)))
      throw new SideraError("denied","Sovereignty accepts no Node selector; only the authenticated subject owns this surface");
    // The desktop owns this bearer and reaches Core only after its same-origin
    // HTTP boundary captured a literal Human utterance. This is intentionally a
    // tiny allowlist, not a Human-shaped generic Core RPC surface.
    if (method === "human.conversation.view" || method === "human.conversation.send") {
      if (principal.kind !== "human" || principal.id !== "local-desktop-ingress")
        throw new SideraError("denied", "Local Human ingress credential required");
      const allowed = method === "human.conversation.view"
        ? ["humanId","bindingId"] : ["humanId","bindingId","clientNonce","utteranceId","body"];
      if (Object.keys(p).some(key => !allowed.includes(key)) || !allowed.every(key => typeof p[key] === "string"))
        throw new SideraError("conflict", "Malformed typed Conversation request");
      const humanId=string(p.humanId,"humanId"),bindingId=string(p.bindingId,"bindingId");
      // Local Workbench bearer proves the Workbench, not a selectable Human.
      requireUniqueLocalConversationHuman(this.db,{humanId,bindingId});
      if (method === "human.conversation.view") {
        const view=conversationView(this.db,{humanId,bindingId});
        const session=this.db.prepare("SELECT session_id,hythe_id FROM sessions WHERE node_id=? AND state='active'").get(view.binding.chiefNodeId) as {session_id:string;hythe_id:string}|undefined;
        const hythe=session?this.hythes.get(session.hythe_id):undefined;
        const profile=hythe?.effectProfile?.("message.receive");
        const sendEnabled=Boolean(this.runtime.ready && !this.runtime.observationOnly && session && profile &&
          canUseCapability(this.db,{subjectNodeId:view.binding.chiefNodeId,sessionId:session.session_id,capability:"message.send",resource:`node/${view.binding.chiefNodeId}`,requestId:"conversation-status-send",projectRef:view.binding.projectRef}) &&
          canUseCapability(this.db,{subjectNodeId:view.binding.chiefNodeId,sessionId:session.session_id,capability:"self.host.execute",resource:`node/${view.binding.chiefNodeId}/session/${session.session_id}`,requestId:"conversation-status-execute",projectRef:view.binding.projectRef}));
        const reasons:string[]=[];
        if(!this.runtime.ready)reasons.push("CORE_INITIALIZING");
        if(this.runtime.observationOnly)reasons.push("CORE_OBSERVATION_ONLY");
        if(!session)reasons.push("EXACT_HOST_SESSION_UNAVAILABLE");
        if(session&&!profile)reasons.push("HOST_EFFECT_PROFILE_UNAVAILABLE");
        if(session&&profile&&!sendEnabled)reasons.push("CURRENT_AUTHORITY_OR_EFFECT_GATE_UNAVAILABLE");
        return {...view,sendEnabled,reasons};
      }
      const clientNonce=string(p.clientNonce,"clientNonce");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(clientNonce))
        throw new SideraError("conflict", "Client message nonce is invalid");
      if (!this.runtime.ready || this.runtime.observationOnly) throw new SideraError("unavailable", "Core is not accepting Conversation delivery");
      const receipt=dispatchConversation(this.db,{humanId,bindingId,clientNonce,utteranceId:string(p.utteranceId,"utteranceId"),body:string(p.body,"body")});
      // Explicit same-nonce continuation cannot create another logical message.
      // Never reinterpret an uncertain or in-flight Effect as safe to replay.
      // Resume the same explicit nonce only when its original Message is still queued.
      // No retry of any sending, delivered, observed or uncertain Effect.
      if (receipt.fresh || getMessage(this.db,receipt.messageId).state === "queued") {
        const delivered=await deliverMessage(this.db,receipt.messageId,this.hythes);
        void this.runtime.receive(delivered.targetSessionId).catch(()=>{});
      }
      const message=getMessage(this.db,receipt.messageId);
      return {...receipt,state:message.state,hostRef:message.hostRef,automaticReplay:false};
    }
    if (principal.kind === "node") {
      const world = recordWorld(this.db, "nodes", principal.nodeId);
      if (p.worldId != null && p.worldId !== world) throw new SideraError("denied", "Cross-World RPC access is not supported");
      for (const [field, table] of Object.entries({nodeId:"nodes",targetNodeId:"nodes",centerNodeId:"nodes",workerNodeId:"nodes",
        ownerNodeId:"nodes",nextOwnerNodeId:"nodes",subjectNodeId:"nodes",responsibilityId:"responsibilities",parentResponsibilityId:"responsibilities",
        taskId:"tasks",runId:"task_runs",parentRunId:"task_runs",messageId:"messages",eventId:"events",escalationId:"events",targetSessionId:"sessions"}))
        if (p[field] != null) requireWorld(this.db, world, table, string(p[field],field));
      if (method === "intent.current") return new SemanticStore(this.db, world).currentIntent(string(p.intentId,"intentId"));
      if (method === "run.basis") return new SemanticStore(this.db, world).runBasis(string(p.runId,"runId"));
    }
    if(isConstitutionalMethod(method))return constitutionalRpc(this.db,principal,method,p);
    if(method==="world.inspect")return inspectWorld(this.db,principal,p);
    if(method==="work.inspect")return inspectWork(this.db,principal,p);
    if(method==="effects.query"||method==="effects.reconcile") {
      const allowed=(actor:string|null,resource:string)=>principal.kind==="human"||actor===principal.nodeId||canUseCapability(this.db,{
        subjectNodeId:principal.nodeId,sessionId:principal.sessionId,requestId:"effect-view",capability:method==="effects.query"?"effects.inspect":"effects.reconcile",resource});
      const effects=uncertainEffects(this.db).filter(e=>(principal.kind==="human" || (e.actorNodeId &&
        recordWorld(this.db,"nodes",e.actorNodeId)===recordWorld(this.db,"nodes",principal.nodeId))) && (allowed(e.actorNodeId,e.resource)||
        (method==="effects.query"&&principal.kind==="node"&&e.taskId&&this.db.prepare("SELECT 1 FROM tasks WHERE task_id=? AND (origin_node_id=? OR center_node_id=?)").get(e.taskId,principal.nodeId,principal.nodeId))));
      if(method==="effects.query")return {effects,derived:true,replayed:false};
      const effect=effects.find(e=>e.effectId===p.effectId);
      if(!effect)throw new SideraError("denied","Effect reconciliation outside Authority");
      const state=string(p.state,"state");
      if(!["OPEN_UNCERTAIN","OBSERVED_COMPLETED","OBSERVED_NOT_APPLIED","SUPERSEDED","HUMAN_ADJUDICATED"].includes(state))throw new SideraError("conflict","Invalid Effect resolution");
      if(!Array.isArray(p.evidenceEventIds)||!p.evidenceEventIds.every(e=>typeof e==="string")||!Number.isInteger(p.expectedRevision))throw new SideraError("conflict","Evidence IDs and revision required");
      if(principal.kind==="node")for(const id of p.evidenceEventIds){
        const world=recordWorld(this.db,"nodes",principal.nodeId),audit=this.db.prepare("SELECT world_id FROM effect_audit WHERE event_id=?").get(id);
        if(audit){if(audit.world_id!==world)throw new SideraError("denied","Effect evidence belongs to another World");}
        else requireWorld(this.db,world,"events",id);
      }
      return reconcileEffect(this.db,principal,{effectId:effect.effectId,state:state as EffectResolution,reason:string(p.reason,"reason"),
        evidenceEventIds:p.evidenceEventIds,expectedRevision:Number(p.expectedRevision)});
    }
    if (method === "node.rename") return renameNode(this.db, principal.kind === "human" ? principal :
      { nodeId: principal.nodeId, sessionId: principal.sessionId }, {
      requestId: string(p.requestId, "requestId"), nodeId: string(p.nodeId, "nodeId"),
      expectedDisplayName: string(p.expectedDisplayName, "expectedDisplayName"),
      displayName: string(p.displayName, "displayName"),
    });
    if (method === "chief.conversation_handoff") return handoffChiefConversation(this.db, principal, {
      requestId: string(p.requestId, "requestId"), expectedBindingId: string(p.expectedBindingId, "expectedBindingId"),
      conversationRef: string(p.conversationRef, "conversationRef"),
      frontendKind:p.frontendKind==null?undefined:string(p.frontendKind,"frontendKind"),
    });
    if (method === "task.get") {
      const view = getTask(this.db, string(p.taskId, "taskId"));
      if (principal.kind === "node" &&
          principal.nodeId !== view.task.originNodeId &&
          principal.nodeId !== view.task.centerNodeId &&
          !view.task.workerNodeIds.includes(principal.nodeId)) {
        throw new SideraError("denied", "Node is not a participant in this Task");
      }
      return view;
    }
    if (method === "history.event_get") {
      if (principal.kind !== "node")
        throw new SideraError("denied", "A Node Session is required");
      const eventId = string(p.eventId, "eventId");
      const event = this.db.prepare(`SELECT event_id AS eventId,
        actor_node_id AS actorNodeId, kind, payload, created_at AS createdAt
        FROM events WHERE event_id = ?`).get(eventId) as {
          eventId: string; actorNodeId: string | null; kind: string;
          payload: string; createdAt: string;
        } | undefined;
      if (!event) throw new SideraError("not_found", "Event was not found");
      let payload: Record<string, unknown>;
      try { payload = object(JSON.parse(event.payload)); }
      catch { throw new SideraError("unavailable", "Event payload is invalid"); }
      if (event.actorNodeId !== principal.nodeId &&
          payload.targetNodeId !== principal.nodeId)
        throw new SideraError("denied", "Event is outside this Node's observations");
      return { eventId, actorNodeId: event.actorNodeId,
        kind: event.kind, payload, createdAt: event.createdAt };
    }
    if (principal.kind !== "node") {
      throw new SideraError("denied", "This RPC requires a Node Session");
    }
    if(method==="artifact.get")return getArtifactReference(this.db,principal,string(p.artifactId,"artifactId"));
    if(method==="artifact.register")return registerArtifact(this.db,principal,p as unknown as ArtifactInput);
    if(method==="context.preview")return previewContextHandoff(this.db,principal,p as unknown as ContextHandoffInput);
    if(method==="context.get")return getContextHandoff(this.db,principal,string(p.handoffId,"handoffId"));
    if(method==="context.handoff") {
      const handoff=createContextHandoff(this.db,principal,p as unknown as ContextHandoffInput);
      if(!handoff.replay && handoff.messageId && handoff.transportState==="queued") {
        await deliverMessage(this.db,handoff.messageId,this.hythes);
        void this.runtime.receive(getMessage(this.db,handoff.messageId).targetSessionId).catch(()=>{});
      }
      return getContextHandoff(this.db,principal,handoff.handoffId);
    }
    if(method==="cooperation.start") {
      if(!this.runtime.ready || this.runtime.observationOnly)throw new SideraError("unavailable","Core is not accepting execution");
      const requestId=string(p.requestId,"requestId"),goal=string(p.goal,"goal"),rawBasis=object(p.basis);
      // A reusable Host may require a fresh Session before a new standalone
      // Supervisor turn. Prepare it before admission so the message is pinned
      // to the exact new Session from the moment it is created.
      const executionSessionId=this.prepareNodeWake?
        await this.prepareNodeWake(`cooperation:${requestId}`,principal.nodeId,principal.sessionId):principal.sessionId;
      const executionPrincipal={nodeId:principal.nodeId,sessionId:executionSessionId};
      const admitted=withTransaction(this.db,"cooperation_admission",()=>{
        const responsibilityId=rawBasis.responsibilityId==null?createResponsibility(this.db,{kind:"node",...executionPrincipal},{
          requestId:`cooperation:${requestId}`,title:goal.slice(0,160),scope:`cooperation/${requestId}`,ownerNodeId:principal.nodeId,
          basis:this.parseBasis(rawBasis,false)}).responsibilityId:string(rawBasis.responsibilityId,"responsibilityId");
        return startCooperation(this.db,executionPrincipal,{requestId,goal,basis:this.parseBasis({...rawBasis,responsibilityId},true)});
      });
      const receipt=admitted;
      // Only a fresh intent may cross the existing Bus Effect boundary. Reading
      // a queued/uncertain receipt after a restart does not replay the effect.
      if(!receipt.replay && receipt.state==="queued") {
        const message=getMessage(this.db,receipt.messageId);
        await deliverMessage(this.db,message.messageId,this.hythes);
        void this.runtime.receive(receipt.targetSessionId).catch(()=>{});
      }
      return {...receipt,state:getMessage(this.db,receipt.messageId).state};
    }
    if (method === "chief.status" || method === "project.list") {
      if (!this.chief?.isChief(principal.nodeId)) throw new SideraError("denied", "Chief binding required");
      if(method==="project.list")return this.chief.projects(principal.nodeId);
      const status={...await this.chief.status(principal, {
        conversationRef: p.conversationRef == null ? undefined : string(p.conversationRef, "conversationRef"),
        targetNodeId: p.targetNodeId == null ? undefined : string(p.targetNodeId, "targetNodeId"),
      }),buildIdentity:this.runtime.buildIdentity ?? null};
      // Core readiness is its own layer: a response served by Core proves Core
      // answered, and a degraded edge must never be reported as Core death.
      if(!this.runtime.ready)return {...status,available:false,state:"BLOCKED",core:{ready:false,state:"INITIALIZING"},runtimeMode:"initializing",message:"Core 正在初始化；尚不可派发。"};
      const targetNodeId = p.targetNodeId == null ? status.nodes.find(n=>n.state==="ready")?.nodeId : string(p.targetNodeId,"targetNodeId");
      const maintenance = this.runtime.maintenance(targetNodeId ? [{capability:"task.dispatch",resource:`node/${targetNodeId}`}] : undefined);
      // Readiness must use the same participant-scoped facts as dispatch. The
      // aggregate mesh cache is diagnostic; its age cannot block a freshly
      // observed legal pair. This neither renews Chat Presence nor prepares it.
      const admission=targetNodeId?await this.runtime.executionAdmission(principal.nodeId,targetNodeId,{projectRef:status.binding?.projectRef}):null;
      if (admission?.blocked) return {...status,available:false,state:"BLOCKED",
        maintenanceReasons:maintenance.reasons,observedAt:maintenance.observedAt,mesh:maintenance.mesh,
        reasons:[...status.reasons,...admission.reasons],runtimeMode:"maintenance",admission,
        message:`当前派发被阻断：${admission.reasons.join(",")}。不会切换到浏览器或要求 Human 搬运消息。`};
      return {...status,runtimeMode:status.available?"active":"blocked",mesh:maintenance.mesh,admission,
        aggregateObservation:{reasons:maintenance.reasons,observedAt:maintenance.observedAt}};
    }
    if (method === "chief.result_get") {
      if (!this.chief?.isChief(principal.nodeId)) throw new SideraError("denied", "Chief binding required");
      return this.chief.resultGet(principal, {
        conversationRef: p.conversationRef == null ? undefined : string(p.conversationRef, "conversationRef"),
        taskId: p.taskId == null ? undefined : string(p.taskId, "taskId"),
      });
    }
    if (method === "grant.list") {
      return listGrants(this.db, principal.nodeId);
    }
    if(method==="runtime.status")return {buildIdentity:this.runtime.buildIdentity ?? null,ready:this.runtime.ready,maintenance:this.runtime.maintenance()};
    if(method==="chief.frontend_prepare") {
      if(!this.chief?.isChief(principal.nodeId))throw new SideraError("denied","Chief binding required");
      const result=await this.chief.prepareFrontend(principal.nodeId);
      await this.runtime.activation?.refresh();return result;
    }
    if(method==="chief.presentation_observe" || method==="chief.presentation_correct") {
      if(!this.chief?.isChief(principal.nodeId))throw new SideraError("denied","Chief binding required");
      return method==="chief.presentation_observe"?this.chief.observePresentation(principal,string(p.messageId,"messageId")):
        this.chief.correctPresentation(principal,string(p.supervisionId,"supervisionId"));
    }
    if (method === "project.source_read") {
      if (!this.project) throw new SideraError("unavailable", "Project source surface is not configured");
      return readProjectSource(this.db,this.project,principal,{requestId:string(p.requestId,"requestId"),
        path:string(p.path,"path"), startLine:p.startLine==null?undefined:Number(p.startLine),
        lineCount:p.lineCount==null?undefined:Number(p.lineCount)});
    }
    if (method === "grant.delegate") {
      if(p.modelScope!==undefined&&p.modelScope!==null&&(!Array.isArray(p.modelScope)||p.modelScope.some(v=>typeof v!=="string"||!v.trim())))
        throw new SideraError("conflict","modelScope must contain exact ModelBinding model IDs");
      if(p.delegable!==undefined&&typeof p.delegable!=="boolean")throw new SideraError("conflict","delegable must be boolean");
      if(p.effectScope!==undefined&&p.effectScope!=="admission"&&p.effectScope!=="post_admission_revocable")throw new SideraError("conflict","Invalid Effect scope");
      return issueGrant(this.db, { kind: "node", nodeId: principal.nodeId }, {
        requestId: string(p.requestId, "requestId"),
        parentGrantId: string(p.parentGrantId, "parentGrantId"),
        subjectNodeId: string(p.subjectNodeId, "subjectNodeId"),
        capability: string(p.capability, "capability"),
        resourceScope: string(p.resourceScope, "resourceScope"),
        limit: p.limit === undefined ? undefined : p.limit===null?null:Number(p.limit),
        expiresAt: p.expiresAt === undefined ? undefined : p.expiresAt===null?null:string(p.expiresAt, "expiresAt"),
        delegable: p.delegable == null ? undefined : p.delegable === true,
        riskCeiling: p.riskCeiling === undefined ? undefined : p.riskCeiling===null?null:Number(p.riskCeiling),
        validFrom:p.validFrom===undefined?undefined:p.validFrom===null?null:string(p.validFrom,"validFrom"),
        worldId:p.worldId==null?undefined:string(p.worldId,"worldId"),
        projectRef:p.projectRef===undefined?undefined:p.projectRef===null?null:string(p.projectRef,"projectRef"),
        taskRef:p.taskRef===undefined?undefined:p.taskRef===null?null:string(p.taskRef,"taskRef"),
        modelScope:p.modelScope as string[]|null|undefined,
        maxDelegationDepth:p.maxDelegationDepth===undefined?undefined:p.maxDelegationDepth===null?null:Number(p.maxDelegationDepth),
        productScope:p.productScope===undefined?undefined:string(p.productScope,"productScope"),
        effectScope:p.effectScope as "admission"|"post_admission_revocable"|undefined,
        disclosureScope:p.disclosureScope===undefined?undefined:string(p.disclosureScope,"disclosureScope"),
      });
    }
    if (method === "role.appoint") {
      return appointRole(this.db, principal, {
        requestId: string(p.requestId, "requestId"),
        subjectNodeId: string(p.subjectNodeId, "subjectNodeId"),
        role: string(p.role, "role"),
        scope: p.scope == null ? undefined : string(p.scope, "scope"),
        expiresAt: p.expiresAt == null ? undefined : string(p.expiresAt, "expiresAt"),
      });
    }
    if (method === "role.list") return listRoles(this.db, principal.nodeId);
    if (method === "responsibility.defer") return deferResponsibility(this.db, principal, {
      requestId: string(p.requestId, "requestId"), responsibilityId: string(p.responsibilityId, "responsibilityId"), reason: string(p.reason, "reason"),
    });
    if (method === "escalation.defer") return deferEscalation(this.db, principal, {
      requestId: string(p.requestId, "requestId"), escalationId: string(p.escalationId, "escalationId"), reason: string(p.reason, "reason"),
    });
    if (method === "responsibility.create") {
      const input = {
        requestId: string(p.requestId, "requestId"),
        title: string(p.title, "title"), scope: string(p.scope, "scope"),
        ownerNodeId: string(p.ownerNodeId, "ownerNodeId"),
        basis: p.basis == null ? undefined : this.parseBasis(p.basis, false),
        parentResponsibilityId: p.parentResponsibilityId == null ? undefined :
          string(p.parentResponsibilityId, "parentResponsibilityId"),
      };
      if (this.chief?.isChief(principal.nodeId)) return this.chief.action(principal, {
        requestId: input.requestId, targetNodeId: input.ownerNodeId,
        capability: input.ownerNodeId === principal.nodeId ? "self.responsibility.create" : "responsibility.create",
        conversationRef: p.frontendConversationRef == null ? undefined : string(p.frontendConversationRef, "frontendConversationRef"),
        payload: { method, ...input },
      }, () => ({ ...createResponsibility(this.db, principal, input) }));
      return createResponsibility(this.db, principal, input);
    }
    if (method === "responsibility.get") {
      return getResponsibility(this.db, string(p.responsibilityId, "responsibilityId"));
    }
    if (method === "responsibility.list") {
      return listResponsibilities(this.db, { ownerNodeId: principal.nodeId });
    }
    if (method === "responsibility.transfer") {
      return transferResponsibility(this.db, principal, {
        requestId: string(p.requestId, "requestId"),
        responsibilityId: string(p.responsibilityId, "responsibilityId"),
        nextOwnerNodeId: string(p.nextOwnerNodeId, "nextOwnerNodeId"),
        expectedOwnerNodeId: string(p.expectedOwnerNodeId, "expectedOwnerNodeId"),
      });
    }
    if (method === "responsibility.complete") {
      return completeResponsibility(this.db, principal, {
        requestId: string(p.requestId, "requestId"),
        responsibilityId: string(p.responsibilityId, "responsibilityId"),
        expectedOwnerNodeId: string(p.expectedOwnerNodeId, "expectedOwnerNodeId"),
        closureBasis:p.closureBasis as Parameters<typeof completeResponsibility>[2]["closureBasis"],
      });
    }
    if (method === "responsibility.accept") return acceptResponsibility(this.db, principal, {
      requestId: string(p.requestId, "requestId"), responsibilityId: string(p.responsibilityId, "responsibilityId"),
    });
    if (method === "tension.list") return listTensions(this.db, principal.nodeId, p.actionableOnly === true,
      p.limit == null ? 32 : Number(p.limit));
    if (method === "tension.register" || method === "tension.update") return mutateTension(this.db, principal, {
      requestId: string(p.requestId, "requestId"),
      tensionId: method === "tension.update" ? string(p.tensionId, "tensionId") : undefined,
      kind: p.kind == null ? undefined : string(p.kind, "kind") as TensionKind,
      statement: p.statement == null ? undefined : string(p.statement, "statement"),
      sourceRefs: p.sourceRefs == null ? undefined : p.sourceRefs as SourceRef[],
      status: p.status == null ? undefined : string(p.status, "status") as TensionStatus,
    });
    if (method === "runtime.checkpoint") return this.runtime.continuations.checkpoint(principal, {
      requestId: string(p.requestId, "requestId"), runId: string(p.runId, "runId"),
      outcome: string(p.outcome, "outcome") as "CONTINUE" | "WAIT" | "IDLE",
      tensionId: p.tensionId == null ? undefined : string(p.tensionId, "tensionId"),
      checkpoint: string(p.checkpoint, "checkpoint"), progressRefs: p.progressRefs as SourceRef[] | undefined,
    });
    if (method === "escalation.raise") {
      return raiseEscalation(this.db, principal, {
        requestId: string(p.requestId, "requestId"),
        reason: string(p.reason, "reason"), details: string(p.details, "details"),
        responsibilityId: p.responsibilityId == null ? undefined :
          string(p.responsibilityId, "responsibilityId"),
      });
    }
    const context = (resourceScope: string) => ({
      actorNodeId: principal.nodeId, actorSessionId: principal.sessionId,
      requestId: string(p.requestId, "requestId"), resourceScope,
    });
    if (method === "capability.invoke") return invokeCapability(this.db,this.hythes,principal,{
      requestId:string(p.requestId,"requestId"),targetNodeId:string(p.targetNodeId,"targetNodeId"),
      operation:string(p.operation,"operation"),input:object(p.input ?? {}),
      expectedSessionId:p.expectedSessionId == null ? undefined:string(p.expectedSessionId,"expectedSessionId")});
    if (method === "resource.put" || method === "resource.get" || method === "resource.list" || method === "resource.scope") {
      if (principal.kind !== "node") throw new SideraError("denied", "Resources are published and read by Node Sessions");
      if (!this.project) throw new SideraError("unavailable", "Resource store is not configured for this Core");
      if (method === "resource.put") return putResource(this.db, this.project, principal, {
        requestId: string(p.requestId, "requestId"), name: string(p.name, "name"),
        mediaType: p.mediaType == null ? null : string(p.mediaType, "mediaType"),
        origin: p.origin == null ? "node" : string(p.origin, "origin") as "human" | "node" | "host" | "local-operator",
        sourceRef: p.sourceRef == null ? null : string(p.sourceRef, "sourceRef"),
        taskId: p.taskId == null ? null : string(p.taskId, "taskId"),
        runId: p.runId == null ? null : string(p.runId, "runId"),
        dataBase64: p.dataBase64 == null ? null : string(p.dataBase64, "dataBase64"),
        dataText: p.dataText == null ? null : String(p.dataText),
        artifactId: p.artifactId == null ? null : string(p.artifactId, "artifactId"),
      });
      if (method === "resource.get") return readResource(this.db, this.project, principal,
        string(p.resourceId, "resourceId"), { asBase64: p.asBase64 === true });
      if (method === "resource.list") return listResources(this.db, principal, {
        taskId: p.taskId == null ? undefined : string(p.taskId, "taskId"),
        runId: p.runId == null ? undefined : string(p.runId, "runId"),
        limit: p.limit == null ? undefined : Number(p.limit),
      });
      return scopeResource(this.db, principal, { requestId: string(p.requestId, "requestId"),
        resourceId: string(p.resourceId, "resourceId"), targetNodeId: string(p.targetNodeId, "targetNodeId"),
        basis: string(p.basis, "basis") });
    }
    if (method === "resource.metadata") {
      if (principal.kind !== "node") throw new SideraError("denied", "Resources are read by Node Sessions");
      return resourceMetadata(this.db, principal, string(p.resourceId, "resourceId"));
    }
    if (method === "host.control") {
      return controlHost(this.db, this.hythes, principal, {
        requestId: string(p.requestId, "requestId"),
        targetSessionId: string(p.targetSessionId, "targetSessionId"),
        operation: string(p.operation, "operation"), input: object(p.input ?? {}),
      });
    }
    if(method==="executor.admit") {
      const sessionId=string(p.sessionId,"sessionId"),session=this.registry.getSession(sessionId);
      if(session.nodeId!==principal.nodeId)throw new SideraError("denied","Only the Operator may admit its runtime context");
      const hythe=this.hythes.get(session.hytheId);
      if(!hythe||hythe.hostKind!==session.hostKind||!hythe.capabilities().includes("message.receive")||!hythe.effectProfile?.("message.receive")||
        hythe.manifest?.().operations.some(op=>op.supported&&op.routeClass==="ui-fallback")||!await hythe.locate(session.locatorRef))
        throw new SideraError("unavailable","Exact non-browser Host and real Effect profile must be usable before Executor admission");
      const permit=reserveCapability(this.db,{subjectNodeId:principal.nodeId,sessionId:principal.sessionId,capability:"self.session.activate",
        resource:`node/${principal.nodeId}`,requestId:string(p.requestId,"requestId")});
      try {const result=admitExecutorRuntime(this.db,{operatorNodeRef:principal.nodeId,sessionId,reviewRef:string(p.reviewRef,"reviewRef")});
        if(permit.reservationId)settleReservation(this.db,permit.reservationId,"consumed");void this.runtime.receive(sessionId).catch(()=>{});return result;
      }catch(error){if(permit.reservationId)settleReservation(this.db,permit.reservationId,"released");throw error;}
    }
    if (["task.submit","chief.dispatch","task.dispatch","task.delegate"].includes(method)) {
      if(!this.runtime.ready)throw new SideraError("unavailable","Core is initializing; no Task admitted");
      const targetNodeId=string(p.centerNodeId ?? p.workerNodeId,"centerNodeId");
      requireWorld(this.db,recordWorld(this.db,"nodes",principal.nodeId),"nodes",targetNodeId);
      // Idempotent replay preserves the original exact context and never probes a replacement.
      const original=this.db.prepare("SELECT m.target_session_id FROM tasks t JOIN messages m ON m.task_id=t.task_id WHERE t.origin_node_id=? AND t.request_id=? AND m.kind='task' ORDER BY m.sequence LIMIT 1")
        .get(principal.nodeId,string(p.requestId,"requestId"));
      const operator=readNodeOntology(this.db,targetNodeId).kind==="Operator";
      if(operator&&!original){
        const exact=p.targetSessionId==null?undefined:string(p.targetSessionId,"targetSessionId");
        const stale=executorPool(this.db,targetNodeId).filter(e=>(!exact||e.runtimeSessionId===exact)&&
          !readSessionHostCondition(this.db,e.runtimeSessionId).canExecute);
        await Promise.all(stale.map(e=>probeHostHealth(this.db,this.hythes,e.runtimeSessionId,"dispatch-exact-host-reprobe")));
      }
      const chosen=operator?selectDispatchExecutor(this.db,{operatorNodeRef:targetNodeId,
        targetSessionId:p.targetSessionId==null?undefined:string(p.targetSessionId,"targetSessionId")}):null;
      if(chosen&&chosen.state!=="selected"&&!original&&!this.chief?.isChief(principal.nodeId))throw new SideraError("unavailable",chosen.reason);
      const targetSessionId=original?String(original.target_session_id):chosen?.state==="selected"?chosen.executor.runtimeSessionId:p.targetSessionId==null?undefined:string(p.targetSessionId,"targetSessionId");
      const binding=this.chief?.binding(principal.nodeId);
      const inheritedProject=typeof p.parentRunId==="string"?this.db.prepare("SELECT c.project_ref FROM task_runs r JOIN task_rule_context c USING(task_id) WHERE r.run_id=?").get(p.parentRunId)?.project_ref:null;
      const requestedProject=p.projectRef==null?undefined:string(p.projectRef,"projectRef");
      const projectRef=inheritedProject?String(inheritedProject):binding
        ?(requestedProject===undefined||requestedProject===binding.projectSpaceId?binding.projectRef:requestedProject)
        :requestedProject;
      if(binding&&!p.parentRunId&&projectRef!==binding.projectRef)throw new SideraError("denied","Task Project must match the exact Chief Conversation binding");
      const maintenance=await this.runtime.executionAdmission(principal.nodeId,targetNodeId,{callerSessionId:principal.sessionId,targetSessionId,projectRef});
      if(maintenance.blocked) throw new SideraError("unavailable",
        `Sidera unavailable: ${maintenance.reasons.join(",")}`);
      const input = {
        requestId: string(p.requestId, "requestId"), originNodeId: principal.nodeId,
        originSessionId: principal.sessionId, centerNodeId: string(p.centerNodeId ?? p.workerNodeId, "centerNodeId"),
        workerNodeIds: [], body: string(p.body, "body"),
        targetSessionId,projectRef,
        basis: p.basis == null ? undefined : this.parseBasis(p.basis, true),
        supervisionId:p.supervisionId==null?undefined:string(p.supervisionId,"supervisionId"),
      };
      let observationRoot=false;
      if(input.supervisionId){const s=supervisionView(this.db,input.supervisionId);
        if(p.parentRunId){
          const observation=this.db.prepare(`SELECT r.session_id,b.responsibility_id FROM task_runs r JOIN runtime_event_tasks e USING(task_id)
            JOIN task_bases b USING(task_id) WHERE r.run_id=? AND r.turn_open=1`).get(string(p.parentRunId,"parentRunId"));
          const responsibility=this.db.prepare("SELECT responsibility_id FROM supervisions WHERE supervision_id=?").get(input.supervisionId);
          observationRoot=observation?.session_id===principal.sessionId && !!responsibility?.responsibility_id &&
            observation.responsibility_id===responsibility.responsibility_id;
        }
        if(s.chiefNodeId!==principal.nodeId || p.parentRunId&&!observationRoot)
          throw new SideraError("denied","Supervised root dispatch belongs to its supervising Node");
        if(!["running","reconciling"].includes(s.state))throw new SideraError("conflict","Supervision is not ready for new work");
        const unfinished=this.db.prepare(`SELECT 1 FROM supervision_tasks st
          JOIN tasks t USING(task_id)
          LEFT JOIN supervision_rounds r ON r.supervision_id=st.supervision_id AND r.task_id=st.task_id
          WHERE st.supervision_id=? AND (
            t.state NOT IN ('completed','failed') OR
            (t.state='failed' AND (r.state IS NULL OR r.state!='decided'))
          )`).get(input.supervisionId);
        if(unfinished)throw new SideraError("conflict","Prior supervised task requires completion/reconciliation");
        const count=Number(this.db.prepare("SELECT count(*) n FROM supervision_tasks WHERE supervision_id=?").get(input.supervisionId)!.n);
        if(count>=s.maxRounds){this.db.prepare("UPDATE supervisions SET state='budget_exhausted',updated_at=? WHERE supervision_id=?").run(new Date().toISOString(),input.supervisionId);throw new SideraError("conflict","Supervision round budget exhausted; durable execution checkpoint");}
      }
      // An event observation merely woke the accountable Supervisor. Its owned
      // supervision is independent work, not a child dependency of the wake.
      const parent = p.parentRunId == null || observationRoot ? undefined : {
        runId: string(p.parentRunId, "parentRunId"), checkpoint: string(p.checkpoint, "checkpoint"),
      };
      if (method === "chief.dispatch" && (!this.chief || parent))
        throw new SideraError("conflict", "Chief root dispatch requires configured binding and no parent Run");
      if (method === "chief.dispatch" && !this.chief?.isChief(principal.nodeId))
        throw new SideraError("denied", "Chief root dispatch is reserved for the bound Chief");
      const submitted = !parent && this.chief?.isChief(principal.nodeId) ?
        await this.chief.action(principal, { requestId: input.requestId, targetNodeId: input.centerNodeId,targetSessionId,
          conversationRef: p.frontendConversationRef == null ? undefined : string(p.frontendConversationRef, "frontendConversationRef"),
          capability: "task.dispatch", payload: { method: "task.submit", ...input } },
          () => this.runtime.continuations.submit(input)) : withTransaction(this.db,"supervised_submit",()=>{
            const result=this.runtime.continuations.submit(input,parent);
            if(input.supervisionId)linkTaskToSupervision(this.db,{supervisionId:input.supervisionId,taskId:result.task.taskId,agentNodeId:input.centerNodeId});
            return result;
          });
      if (method === "task.dispatch" && submitted.state !== "BLOCKED") {
        await this.runtime.continuations.pump();
        const managed = submitted as {task:{taskId:string};run:{message_id:string}};
        return {...submitted,firstMessage:getMessage(this.db,managed.run.message_id)};
      }
      // Return durable acceptance immediately. Never await a child Agent's result.
      setImmediate(() => { void this.runtime.continuations.pump().catch(() => {
        process.stderr.write("Continuation scheduler needs reconciliation\n");
      }); });
      return submitted;
    }
    if(method==="message.reconcile_result") {
      const messageId=string(p.messageId,"messageId"),message=getMessage(this.db,messageId);
      if(message.targetSessionId!==principal.sessionId)throw new SideraError("denied","Only the original receiving Session may reconcile");
      const permit=reserveCapability(this.db,{subjectNodeId:principal.nodeId,sessionId:principal.sessionId,capability:"self.task.reconcile",
        resource:`node/${principal.nodeId}/runtime`,requestId:string(p.requestId,"requestId")});
      try{const result=await this.runtime.reconcileStandaloneResult(principal.sessionId,messageId);
        settleReservation(this.db,permit.reservationId!,"consumed");return result;}
      catch(error){if(this.db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(permit.reservationId)?.status==="reserved")settleReservation(this.db,permit.reservationId!,"released");throw error;}
    }
    if(method==="task.reconcile_result") {
      const run=this.runtime.continuations.run(string(p.runId,"runId"));
      if(run.session_id!==principal.sessionId)throw new SideraError("denied","Only the original executing Session may reconcile its result");
      const permit=reserveCapability(this.db,{subjectNodeId:principal.nodeId,sessionId:principal.sessionId,capability:"self.task.reconcile",
        resource:`node/${principal.nodeId}/runtime`,requestId:string(p.requestId,"requestId")});
      try{await this.runtime.continuations.reconcileCompletedResult(run.run_id);if(permit.reservationId)settleReservation(this.db,permit.reservationId,"consumed");}
      catch(error){if(permit.reservationId)settleReservation(this.db,permit.reservationId,"released");throw error;}
      return getTask(this.db,run.task_id);
    }
    if (method === "task.result") {
      return acceptGptResult(this.db, this.hythes, principal, {
        requestId: string(p.requestId, "requestId"), runId: string(p.runId, "runId"),
        messageId: string(p.messageId, "messageId"), body: string(p.body, "body"),
      });
    }
    if (method === "peregrine.write_e2e_marker") {
      if (!this.peregrines) throw new SideraError("unavailable", "Peregrine is unavailable");
      return writeE2EMarker(this.db, this.peregrines, principal,
        string(p.messageId, "messageId"));
    }
    if (method === "peregrine.write_text") {
      if (!this.peregrines) throw new SideraError("unavailable", "Peregrine is unavailable");
      return writeOwnedText(this.db, this.peregrines, principal, {
        requestId: string(p.requestId, "requestId"),
        fileName: string(p.fileName, "fileName"), content: string(p.content, "content"),
        mode: p.mode == null ? "create" : string(p.mode, "mode") as "create" | "replace",
        expectedContent: p.expectedContent == null ? undefined :
          string(p.expectedContent, "expectedContent"),
      });
    }
    if (method === "peregrine.read_text") {
      if (!this.peregrines) throw new SideraError("unavailable", "Peregrine is unavailable");
      return readOwnedText(this.db, this.peregrines, principal,
        string(p.fileName, "fileName"));
    }
    if (method === "model.get") return this.identities.currentModel(principal.nodeId);
    if (method === "model.bind") {
      return this.identities.bindModel(principal, string(p.requestId, "requestId"), {
        provider: string(p.provider, "provider"), modelId: string(p.modelId, "modelId"),
        reasoningConfig: object(p.reasoningConfig ?? {}),
      });
    }
    if (method === "model.migrate") {
      return this.identities.migrateModel(principal, string(p.requestId, "requestId"),
        string(p.expectedBindingId, "expectedBindingId"), {
          provider: string(p.provider, "provider"), modelId: string(p.modelId, "modelId"),
          reasoningConfig: object(p.reasoningConfig ?? {}),
        });
    }
    if (method === "node.fork") {
      return this.identities.forkNode(principal, string(p.requestId, "requestId"),
        string(p.displayName, "displayName"),
        string(p.expectedSelfHead, "expectedSelfHead"));
    }
    if (method === "node.lineage") return this.identities.lineage(principal.nodeId);
    if (method === "subjectivity.get")
      return getSubjectivity(this.db, principal.nodeId);
    if (method === "subjectivity.revise")
      return reviseSubjectivity(this.db, principal, {
        requestId: string(p.requestId, "requestId"),
        expectedRevision: Number(p.expectedRevision),
        description: string(p.description, "description"),
        explanation: string(p.explanation, "explanation"),
      });
    if (method === "memory.get") {
      return this.identities.memory(principal.nodeId, string(p.key, "key"));
    }
    if (method === "memory.put") {
      return this.identities.putMemory(principal, string(p.requestId, "requestId"),
        string(p.key, "key"), p.value);
    }
    if (method === "self.state.get") return this.registry.getNode(principal.nodeId).selfState;
    if (method === "self.state.set") {
      return this.identities.setSelfState(principal, string(p.requestId, "requestId"),
        object(p.state));
    }
    if (method === "node.get") {
      const nodeId = string(p.nodeId, "nodeId");
      if (nodeId !== principal.nodeId) throw new SideraError("denied", "Node is outside caller domain");
      return this.registry.getNode(nodeId);
    }
    if(method==="node.create") {const result=this.registry.createNode(context("nodes"),string(p.displayName,"displayName"));return {nodeId:result.nodeId,displayName:result.displayName,lifecycle:result.lifecycle};}
    if(method==="node.retire") {const id=string(p.nodeId,"nodeId"),result=this.registry.retireNode(context(`node/${id}`),id);return {nodeId:result.nodeId,displayName:result.displayName,lifecycle:result.lifecycle};}
    if (method === "session.active") return this.registry.getActiveSession(principal.nodeId);
    if (method === "session.get") {
      const session = this.registry.getSession(string(p.sessionId, "sessionId"));
      if (session.nodeId !== principal.nodeId) throw new SideraError("denied", "Session is outside caller domain");
      return session;
    }
    if (method === "session.bind") {
      return this.registry.bindSession(context(`node/${principal.nodeId}`), {
        nodeId: principal.nodeId,
        hytheId: string(p.hytheId, "hytheId"),
        hostKind: string(p.hostKind, "hostKind"),
        locatorRef: string(p.locatorRef, "locatorRef"),
        state: "standby",
      });
    }
    if (method === "session.handoff") {
      return this.registry.handoffSession(context(`node/${principal.nodeId}`),
        principal.nodeId, string(p.nextSessionId, "nextSessionId"), principal.sessionId);
    }
    if (method === "session.close") {
      return this.registry.closeSession(context(`node/${principal.nodeId}`),
        principal.nodeId, string(p.sessionId, "sessionId"));
    }
    if (method === "message.send") {
      const message = sendMessage(this.db, {
        requestId: string(p.requestId, "requestId"),
        fromNodeId: principal.nodeId,
        fromSessionId: principal.sessionId,
        toNodeId: string(p.toNodeId, "toNodeId"),
        taskId: p.taskId == null ? null : string(p.taskId, "taskId"),
        kind: string(p.kind, "kind"),
        body: string(p.body, "body"),
      });
      return deliverMessage(this.db, message.messageId, this.hythes);
    }
    if (method === "message.ack") {
      return ackMessage(this.db, string(p.messageId, "messageId"), principal.sessionId);
    }
    if (method === "task.complete") {
      const run = this.db.prepare("SELECT run_id,message_id FROM task_runs WHERE task_id=? AND session_id=? AND turn_open=1")
        .get(string(p.taskId,"taskId"),principal.sessionId) as {run_id:string;message_id:string} | undefined;
      if (!run) throw new SideraError("conflict","No exact executing Run to complete");
      return acceptGptResult(this.db,this.hythes,principal,{requestId:string(p.requestId,"requestId"),
        runId:run.run_id,messageId:run.message_id,body:string(p.body,"body")});
    }
    if (method === "supervision.open") {
      const world = recordWorld(this.db, "nodes", principal.nodeId);
      const requestId=string(p.requestId,"requestId"),fingerprint=JSON.stringify(p);
      const prior=this.db.prepare("SELECT payload FROM events WHERE actor_node_id=? AND kind='supervision.opened' AND json_extract(payload,'$.requestId')=?").get(principal.nodeId,requestId);
      if(prior){const old=JSON.parse(String(prior.payload));if(old.fingerprint!==fingerprint)throw new SideraError("conflict","Supervision requestId reused");return {supervisionId:old.supervisionId,view:supervisionView(this.db,old.supervisionId)};}
      reserveCapability(this.db,{subjectNodeId:principal.nodeId,sessionId:principal.sessionId,requestId,capability:"self.supervision.open",resource:`node/${principal.nodeId}/supervision`});
      if(p.responsibilityId){const responsibility=getResponsibility(this.db,string(p.responsibilityId,"responsibilityId"));
        if(responsibility.ownerNodeId!==principal.nodeId||responsibility.acceptance!=="accepted"||responsibility.state!=="active")throw new SideraError("denied","Supervision needs an accepted active owned Responsibility");}
      const supervisionId = openSupervision(this.db, { worldId: world, chiefNodeId: principal.nodeId,
        responsibilityId: p.responsibilityId == null ? null : string(p.responsibilityId, "responsibilityId"),
        goal: string(p.goal, "goal"), acceptanceCriteria: string(p.acceptanceCriteria, "acceptanceCriteria"),
        maxRounds: p.maxRounds == null ? undefined : Number(p.maxRounds) });
      this.db.prepare("INSERT INTO events VALUES (?,?,'supervision.opened',?,?)").run(randomUUID(),principal.nodeId,JSON.stringify({requestId,fingerprint,supervisionId}),new Date().toISOString());
      return { supervisionId, view: supervisionView(this.db, supervisionId) };
    }
    if (method === "supervision.view") {
      const view = supervisionView(this.db, string(p.supervisionId, "supervisionId"));
      if (principal.kind === "node" && view.chiefNodeId !== principal.nodeId)
        throw new SideraError("denied", "Supervision belongs to another supervising Node");
      return view;
    }
    if (method === "supervision.decide") {
      if (!this.chief) throw new SideraError("unavailable", "Chief dispatch is not configured");
      return this.chief.decide(principal, { supervisionId: string(p.supervisionId, "supervisionId"),
        roundIndex: Number(p.roundIndex), decision: string(p.decision, "decision"),
        reason: string(p.reason, "reason"),
        waitForEvent:p.waitForEvent==null?undefined:string(p.waitForEvent,"waitForEvent"),
        nextNodeId:p.nextNodeId==null?undefined:string(p.nextNodeId,"nextNodeId"),
        instruction: p.instruction == null ? undefined : string(p.instruction, "instruction") });
    }
    throw new SideraError("not_found", "Unknown RPC method");
  }
}

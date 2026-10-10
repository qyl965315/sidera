import { randomUUID } from "node:crypto";
import { recordWorld, requireWorld } from "./worlds.ts";
import type { DatabaseSync } from "node:sqlite";
import { canUseCapability, reserveCapability,settleReservation } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import type { Hythe, InvokeResult } from "../hythes/types.ts";
import { boundaryEvent } from "./boundary.ts";
import { latestFrontendPresence } from "./frontend-presence.ts";
import { invalidateFrontendRoute } from "./frontend-route.ts";
import { onCommittedEvent } from "./db.ts";
import { decideSupervision, recordRound, supervisionForTask, linkTaskToSupervision, supervisionView } from "./supervision.ts";
import { consumeHumanAct } from "./human-admission.ts";
import { enqueueMessage } from "./bus.ts";
import { SemanticStore } from "./semantics.ts";
import { prepareEffect,effectBoundary,effectKnowledge,observeEffect,abandonPreparedEffect,type EffectBoundary,type EffectControlProfile } from "./effect-gate.ts";
import { syncChiefConversation,readNodeOntology } from "./ontology.ts";
import { selectDispatchExecutor,isExecutorRuntimeSession } from "./executors.ts";
import { R1_BOOTSTRAP_GOVERNANCE } from "./constitution.ts";
import { probeHostHealth } from "./host-health.ts";

export interface ChiefBinding {
  bindingId: string; projectSpaceId: string; projectRef: string;
  /** @deprecated Compatibility storage alias for the owning Communicator NodeRef; Chief is a Conversation role. */
  chiefNodeId: string; frontendKind: string; conversationRef: string; state: string;
}
export function canonicalChiefBinding(binding:ChiefBinding) {
  return {bindingId:binding.bindingId,projectSpaceId:binding.projectSpaceId,projectRef:binding.projectRef,
    communicatorNodeRef:binding.chiefNodeId,conversationRef:binding.conversationRef,
    role:"ChiefConversation" as const,frontendKind:binding.frontendKind,state:binding.state};
}
type Caller = { nodeId: string; sessionId: string };
export interface ChiefFrontend {
  /** Pure read: restore a prepared route. Never opens a UI or sends. */
  restore?(binding: ChiefBinding): { state: string; routeId: string | null; routeClass?: string | null; controlProfile?: { id: string } | null; preparedAt?: string | null; invalidAfter?: string | null; evidenceRef?: string | null; method?: string | null } | null;
  /** Select and record a declared outbound route. Browser-free. */
  prepare?(binding: ChiefBinding): { prepared: boolean; routeId: string | null; reason: string };
  verifyPresence?(binding:ChiefBinding):Promise<{prepared:boolean;routeId:string|null;reason:string}>;
  observePresentation?(binding:ChiefBinding,messageId:string):Promise<true|"unknown">;
  effectProfile?(binding?:ChiefBinding):EffectControlProfile|undefined;
  inspect(binding: ChiefBinding): Promise<{ ready: boolean; reason: string; observation?:unknown; routes?:unknown }>;
  deliver(binding: ChiefBinding, message: { messageId: string; body: string }, boundary?:EffectBoundary): Promise<InvokeResult>;
  ingress?(binding?:ChiefBinding): Record<string, unknown>;
  close?(): Promise<void>;
}
function bindingRow(row: Record<string, unknown>): ChiefBinding {
  return { bindingId: String(row.binding_id), projectSpaceId: String(row.project_space_id),
    projectRef: String(row.project_ref), chiefNodeId: String(row.chief_node_id),
    frontendKind: String(row.frontend_kind), conversationRef: String(row.conversation_ref), state: String(row.state) };
}

/** Core validates an address, not a vendor URL. The registered adapter proves exact Host identity. */
function exactConversation(kind:string,ref:string):boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(kind) && ref.length<=4096 && !/[\r\n\s]/.test(ref) && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\/.+/.test(ref);
}
/** Human selects an existing frontend. This never creates a Chat or a Node Session. */
export function bindChiefConversation(db: DatabaseSync, actor: { kind: string; id?: string; actId?:string },
  input: Omit<ChiefBinding, "bindingId" | "state">): ChiefBinding {
  if (actor.kind !== "human") throw new SideraError("denied", "Only Human may select the Chief Conversation");
  if (Object.values(input).some(value => typeof value !== "string" || !value.trim()))
    throw new SideraError("conflict", "Chief binding must be explicit");
  if (!exactConversation(input.frontendKind,input.conversationRef))
    throw new SideraError("conflict", "Unsupported or non-exact Human Conversation");
  return withTransaction(db, "chief_bind", () => {
    if (!db.prepare("SELECT 1 FROM nodes WHERE node_id=? AND lifecycle='active'").get(input.chiefNodeId))
      throw new SideraError("not_found", "Owning Communicator is unavailable");
    const old = db.prepare("SELECT * FROM chief_conversations WHERE project_space_id=? AND state='active'")
      .get(input.projectSpaceId) as Record<string, unknown> | undefined;
    if (old) {
      const bound = bindingRow(old);
      if (Object.entries(input).every(([key, value]) => bound[key as keyof ChiefBinding] === value)) return bound;
      // Selecting a replacement must be a separate Human action; startup cannot repoint pending results.
      throw new SideraError("conflict", "Chief Conversation already bound; explicit Human handoff required");
    }
    consumeHumanAct(db,{id:actor.id??"",actId:actor.actId},recordWorld(db,"nodes",input.chiefNodeId),"chief.bind",input.chiefNodeId,input.projectSpaceId,input);
    return insertChiefBinding(db,actor.id!,input);
  });
}
function insertChiefBinding(db:DatabaseSync,humanId:string,input:Omit<ChiefBinding,"bindingId"|"state">):ChiefBinding {
    const bindingId = randomUUID(), at = new Date().toISOString();
    db.prepare("INSERT INTO chief_conversations VALUES (?, ?, ?, ?, ?, ?, 'active', ?)")
      .run(bindingId, input.projectSpaceId, input.projectRef, input.chiefNodeId,
        input.frontendKind, input.conversationRef, at);
    db.prepare("INSERT INTO events VALUES (?, NULL, 'chief.conversation_bound', ?, ?)")
      .run(randomUUID(), JSON.stringify({ bindingId, ...input, issuer: `human:${humanId}` }), at);
    syncChiefConversation(db,db.prepare("SELECT * FROM chief_conversations WHERE binding_id=?").get(bindingId)!);
    return { bindingId, ...input, state: "active" };
}

/** Explicit Human replacement; Task provenance retains the original binding, while unsent results use the current admitted binding. */
export function handoffChiefConversation(db: DatabaseSync, actor: { kind: string; id?: string; actId?:string }, input: {
  requestId: string; expectedBindingId: string; conversationRef: string; frontendKind?:string;
}): ChiefBinding {
  if (actor.kind !== "human") throw new SideraError("denied", "Only Human may replace the Chief Conversation");
  if (!input.requestId || !input.expectedBindingId ||
      !exactConversation(input.frontendKind??"existing",input.conversationRef))
    throw new SideraError("conflict", "Explicit exact Conversation and prior binding required");
  const issuer = `human:${actor.id ?? "project-manager"}`, fingerprint = JSON.stringify(input);
  return withTransaction(db, "chief_handoff", () => {
    const previous = db.prepare(`SELECT payload FROM events WHERE kind='chief.conversation_handoff'
      AND json_extract(payload,'$.issuer')=? AND json_extract(payload,'$.requestId')=?`)
      .get(issuer, input.requestId) as { payload: string } | undefined;
    if (previous) {
      const record = JSON.parse(previous.payload);
      if (record.fingerprint !== fingerprint) throw new SideraError("conflict", "Chief handoff request ID reused");
      return record.result;
    }
    const old = db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND state='active'")
      .get(input.expectedBindingId) as Record<string, unknown> | undefined;
    if (!old) throw new SideraError("conflict", "Chief binding changed before Human handoff");
    const prior = bindingRow(old);
    if (prior.conversationRef === input.conversationRef) throw new SideraError("conflict", "Replacement must name a different existing Chat");
    consumeHumanAct(db,{id:actor.id??"",actId:actor.actId},recordWorld(db,"nodes",prior.chiefNodeId),"chief.handoff",prior.bindingId,prior.projectSpaceId,input);
    db.prepare("UPDATE chief_conversations SET state='retired' WHERE binding_id=?").run(prior.bindingId);
    db.prepare("UPDATE project_chief_roles SET state='retired' WHERE binding_id=?").run(prior.bindingId);
    invalidateFrontendRoute(db,{worldId:recordWorld(db,"nodes",prior.chiefNodeId),bindingId:prior.bindingId,reason:"Human Primary Chat handoff"});
    const result = insertChiefBinding(db, actor.id!, { projectSpaceId: prior.projectSpaceId,
      projectRef: prior.projectRef, chiefNodeId: prior.chiefNodeId,
      frontendKind: input.frontendKind??prior.frontendKind, conversationRef: input.conversationRef });
    db.prepare("INSERT INTO events VALUES (?, NULL, 'chief.conversation_handoff', ?, ?)")
      .run(randomUUID(), JSON.stringify({ issuer, requestId: input.requestId, fingerprint,
        from: prior.bindingId, to: result.bindingId, result }), new Date().toISOString());
    return result;
  });
}

/** Fail closed before new work; transport never substitutes Human message forwarding. */
export class ChiefDispatch {
  private db: DatabaseSync;
  private hythes: ReadonlyMap<string, Hythe>;
  private frontend: ChiefFrontend;
  private probeTimeoutMs: number;
  dispatchNext?: (caller:Caller,input:{supervisionId:string;roundIndex:number;instruction:string;nextNodeId?:string})=>Promise<unknown>;
  private advancing=new Map<string,Promise<unknown>>();
  private unsubscribe?:()=>void;
  constructor(db: DatabaseSync, hythes: ReadonlyMap<string, Hythe>, frontend: ChiefFrontend, probeTimeoutMs = 15000) {
    this.db = db; this.hythes = hythes; this.frontend = frontend;
    this.probeTimeoutMs = probeTimeoutMs;
    db.prepare("UPDATE chief_presentations SET state='uncertain', reason='Core restarted during frontend effect; never replay' WHERE state='sending'").run();
    this.unsubscribe=onCommittedEvent(db,id=>{void this.lifecycleEvent(id).catch(error=>{
      if(db.isOpen)boundaryEvent(db,null,"chief.lifecycle_blocked",{eventId:id,reason:String(error),automaticReplay:false});
    });});
  }
  close(){this.unsubscribe?.();}
  async prepareFrontend(nodeId:string) {
    const binding=this.binding(nodeId);
    if(!binding)return {prepared:false,routeId:null,reason:"Chief frontend unbound"};
    // restore is read-only; preparation belongs to this explicit lifecycle.
    if(this.frontend.verifyPresence)return this.frontend.verifyPresence(binding);
    return this.frontend.prepare?.(binding) ?? {prepared:false,routeId:null,reason:"No preparation lifecycle"};
  }
  private async lifecycleEvent(id:string) {
    const e=this.db.prepare("SELECT kind,payload FROM events WHERE event_id=?").get(id) as {kind:string;payload:string}|undefined;
    if(!e)return;
    const p=JSON.parse(e.payload);
    if(e.kind==="chief.conversation_handoff" || e.kind==="chief.conversation_bound")await this.prepareFrontend(p.result?.chiefNodeId ?? p.chiefNodeId);
    if(e.kind==="frontend.presence_observed"){
      const row=this.db.prepare("SELECT chief_node_id FROM chief_conversations WHERE binding_id=? AND conversation_ref=? AND state='active'").get(p.bindingId,p.conversationRef);
      const binding=row?this.binding(String(row.chief_node_id)):null;
      if(binding)this.frontend.prepare?.(binding);
    }
    if(e.kind==="supervision.next_round_requested")await this.advance(p.supervisionId,p.roundIndex);
    if(!/^(grant\.|host.health.changed$|human.message$|responsibility\.|runtime.dependency_resolved$)/.test(e.kind))return;
    const waiting=this.db.prepare("SELECT supervision_id,chief_node_id,responsibility_id FROM supervisions WHERE state='waiting' AND waiting_for=?").all(e.kind) as {supervision_id:string;chief_node_id:string;responsibility_id:string|null}[];
    for(const s of waiting){
      const worker=this.db.prepare("SELECT agent_node_id FROM supervision_rounds WHERE supervision_id=? ORDER BY round_index DESC LIMIT 1").get(s.supervision_id);
      const target=p.targetNodeId??p.ownerNodeId??p.subjectNodeId??p.nodeId;
      const selected=supervisionView(this.db,s.supervision_id).nextNodeId;
      if(target!==s.chief_node_id && target!==worker?.agent_node_id && target!==selected && (!s.responsibility_id || p.responsibilityId!==s.responsibility_id))continue;
      withTransaction(this.db,"supervision_wait_resolved",()=>{
        const round=this.db.prepare("SELECT MAX(round_index) n FROM supervision_decisions WHERE supervision_id=?").get(s.supervision_id)!;
        this.db.prepare("UPDATE supervisions SET state='running',waiting_for=NULL WHERE supervision_id=?").run(s.supervision_id);
        boundaryEvent(this.db,null,"supervision.next_round_requested",{supervisionId:s.supervision_id,roundIndex:Number(round.n),causeEventId:id});
      });
    }
  }
  private async advance(supervisionId:string,roundIndex:number) {
    const key=`${supervisionId}:${roundIndex}`,pending=this.advancing.get(key);
    if(pending)return pending;
    const s=supervisionView(this.db,supervisionId);
    if(!this.dispatchNext || !s.nextInstruction || !["running","reconciling"].includes(s.state))return;
    const active=this.db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(s.chiefNodeId) as {session_id:string}|undefined;
    if(!active)return {state:"blocked",reason:"Supervisor Session unavailable",taskCreated:false};
    const work=this.dispatchNext({nodeId:s.chiefNodeId,sessionId:active.session_id},{supervisionId,roundIndex,instruction:s.nextInstruction,nextNodeId:s.nextNodeId??undefined});
    this.advancing.set(key,work);
    try{return await work;}finally{this.advancing.delete(key);}
  }
  /** Bounded observation deadline. A deadline is not a scheduler: it never
   * creates Wake, never retries work, and an exceeded deadline reports the
   * unavailable value rather than inventing progress. */
  async observe<T>(work: Promise<T>, unavailable: T): Promise<T> { return this.probe(work, unavailable); }

  /**
   * Pure read of durable Human-frontend Presence. Never constructs a UI or
   * browser backend: a status query must not be able to cause an Effect, and
   * must not be able to walk into an anti-bot challenge. Evidence class and
   * freshness come from the observation itself; this function never upgrades
   * transport evidence into route evidence.
   */
  private frontendPresence(binding: ChiefBinding): { ready: boolean; reason: string; observation: unknown } {
    const presence = latestFrontendPresence(this.db, {
      worldId: recordWorld(this.db, "nodes", binding.chiefNodeId),
      bindingId: binding.bindingId, verifiedOnly:true });
    // Transport health never establishes that the exact Human Chat was reached.
    const verified = presence.state === "LIVE" && presence.evidenceClass === "ROUTE_VERIFIED";
    return { ready: verified,
      reason: verified ? `Presence ${presence.evidenceClass} observed ${presence.ageMs}ms ago via ${presence.method}`
        : `Exact Chat presence unverified (${presence.state}${presence.evidenceClass ? "/" + presence.evidenceClass : ""})`,
      observation: presence };
  }

  private async probe<T>(work: Promise<T>, unavailable: T): Promise<T> {
    return new Promise<T>(resolve => {
      const timer = setTimeout(() => resolve(unavailable), this.probeTimeoutMs);
      work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(unavailable); });
    });
  }
  binding(nodeId: string): ChiefBinding | null {
    const rows = this.db.prepare("SELECT * FROM chief_conversations WHERE chief_node_id=? AND state='active'")
      .all(nodeId) as Record<string, unknown>[];
    if (rows.length > 1) throw new SideraError("conflict", "Chief needs an explicit Project Space");
    return rows[0] ? bindingRow(rows[0]) : null;
  }
  isChief(nodeId: string): boolean {
    // Legacy appointment is only a fail-closed ingress guard. It cannot create
    // a Chief Conversation role: status/action still require an exact binding.
    return Boolean(this.binding(nodeId)) || Boolean(this.db.prepare(`SELECT 1 FROM role_appointments
      WHERE subject_node_id=? AND role='ChiefSupervisor' AND (expires_at IS NULL OR expires_at>?)`)
      .get(nodeId, new Date().toISOString()));
  }
  projects(nodeId: string) {
    // Human-facing project discovery is derived only from frontend bindings.
    // Internal Codex/DSH/Gemini/Grok Sessions are Runtime Resources, never projects.
    return (this.db.prepare("SELECT * FROM chief_conversations WHERE chief_node_id=? AND state='active'")
      .all(nodeId) as Record<string, unknown>[]).map(row=>canonicalChiefBinding(bindingRow(row)));
  }
  async status(caller: Caller, options: { targetNodeId?: string; targetSessionId?:string; conversationRef?: string; capability?: string } = {}) {
    const binding = this.binding(caller.nodeId), reasons: string[] = [];
    const own = this.db.prepare("SELECT hythe_id,locator_ref FROM sessions WHERE session_id=? AND node_id=? AND state='active'")
      .get(caller.sessionId, caller.nodeId) as { hythe_id: string; locator_ref: string } | undefined;
    if (!binding) reasons.push("CHIEF_CONVERSATION_UNBOUND");
    if (options.conversationRef && options.conversationRef !== binding?.conversationRef) reasons.push("CHIEF_CONVERSATION_MISMATCH");
    if (!own) reasons.push("CHIEF_SESSION_UNAVAILABLE");
    // Browser-free by construction. Calling frontend.inspect() here would launch
    // the frontend to ask whether the frontend exists: a real Effect, and the
    // exact path that walks into an anti-bot / CAPTCHA challenge, which is not a
    // retryable engineering path. Readiness is read from durable Presence evidence.
    // Four independent facts, reported separately. They were previously collapsed
    // into one boolean, which let a local health poll read as a verified return
    // path. Transport health != exact Presence != route capability != delivery.
    const frontend = binding ? this.frontendPresence(binding)
      : { ready: false, reason: "Chief frontend is unbound", observation: undefined };
    const presenceObservation = frontend.observation as { state?: string; evidenceClass?: string } | undefined;
    const transportObservation=binding?latestFrontendPresence(this.db,{worldId:recordWorld(this.db,"nodes",binding.chiefNodeId),bindingId:binding.bindingId,productionOnly:true}):null;
    const transportHealthy = transportObservation?.state === "LIVE";
    // Only real route/inbound evidence establishes that the exact Human Chat was
    // reached. A transport poll explicitly does not.
    const presenceVerified = frontend.ready;
    const route = binding && this.frontend.restore ? this.frontend.restore(binding) : null;
    if (!transportHealthy) reasons.push("CHIEF_TRANSPORT_HEALTH_UNAVAILABLE");
    if (!presenceVerified) reasons.push("CHIEF_RETURN_TRANSPORT_UNAVAILABLE");
    if (!route || route.state !== "USABLE" || route.routeClass==="ui-fallback") reasons.push("CHIEF_RETURN_ROUTE_UNAVAILABLE");
    else if (!route.controlProfile) reasons.push("CHIEF_RETURN_CONTROL_PROFILE_UNAVAILABLE");
    const capability = options.capability ?? "task.dispatch";
    const candidates = this.db.prepare(`SELECT n.node_id,n.display_name,s.session_id,s.hythe_id,s.locator_ref
      FROM nodes n JOIN sessions s USING(node_id) WHERE n.lifecycle='active' AND (s.state='active' OR EXISTS(
        SELECT 1 FROM operator_executors e WHERE e.session_id=s.session_id AND e.routing_admitted=1 AND s.state!='retired'))
      AND (? IS NULL OR s.session_id=?)
      AND (? IS NULL OR n.node_id=?) AND EXISTS(SELECT 1 FROM world_records w WHERE w.table_name='nodes'
        AND w.record_key=json_array(n.node_id) AND w.world_id=?)`).all(options.targetSessionId??null,options.targetSessionId??null,options.targetNodeId ?? null, options.targetNodeId ?? null,
          recordWorld(this.db, "nodes", caller.nodeId)) as Array<{
        node_id: string; display_name: string; session_id: string; hythe_id: string; locator_ref: string }>;
    const healthBySession=new Map(await Promise.all(candidates.filter(row=>readNodeOntology(this.db,row.node_id).kind==="Operator")
      .map(async row=>[row.session_id,await probeHostHealth(this.db,this.hythes,row.session_id,"chief-host-status",this.probeTimeoutMs)] as const)));
    const selected=new Map<string,string>();
    for(const row of candidates){if(selected.has(row.node_id))continue;
      const choice=readNodeOntology(this.db,row.node_id).kind==="Operator"?selectDispatchExecutor(this.db,{operatorNodeRef:row.node_id,targetSessionId:options.targetSessionId}):null;
      selected.set(row.node_id,choice?.state==="selected"?choice.executor.runtimeSessionId:row.session_id);}
    const nodes = await Promise.all(candidates.filter(row => selected.get(row.node_id)===row.session_id && (row.node_id !== caller.nodeId || options.targetNodeId)).map(async row => {
      let state = "ready";
      const hythe = this.hythes.get(row.hythe_id);
      if (!canUseCapability(this.db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
        capability, resource: `node/${row.node_id}`, requestId: "chief-discovery",projectRef:binding?.projectRef })) state = "authority_denied";
      else if(capability==="task.dispatch" && !canUseCapability(this.db,{subjectNodeId:row.node_id,sessionId:row.session_id,
        capability:"message.send",resource:`node/${caller.nodeId}`,requestId:"chief-return-discovery",requireExplicitGrant:true,projectRef:binding?.projectRef}))state="return_authority_denied";
      else if (this.db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state='uncertain')").get(row.session_id)) state = "needs_reconciliation";
      else if(readNodeOntology(this.db,row.node_id).kind==="Operator"&&selectDispatchExecutor(this.db,{operatorNodeRef:row.node_id,targetSessionId:row.session_id}).state!=="selected")state="executor_machine_review_required";
      else if (!hythe || !hythe.capabilities().includes("message.receive") || hythe.canStartTurn?.() === false) state = "host_unavailable";
      else try { if (!await this.probe(hythe.locate(row.locator_ref), false)) state = "host_unavailable"; }
        catch { state = "host_unavailable"; }
      return { nodeId: row.node_id, displayName: row.display_name, state,hostHealth:healthBySession.get(row.session_id)??null,hostObservation:hythe?.diagnostics?.() };
    }));
    if (own) {
      const hythe = this.hythes.get(own.hythe_id);
      try { if (!hythe || !await this.probe(hythe.locate(own.locator_ref), false)) reasons.push("CHIEF_RUNTIME_TRANSPORT_UNAVAILABLE"); }
      catch { reasons.push("CHIEF_RUNTIME_TRANSPORT_UNAVAILABLE"); }
    }
    if (!nodes.some(node => node.state === "ready")) reasons.push("NO_AVAILABLE_AUTHORIZED_NODE");
    const available = reasons.length === 0;
    const latest = binding ? this.db.prepare(`SELECT state,host_ref,reason,message_id FROM chief_presentations
      WHERE binding_id=? ORDER BY updated_at DESC LIMIT 1`).get(binding.bindingId) as {state:string;message_id:string}|undefined : undefined;
    const observed = latest && this.db.prepare("SELECT 1 FROM events WHERE kind='HumanObserved' AND json_extract(payload,'$.messageId')=?").get(latest.message_id);
    const ingress = this.frontend.ingress?.(binding??undefined) ?? { state: "unknown" };
    // These are deliberately separate layers. Core readiness, edge transport,
    // exact conversation Presence, the prepared return route, Operator Host
    // health, Worker Authority and bootstrap governance are never one flag.
    const routeUsable = Boolean(route && route.state === "USABLE" && route.routeClass !== "ui-fallback");
    const separation = {
      coreReadiness: { state: "READY", note: "this answer is Core's own response; a degraded edge is not Core death" },
      edgeTransport: { state: transportHealthy ? "LIVE" : "UNAVAILABLE",
        reason: transportHealthy ? null : "CHIEF_TRANSPORT_HEALTH_UNAVAILABLE" },
      exactConversationPresence: { state: presenceVerified ? "VERIFIED" : "UNVERIFIED",
        reason: presenceVerified ? null : "CHIEF_RETURN_TRANSPORT_UNAVAILABLE" },
      returnRoute: { state: routeUsable ? "USABLE" : "UNAVAILABLE", reason: routeUsable ? null : "CHIEF_RETURN_ROUTE_UNAVAILABLE" },
      operatorHostHealth: { states: nodes.map(node => ({ nodeId: node.nodeId, state: node.hostHealth?.state??"unknown",observedAt:node.hostHealth?.observedAt??null,reason:node.hostHealth?.reason??null })) },
      workerAuthority: { denied: nodes.filter(node => node.state === "authority_denied").map(node => node.nodeId),
        returnDenied: nodes.filter(node => node.state === "return_authority_denied").map(node => node.nodeId) },
      bootstrapGovernance: { version: R1_BOOTSTRAP_GOVERNANCE.version, appliesWhen: R1_BOOTSTRAP_GOVERNANCE.appliesWhen,
        adoptedRuleVersions: Number((this.db.prepare("SELECT count(*) n FROM rule_versions").get() as { n: number }).n) },
    };
    // Authorized ingress may read retained results even when machine egress is
    // unavailable. Reading is neither a resend nor proof of Human observation.
    // Preserve the original binding and distinguish Worker text from Chief review.
    const retainedResults = binding && own &&
      (!options.conversationRef || options.conversationRef === binding.conversationRef)
      ? this.db.prepare(`SELECT m.message_id AS messageId,m.task_id AS taskId,
          r.binding_id AS originalBindingId,m.body AS workerBody,
          json_extract(e.payload,'$.body') AS reviewedBody,
          p.state AS presentationState,p.reason AS presentationReason
        FROM messages m JOIN chief_task_routes r USING(task_id)
        JOIN chief_conversations c ON c.binding_id=r.binding_id
        LEFT JOIN events e ON e.kind='HumanPresentationRequested'
          AND json_extract(e.payload,'$.messageId')=m.message_id
        LEFT JOIN chief_presentations p ON p.message_id=m.message_id
        WHERE c.project_space_id=? AND c.chief_node_id=? AND m.to_node_id=?
          AND m.kind IN ('result','human-presentation')
          AND NOT EXISTS(SELECT 1 FROM events o WHERE o.kind='HumanObserved'
            AND json_extract(o.payload,'$.messageId')=m.message_id)
        ORDER BY m.created_at DESC LIMIT 20`)
        .all(binding.projectSpaceId,caller.nodeId,caller.nodeId)
      : [];
    return { available, state: available ? "READY" : "BLOCKED", reasons, binding,
      chiefConversation:binding?canonicalChiefBinding(binding):null,nodes,
      resultReturn: { mode: route?.state === "USABLE" && frontend.ready ? "governed-machine-egress" : "authorized-ingress-read",
        retainedResults, readMarksHumanObserved: false, readReplaysWork: false },
      transport: { core: "available",
        // Connectivity only. Never evidence that the exact Human Chat was reached.
        health: transportObservation ?? null,
        // Exact frontend Presence, with its own evidence class and freshness.
        presence: frontend,
        // Backward-compatible name for the EXACT-PRESENCE layer only. It no longer
        // implies anything about route capability or delivery.
        frontend,
        // A declared backend is selected and carries a real control profile.
        // This says a governed send is POSSIBLE; it does not say anything was sent.
        route: route ? { state: route.state, routeId: route.routeId, routeClass: route.routeClass,
          controlProfileId: route.controlProfile?.id ?? null, preparedAt: route.preparedAt,
          invalidAfter: route.invalidAfter, evidenceRef: route.evidenceRef, method: route.method }
          : { state: "UNKNOWN", routeId: null },
        ingress },
      boundary: { ingress, observation: (frontend as {observation?:unknown}).observation ?? {observation:frontend.ready?"live":"unavailable"},
        egress: latest ? {...latest,state:latest.state==="delivered"?"accepted":latest.state==="sending"?"admitted":latest.state==="blocked"?"rejected":"uncertain"} : {state:"not_attempted"},
        humanObserved: observed?true:"unknown", bindingState:binding?.state ?? "unbound" },
      humanRelayRequired: false, automaticConversationCreation: false, separation,
      message: available ? "Chief 可直接派发，结果固定返回绑定的主 Conversation。" :
        "Sidera 派发当前不可用。未创建新的任务；请查看 transport / binding 状态。Human 无需搬运提示词。" };
  }
  async action(caller: Caller, input: { requestId: string; targetNodeId: string; targetSessionId?:string;
    conversationRef?: string; capability: string; payload: Record<string, unknown> },
    execute: () => { task?: { taskId: string }; [key: string]: unknown }) {
    if (!this.isChief(caller.nodeId)) throw new SideraError("denied", "Caller is not this project's Chief");
    const fingerprint = JSON.stringify(input);
    const prior = this.db.prepare("SELECT input_json,result_json FROM chief_actions WHERE chief_node_id=? AND request_id=?")
      .get(caller.nodeId, input.requestId) as { input_json: string; result_json: string } | undefined;
    if (prior) {
      if (prior.input_json !== fingerprint) throw new SideraError("conflict", "Chief action request ID already used");
      return JSON.parse(prior.result_json) as Record<string, unknown>;
    }
    const selectedSession=typeof input.payload.targetSessionId==="string"?input.payload.targetSessionId:input.targetSessionId;
    const selectedExecutor=readNodeOntology(this.db,input.targetNodeId).kind==="Operator"?selectDispatchExecutor(this.db,{operatorNodeRef:input.targetNodeId,targetSessionId:selectedSession}):null;
    const exactTarget=selectedExecutor?.state==="selected"?selectedExecutor.executor.runtimeSessionId:selectedSession;
    const targetBefore = this.db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND ((? IS NOT NULL AND session_id=?) OR (? IS NULL AND state='active'))")
      .get(input.targetNodeId,exactTarget??null,exactTarget??null,exactTarget??null) as { session_id: string } | undefined;
    const status = await this.status(caller, { targetNodeId: input.targetNodeId,
      targetSessionId:targetBefore?.session_id,conversationRef: input.conversationRef, capability: input.capability });
    return withTransaction(this.db, "chief_action", () => {
      // Recheck dedupe/binding after awaited Host discovery.
      const competing = this.db.prepare("SELECT input_json,result_json FROM chief_actions WHERE chief_node_id=? AND request_id=?")
        .get(caller.nodeId, input.requestId) as { input_json: string; result_json: string } | undefined;
      if (competing) {
        if (competing.input_json !== fingerprint) throw new SideraError("conflict", "Concurrent Chief request conflicts");
        return JSON.parse(competing.result_json) as Record<string, unknown>;
      }
      let result: Record<string, unknown>;
      if (!status.available) result = { ...status, requestId: input.requestId, durableTaskCreated: false };
      else {
        if (this.binding(caller.nodeId)?.bindingId !== status.binding!.bindingId)
          throw new SideraError("conflict", "Chief binding changed during discovery");
        const target = this.db.prepare("SELECT session_id,state FROM sessions WHERE node_id=? AND session_id=?")
          .get(input.targetNodeId,targetBefore?.session_id??"") as { session_id: string;state:string } | undefined;
        if (!target || target.session_id !== targetBefore?.session_id ||
            (target.state!=="active"&&!isExecutorRuntimeSession(this.db,input.targetNodeId,target.session_id)) ||
            this.db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state='uncertain')").get(target.session_id))
          throw new SideraError("unavailable", "Target Session changed or became unavailable during discovery; no dispatch");
        result = execute(); // Authority reservation and Task/Responsibility creation stay atomic.
      // Bind the new Task to its supervision at dispatch time, so review() can
      // resolve it later without inventing a round.
      const supervisionId = (input.payload as { supervisionId?: unknown })?.supervisionId;
      if (result.task && typeof supervisionId === "string")
        linkTaskToSupervision(this.db, { supervisionId, taskId: (result.task as { taskId: string }).taskId,
          agentNodeId: input.targetNodeId });
        if (result.task) this.db.prepare("INSERT INTO chief_task_routes VALUES (?, ?)")
          .run((result.task as { taskId: string }).taskId, status.binding!.bindingId);
        result = { ...result, chiefBinding: status.binding, humanRelayRequired: false };
      }
      this.db.prepare("INSERT INTO chief_actions VALUES (?, ?, ?, ?)")
        .run(caller.nodeId, input.requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  async review(messageId:string,sessionId:string,hostRef:string,body:string):Promise<void> {
    const source=this.db.prepare(`SELECT m.*,c.binding_id,c.chief_node_id FROM messages m JOIN chief_task_routes r USING(task_id)
      JOIN chief_conversations c USING(binding_id) WHERE m.message_id=? AND m.kind='result' AND m.to_node_id=c.chief_node_id`).get(messageId) as Record<string,unknown>|undefined;
    if(!source)return;
    if(source.target_session_id!==sessionId || source.host_ref!==hostRef || source.state!=="observed" || !body.trim())
      throw new SideraError("denied","Chief review must be sourced from the exact completed result turn");
    // Supervised work is NOT forwarded to the Human here. The supervising Node
    // must decide, and only ACCEPT/ESCALATE may reach the Human. That is the
    // whole point: the Chat reviews, not the Human.
    const linked=supervisionForTask(this.db,String(source.task_id));
    const supervision=linked?{supervision_id:linked.supervisionId,rounds_completed:linked.roundsCompleted}:undefined;
    if(supervision){
      const existingRound=this.db.prepare("SELECT round_index FROM supervision_rounds WHERE result_message_id=? AND supervision_id=?").get(messageId,supervision.supervision_id);
      const roundIndex=existingRound?Number(existingRound.round_index):Number(supervision.rounds_completed)+1;
      withTransaction(this.db,"chief_review",()=>{
        if(this.db.prepare("SELECT 1 FROM events WHERE kind='supervision.round_completed' AND json_extract(payload,'$.messageId')=?").get(messageId))return;
        boundaryEvent(this.db,String(source.chief_node_id),"chief.review_completed",{messageId,sessionId,hostRef,body,supervised:true});
        recordRound(this.db,{supervisionId:supervision.supervision_id,roundIndex,
          agentNodeId:String(source.from_node_id),taskId:String(source.task_id),resultMessageId:messageId});
        boundaryEvent(this.db,String(source.chief_node_id),"supervision.round_completed",
          {messageId,supervisionId:supervision.supervision_id,roundIndex,bindingId:source.binding_id,body});
      });
      return;
    }
    // Unsupervised work keeps the previous single-round behaviour, now labelled
    // so it can never be mistaken for a supervised decision.
    withTransaction(this.db,"chief_review",()=>{
      if(this.db.prepare("SELECT 1 FROM events WHERE kind='HumanPresentationRequested' AND json_extract(payload,'$.messageId')=?").get(messageId))return;
      const reviewEventId=boundaryEvent(this.db,String(source.chief_node_id),"chief.review_completed",{messageId,sessionId,hostRef,body,supervised:false});
      boundaryEvent(this.db,String(source.chief_node_id),"HumanPresentationRequested",{messageId,bindingId:source.binding_id,reviewEventId,body,unsupervised:true});
    });
    await this.present(messageId);
  }

  /**
   * The supervising Chat Node records its decision for one completed round.
   * Core enforces the rules (one decision per round, round budget, who may
   * decide); it never chooses the decision itself.
   */
  async decide(caller: Caller, input: { supervisionId: string; roundIndex: number;
    decision: string; reason: string; instruction?: string;waitForEvent?:string;nextNodeId?:string }) {
    const supervision=supervisionView(this.db,input.supervisionId);
    if(supervision.chiefNodeId!==caller.nodeId)throw new SideraError("denied","Only this supervision owner may decide");
    if(input.nextNodeId){requireWorld(this.db,recordWorld(this.db,"nodes",caller.nodeId),"nodes",input.nextNodeId);
      if(!["CONTINUE","REWORK","RECONCILE","WAIT"].includes(input.decision))throw new SideraError("conflict","Terminal decision cannot choose next worker");}
    if(["CONTINUE","REWORK","RECONCILE","WAIT"].includes(input.decision) && !input.instruction?.trim())throw new SideraError("conflict","Next work needs a Supervisor-authored instruction");
    if(input.decision==="WAIT" && !input.waitForEvent?.match(/^(grant\.[a-z._]+|responsibility\.[a-z._]+|host.health.changed|human.message|runtime.dependency_resolved)$/))throw new SideraError("conflict","WAIT requires an explicit relevant event kind");
    const prior=this.db.prepare("SELECT payload FROM events WHERE kind='supervision.decision_input' AND json_extract(payload,'$.supervisionId')=? AND json_extract(payload,'$.roundIndex')=?").get(input.supervisionId,input.roundIndex);
    const fingerprint=JSON.stringify({supervisionId:input.supervisionId,roundIndex:input.roundIndex,decision:input.decision,
      reason:input.reason.trim(),instruction:input.instruction?.trim()??null,waitForEvent:input.waitForEvent??null,nextNodeId:input.nextNodeId??null});
    if(prior && JSON.parse(String(prior.payload)).fingerprint!==fingerprint)throw new SideraError("conflict","Conflicting decision instruction/wait condition");
    let presentMessageId:string|null=null;
    const result = decideSupervision(this.db, { ...input, actor: { kind: "node", nodeId: caller.nodeId } },result=>{
      boundaryEvent(this.db,caller.nodeId,"supervision.decision_input",{supervisionId:input.supervisionId,roundIndex:input.roundIndex,fingerprint,nextNodeId:input.nextNodeId??null});
      if(input.decision==="WAIT")this.db.prepare("UPDATE supervisions SET waiting_for=? WHERE supervision_id=?").run(input.waitForEvent!,input.supervisionId);
      if(["CONTINUE","REWORK","RECONCILE"].includes(result.decision) && result.state!=="budget_exhausted")
        boundaryEvent(this.db,caller.nodeId,"supervision.next_round_requested",{supervisionId:input.supervisionId,roundIndex:input.roundIndex});
      if (result.mustPresentToHuman && this.binding(caller.nodeId)) {
      const round = this.db.prepare("SELECT result_message_id FROM supervision_rounds WHERE supervision_id=? AND round_index=?")
        .get(input.supervisionId, input.roundIndex) as { result_message_id: string | null } | undefined;
      if (round?.result_message_id) {
        withTransaction(this.db, "chief_present_request", () => {
          if (this.db.prepare("SELECT 1 FROM events WHERE kind='HumanPresentationRequested' AND json_extract(payload,'$.messageId')=?").get(round.result_message_id)) return;
          boundaryEvent(this.db, caller.nodeId, "HumanPresentationRequested", { messageId: round.result_message_id,
            supervisionId: input.supervisionId, roundIndex: input.roundIndex, decision: result.decision,
            body:input.reason,source:"supervisor_decision",sourceResultMessageId:round.result_message_id });
        });
        presentMessageId=round.result_message_id;
      }
      }
    });
    if(presentMessageId)await this.present(presentMessageId);
    const nextRound=!result.replay && ["CONTINUE","REWORK","RECONCILE"].includes(result.decision)
      ? await this.advance(input.supervisionId,input.roundIndex):undefined;
    return { ...result, view: supervisionView(this.db, input.supervisionId),nextRound };
  }
  /** Read-only reconciliation of an accepted presentation, never another send. */
  async observePresentation(caller:Caller,messageId:string) {
    const row=this.db.prepare(`SELECT c.* FROM chief_presentations p JOIN chief_conversations c USING(binding_id)
      WHERE p.message_id=? AND c.chief_node_id=? AND c.state='active'`).get(messageId,caller.nodeId);
    if(!row)throw new SideraError("denied","Presentation is not in this Chief's exact active binding");
    const observed=await this.frontend.observePresentation?.(bindingRow(row),messageId)??"unknown";
    if(observed===true)this.db.prepare("UPDATE messages SET state='observed' WHERE message_id=? AND kind='human-presentation'").run(messageId);
    return {messageId,observed,replayed:false};
  }
  /** Correct a confirmed legacy presentation from its immutable Supervisor decision.
   * No Task, Run, decision or original message is rewritten; unknown sends cannot enter. */
  async correctPresentation(caller:Caller,supervisionId:string) {
    const view=supervisionView(this.db,supervisionId);
    if(view.chiefNodeId!==caller.nodeId || !["completed","escalated"].includes(view.state))
      throw new SideraError("denied","Only the accountable Supervisor may present its terminal decision");
    const round=this.db.prepare(`SELECT r.result_message_id,r.task_id,d.round_index,d.reason FROM supervision_rounds r
      JOIN supervision_decisions d USING(supervision_id,round_index) WHERE r.supervision_id=? AND d.decision IN ('ACCEPT','ESCALATE')
      ORDER BY d.round_index DESC LIMIT 1`).get(supervisionId);
    if(!round?.result_message_id)throw new SideraError("conflict","No completed reviewed result");
    const originalId=String(round.result_message_id),prior=this.db.prepare(`SELECT payload FROM events
      WHERE kind='chief.presentation_corrected' AND json_extract(payload,'$.supervisionId')=?`).get(supervisionId);
    if(prior)return {...JSON.parse(String(prior.payload)),replayed:false,alreadyRecorded:true};
    const original=this.db.prepare("SELECT state FROM chief_presentations WHERE message_id=?").get(originalId);
    if(original?.state!=="delivered")throw new SideraError("unavailable","Original presentation is not confirmed accepted; reconcile it without another send");
    const request=this.db.prepare("SELECT payload FROM events WHERE kind='HumanPresentationRequested' AND json_extract(payload,'$.messageId')=?").get(originalId);
    if(request && JSON.parse(String(request.payload)).body===round.reason)return {messageId:originalId,alreadyCurrent:true,replayed:false};
    if(!(await this.observePresentation(caller,originalId)).observed ||
      !this.db.prepare("SELECT 1 FROM events WHERE kind='HumanObserved' AND json_extract(payload,'$.messageId')=?").get(originalId))
      throw new SideraError("unavailable","Original presentation has not been observed in the exact Chat; no corrective send");
    const binding=this.binding(caller.nodeId);
    if(!binding || !canUseCapability(this.db,{subjectNodeId:caller.nodeId,sessionId:caller.sessionId,
      capability:"self.frontend.receive",resource:`node/${caller.nodeId}/frontend/${binding.bindingId}`,requestId:`correct:${supervisionId}`,taskId:String(round.task_id),projectRef:binding.projectRef}))
      throw new SideraError("denied","Correction requires current frontend Authority");
    const result=withTransaction(this.db,"presentation_correction",()=>{
      const existing=this.db.prepare("SELECT payload FROM events WHERE kind='chief.presentation_corrected' AND json_extract(payload,'$.supervisionId')=?").get(supervisionId);
      if(existing)return JSON.parse(String(existing.payload)) as {messageId:string;sourceMessageId:string;supervisionId:string};
      const body=`更正此前呈现的 Worker 工作中快照。以下为该流程已记录的 Supervisor 最终审阅；没有重跑 Task 或 Run。\n\n${String(round.reason)}`;
      const message=enqueueMessage(this.db,{requestId:`supervisor-presentation-correction:${supervisionId}:${round.round_index}`,
        taskId:String(round.task_id),fromNodeId:caller.nodeId,toNodeId:caller.nodeId,targetSessionId:caller.sessionId,kind:"human-presentation",body});
      boundaryEvent(this.db,caller.nodeId,"HumanPresentationRequested",{messageId:message.messageId,body,
        supervisionId,roundIndex:round.round_index,source:"supervisor_decision",sourceResultMessageId:originalId});
      const value={messageId:message.messageId,sourceMessageId:originalId,supervisionId};
      boundaryEvent(this.db,caller.nodeId,"chief.presentation_corrected",value);return value;
    });
    await this.present(result.messageId);
    return {...result,presentation:this.db.prepare("SELECT state,reason FROM chief_presentations WHERE message_id=?").get(result.messageId),replayed:false};
  }
  async recoverRequests() {
    const wakeEvents=this.db.prepare(`SELECT DISTINCT e.event_id FROM events e JOIN supervisions s ON s.state='waiting' AND e.kind=s.waiting_for
      WHERE e.created_at>s.updated_at ORDER BY e.rowid`).all();
    for(const event of wakeEvents)await this.lifecycleEvent(String(event.event_id));
    const next=this.db.prepare("SELECT DISTINCT json_extract(payload,'$.supervisionId') id,json_extract(payload,'$.roundIndex') n FROM events WHERE kind='supervision.next_round_requested'").all();
    for(const n of next)await this.advance(String(n.id),Number(n.n));
    const pending=this.db.prepare(`SELECT json_extract(payload,'$.messageId') messageId FROM events e
      WHERE kind='HumanPresentationRequested' AND NOT EXISTS(SELECT 1 FROM chief_presentations p
      WHERE p.message_id=json_extract(e.payload,'$.messageId'))`).all() as {messageId:string}[];
    for(const request of pending)await this.present(request.messageId);
  }
  async present(messageId: string): Promise<void> {
    const request=this.db.prepare("SELECT payload FROM events WHERE kind='HumanPresentationRequested' AND json_extract(payload,'$.messageId')=?").get(messageId) as {payload:string}|undefined;
    if(!request)return; // Worker completion is not Chief review.
    const row = this.db.prepare(`SELECT c.*,m.body,m.task_id FROM messages m JOIN chief_task_routes r USING(task_id)
      JOIN chief_conversations c USING(binding_id) WHERE m.message_id=? AND m.kind IN ('result','human-presentation')
      AND m.to_node_id=c.chief_node_id`).get(messageId) as Record<string, unknown> | undefined;
    if (!row || this.db.prepare("SELECT 1 FROM chief_presentations WHERE message_id=?").get(messageId)) return;
    const original=bindingRow(row);
    const current=this.db.prepare("SELECT * FROM chief_conversations WHERE project_space_id=? AND chief_node_id=? AND state='active'").get(original.projectSpaceId,original.chiefNodeId);
    if(!current)return; // Explicit Human binding is required; never invent a Chat.
    const binding = bindingRow(current);
    // Pure read. Presenting is the Effect; deciding whether we may present must not
    // construct a UI backend or open a browser.
    const ready = this.frontendPresence(binding).ready;
    // Another callback may have completed during this read.
    if (this.db.prepare("SELECT 1 FROM chief_presentations WHERE message_id=?").get(messageId)) return;
    this.db.prepare("INSERT INTO chief_presentations VALUES (?, ?, ?, NULL, ?, ?)")
      .run(messageId, binding.bindingId, ready ? "sending" : "blocked",
        ready ? null : "Original Chief Conversation return transport unavailable; no Human relay", new Date().toISOString());
    if (!ready) return;
    this.frontend.restore?.(binding);
    const active = this.db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'")
      .get(binding.chiefNodeId) as { session_id: string } | undefined;
    if (!active) {
      this.db.prepare("UPDATE chief_presentations SET state='blocked',reason='Chief Session unavailable' WHERE message_id=?").run(messageId);
      return;
    }
    let reservationId:string|null=null;
    try { ({reservationId}=reserveCapability(this.db, { subjectNodeId: binding.chiefNodeId, sessionId: active.session_id,
      requestId: `chief-present:${messageId}`, capability: "self.frontend.receive",
      resource: `node/${binding.chiefNodeId}/frontend/${binding.bindingId}`,taskId:String(row.task_id),projectRef:binding.projectRef })); }
    catch(error) {this.db.prepare("UPDATE chief_presentations SET state='blocked',reason=? WHERE message_id=?").run(String(error),messageId);return;}
    let result: InvokeResult,attemptId:string|undefined;
    try {
      const profile=this.frontend.effectProfile?.(binding);
      if(!profile)throw new SideraError("unavailable","M2: frontend lacks a verified final-send profile; presentation remains blocked");
      const store=new SemanticStore(this.db,recordWorld(this.db,"nodes",binding.chiefNodeId));
      const actionId=store.logicalAction(binding.chiefNodeId,binding.chiefNodeId,"conversation.send",`presentation:${messageId}`);
      attemptId=store.attempt(actionId,active.session_id);
      const payload={messageId,body:String(JSON.parse(request.payload).body)};
      const effect={actionId,attemptId,actorSessionId:active.session_id,capability:"self.frontend.receive",resource:`node/${binding.chiefNodeId}/frontend/${binding.bindingId}`,
        requestId:`chief-present:${messageId}`,taskId:String(row.task_id),payload,profile,frontendBindingId:binding.bindingId};
      const permit=prepareEffect(this.db,effect);
      result=await this.frontend.deliver(binding,payload,effectBoundary(this.db,permit,effect));
      if(["allocated","prepared"].includes(effectKnowledge(this.db,attemptId)))throw new SideraError("denied","Frontend did not cross final gate");
      if(result.status!=="accepted")result={status:"uncertain",reason:result.reason};
      observeEffect(this.db,attemptId,result.status==="accepted"?"accepted":"uncertain",result.status==="accepted"?result.hostRef:result.reason);
    } catch(error) {
      const before=!attemptId || ["allocated","prepared","confirmed_no_effect"].includes(effectKnowledge(this.db,attemptId));
      if(attemptId && before)abandonPreparedEffect(this.db,attemptId,"Frontend gate denied before send");
      if(before && reservationId && this.db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(reservationId)?.status==="reserved")settleReservation(this.db,reservationId,"released");
      if(attemptId && !before && ["may_have_effect","accepted"].includes(effectKnowledge(this.db,attemptId)))observeEffect(this.db,attemptId,"uncertain","Frontend result unavailable");
      result={status:before?"rejected":"uncertain",reason:error instanceof Error?error.message:"Frontend effect unconfirmed; never resend"};
    }
    this.db.prepare("UPDATE chief_presentations SET state=?,host_ref=?,reason=?,updated_at=? WHERE message_id=?")
      .run(result.status === "accepted" ? "delivered" : result.status === "uncertain" ? "uncertain" : "blocked",
        result.status === "accepted" ? result.hostRef : null,
        result.status === "accepted" ? null : result.reason, new Date().toISOString(), messageId);
    // A frontend-only correction has no Agent turn. Its Message reflects this
    // presentation's transport/observation, never a synthetic Task completion.
    const appeared=this.db.prepare("SELECT 1 FROM events WHERE kind='HumanObserved' AND json_extract(payload,'$.messageId')=?").get(messageId);
    this.db.prepare("UPDATE messages SET state=?,host_ref=? WHERE message_id=? AND kind='human-presentation'")
      .run(result.status==="accepted"?(appeared?"observed":"delivered"):result.status==="uncertain"?"uncertain":"failed",
        result.status==="accepted"?result.hostRef:null,messageId);
  }
}

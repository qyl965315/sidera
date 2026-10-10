import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ackMessage, awaitMessageDelivery, deliverMessage, getMessage, recoverInterruptedDelivery } from "./bus.ts";
import { getTask, type DispatchInput } from "./scheduler.ts";
import { SideraError } from "./types.ts";
import type { HostMessage, Hythe } from "../hythes/types.ts";
import { disabledArchiveAssist, type ArchiveAssist } from "../qwen/processor.ts";
import { Continuations } from "./continuations.ts";
import { currentSessionIncarnation, onCommittedEvent, withTransaction } from "./db.ts";
import { observeResourceUncertainty, reconcileResourceLoss, recordConfirmedResourceLoss, type ResourceLossProof } from "./reconciliation.ts";
import { isTrustedPhysicalHostExit } from "../hythes/lifecycle.ts";
import { evaluateExecutionAdmission, type ActivationController, type ExecutionPresenceObservation } from "./activation.ts";
import { recoverEffects, effectKnowledge, observeEffect } from "./effect-gate.ts";
import type { RuntimeBuildIdentity } from "./build-identity.ts";
import { isExecutorRuntimeSession } from "./executors.ts";
import { probeHostHealth } from "./host-health.ts";

/** One Core instance owns one database and its Hythe connections. */
export class CoreRuntime {
  private readonly db: DatabaseSync;
  private readonly hythes: ReadonlyMap<string, Hythe>;
  private readonly archive: ArchiveAssist;
  readonly continuations: Continuations;
  readonly observationOnly: boolean;
  /** Fact-derived readiness. Absent means the caller did not configure activation. */
  readonly activation?: ActivationController;
  ready:boolean;
  buildIdentity?:RuntimeBuildIdentity;
  reviewRootResult?: (messageId:string,sessionId:string,hostRef:string,body:string)=>Promise<void>;
  private closed=false;
  private readonly receiving=new Map<string,Promise<void>>();
  private readonly subscriptions: (() => void)[] = [];
  private readonly resultListeners = new Set<(event: {
    taskId: string; originNodeId: string; body: string; messageId: string; state: string;
  }) => void>();

  constructor(db: DatabaseSync, hythes: ReadonlyMap<string, Hythe>,
    archive: ArchiveAssist = disabledArchiveAssist, options: {observationOnly?:boolean;initialReady?:boolean;ownerId?:string;activation?:ActivationController} = {}) {
    this.observationOnly=Boolean(options.observationOnly);
    this.activation=options.activation;
    this.ready=options.initialReady ?? true;
    this.db = db;
    this.hythes = hythes;
    this.archive = archive;
    recoverEffects(db);
    recoverInterruptedDelivery(db);
    this.continuations = new Continuations(db, hythes);
    this.continuations.onResult = event => { for (const listener of this.resultListeners) listener(event); };
    this.continuations.recover();
    const ownerId=options.ownerId ?? process.env.SIDERA_CORE_OWNER_ID ?? randomUUID();
    db.prepare("INSERT OR IGNORE INTO execution_owners VALUES (?,?,'active',?)").run(ownerId,process.pid,new Date().toISOString());
    this.continuations.executionOwnerId=ownerId;
    this.continuations.admitObservation = async nodeId =>
      !(await this.executionAdmission(nodeId, nodeId, { capability: "self.task.resume" })).blocked;
    this.subscriptions.push(onCommittedEvent(db,eventId => { void this.worldEvent(eventId).catch(error => {
      if(!this.closed && db.isOpen)db.prepare("INSERT INTO events VALUES (?,NULL,'runtime.event_processing_error',?,?)")
        .run(randomUUID(),JSON.stringify({eventId,code:error instanceof SideraError?error.code:"unavailable"}),new Date().toISOString());
    }); }));
    for (const hythe of hythes.values()) if (hythe.onLifecycle)
      this.subscriptions.push(hythe.onLifecycle(event => {
        if (this.closed || !db.isOpen) return;
        const sessions = db.prepare("SELECT session_id FROM sessions WHERE hythe_id=? AND state!='retired' AND (? IS NULL OR locator_ref=?)")
          .all(hythe.hytheId,event.locatorRef ?? null,event.locatorRef ?? null) as {session_id:string}[];
        for (const session of sessions) {
          if (event.physicalExit && isTrustedPhysicalHostExit(event.physicalExit)) {
            try {
              const proof=recordConfirmedResourceLoss(db,{sessionId:session.session_id,physicalExit:event.physicalExit});
              this.resourceLost(session.session_id,event.reason,"hythe.child_process_exit",
                `${event.physicalExit.receiptId}:reconcile:${session.session_id}`,proof);
            } catch (error) {
              // A real local exit without an exact current canonical binding is
              // not permission to fence a different Host incarnation.
              const eventId=`${event.physicalExit.receiptId}:unresolved:${session.session_id}`;
              db.prepare("INSERT OR IGNORE INTO events VALUES (?,NULL,'runtime.host_termination_unresolved',?,?)")
                .run(eventId,JSON.stringify({sessionId:session.session_id,witnessId:event.physicalExit.receiptId,
                  reason:event.reason,code:error instanceof Error?error.message:"unavailable",replay:false}),new Date().toISOString());
              this.resourceLost(session.session_id,event.reason,"hythe.child_process_exit_unresolved",`${eventId}:uncertain`);
            }
          } else this.resourceLost(session.session_id,event.reason,"hythe.lifecycle");
        }
      }));
  }

  async dispatch(input: DispatchInput) {
    const submitted = this.continuations.submit(input);

    await this.continuations.pump();
    const view = getTask(this.db,submitted.task.taskId);
    return {task:view.task,firstMessage:getMessage(this.db,submitted.run.message_id)};
  }

  /**
   * Compatibility entry point for lifecycle observations.  Callers without an
   * exact trusted proof preserve UNCERTAIN state; only the proof-bearing form
   * may erect the irreversible resource-loss fence.
   */
  resourceLost(sessionId: string, reason: string, source: string, eventId: string=randomUUID(), proof?:ResourceLossProof,
    incarnation?:string) {
    return proof ? reconcileResourceLoss(this.db,{eventId,sessionId,reason,source,proof}) :
      observeResourceUncertainty(this.db,{eventId,sessionId,reason,source,incarnation});
  }
  private async worldEvent(eventId: string) {
    if (this.closed || !this.db.isOpen) return;
    const event = this.db.prepare("SELECT kind,payload FROM events WHERE event_id=?").get(eventId) as
      {kind:string;payload:string} | undefined;
    if (!event) return;
    const payload = JSON.parse(event.payload);
    if(event.kind==="message.queued" && payload.messageId) {
      const message=getMessage(this.db,payload.messageId);
      void Promise.resolve().then(()=>this.archive.index(Object.freeze({kind:"history",ref:message.messageId,text:message.body}))).catch(()=>{});
    }
    if (["session.close","session.handoff","node.retire"].includes(event.kind)) {
      const nodeId=payload.result?.nodeId;
      const sessions = event.kind==="session.close" ? [{session_id:payload.result.sessionId}] : event.kind==="session.handoff" ?
        (payload.previousSessionId ? [{session_id:payload.previousSessionId}] : []) : this.db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='retired'")
        .all(nodeId) as {session_id:string}[];
      for (const session of sessions) observeResourceUncertainty(this.db,{sessionId:session.session_id,reason:event.kind,
        source:"registry",eventId:`${eventId}:${session.session_id}`});
      // Session handoff records routing. Only the authorized verified Host
      // handoff receipt may separately record current Host availability.
    }
    if (/^(grant\.|responsibility\.|supervision.round_failed$|authority.constraint_changed$|host.health.changed$|human.message$|runtime.resource_lost$)/.test(event.kind)) {
      const target = payload.targetNodeId ?? payload.ownerNodeId ?? payload.subjectNodeId;
      if (target && this.db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(target))
        this.db.prepare("INSERT OR IGNORE INTO runtime_observations(event_id,target_node_id,state) VALUES (?,?,'queued')").run(eventId,target);
    }
    if (!this.observationOnly && !this.activation?.maintenanceForced && !this.closed && this.ready)
      await this.continuations.wakeObservations();
  }
  /** Explicit operation-scoped observation; never probes or refreshes a Chat.
   * Only the two participating exact Session locators are inspected. */
  async executionAdmission(callerNodeId: string, targetNodeId: string,
    options: { capability?: "task.dispatch" | "self.task.resume"; callerSessionId?:string; targetSessionId?:string;projectRef?:string;taskId?:string } = {}) {
    const locate = async (nodeId: string, exactSessionId?:string): Promise<ExecutionPresenceObservation> => {
      const session = this.db.prepare("SELECT session_id,locator_ref,hythe_id,host_kind,state FROM sessions WHERE node_id=? AND ((? IS NULL AND state='active') OR session_id=?)")
        .get(nodeId,exactSessionId??null,exactSessionId??null) as { session_id: string; locator_ref: string; hythe_id: string; host_kind: string; state:string } | undefined;
      const observed: ExecutionPresenceObservation = { nodeId, sessionId: session?.session_id ?? null,
        locatorRef: session?.locator_ref ?? null, hytheId: session?.hythe_id ?? null, hostKind: session?.host_kind ?? null, live: false };
      if (this.observationOnly || this.activation?.maintenanceForced || !this.ready || this.closed)
        return { ...observed, reason: "Runtime execution is administratively blocked or not ready" };
      if (!session) return { ...observed, reason: "No active Session" };
      if(session.state!=="active" && !isExecutorRuntimeSession(this.db,nodeId,session.session_id))
        return {...observed,reason:"Exact Session is not an admitted runtime context"};
      const hythe = this.hythes.get(session.hythe_id);
      if (!hythe || hythe.hostKind !== session.host_kind) return { ...observed, reason: "Exact Host adapter unavailable" };
      try {
        const operations = hythe.manifest?.().operations ?? [];
        if (operations.some(op => op.supported && op.routeClass === "ui-fallback"))
          return { ...observed, reason: "Browser transport is production-ineligible" };
        observed.profile = hythe.effectProfile?.("message.receive");
        if (!hythe.capabilities().includes("message.receive"))
          return { ...observed, reason: "Host cannot receive an Agent turn" };
        const health=await probeHostHealth(this.db,this.hythes,session.session_id,"execution-admission");
        observed.live=health.live;
        if(!observed.live)observed.reason=health.reason??"Exact Host locator unavailable";
      } catch (error) { observed.reason = error instanceof Error ? error.message : "Host observation failed"; }
      return observed;
    };
    const caller = await locate(callerNodeId,options.callerSessionId), target = callerNodeId === targetNodeId && (!options.targetSessionId||options.targetSessionId===caller.sessionId) ? caller : await locate(targetNodeId,options.targetSessionId);
    return evaluateExecutionAdmission(this.db, { caller, target, capability: options.capability,projectRef:options.projectRef,taskId:options.taskId,
      ownerId: this.continuations.executionOwnerId, ready: this.ready && !this.closed,
      maintenanceForced: this.observationOnly || this.activation?.maintenanceForced });
  }
  /**
   * One projection of runtime readiness. The operator override can only add
   * maintenance; fact-derived activation can withdraw it when its facts change.
   */
  maintenance(required?: import("./activation.ts").ActivationInput["required"]): {
    blocked: boolean; mode: "active" | "blocked"; reasons: string[]; observedAt: number | null;
    mesh?: unknown; freshness?: unknown; staleObject?: string | null; recoveryAction?: string | null;
  } {
    if (this.observationOnly)
      return { blocked: true, mode: "blocked", reasons: ["OBSERVATION_ONLY_FORCED"], observedAt: null };
    if (!this.activation) return { blocked: false, mode: "active", reasons: [], observedAt: null };
    const decision = this.activation.decision(required);
    const detail = decision.detail as Record<string, unknown>;
    // A blocker must say WHICH observation lapsed and what renews it, so a stale
    // runtime cache can never be read as "the Chat is gone".
    return { blocked: !decision.ready, mode: decision.mode, reasons: decision.reasons,
      observedAt: this.activation.observedAt(), mesh: detail.mesh,
      freshness: detail.freshness ?? null,
      staleObject: (detail.staleObject as string | undefined) ?? null,
      recoveryAction: (detail.recoveryAction as string | undefined) ?? null };
  }
  close(): void {
    if(this.closed)return;
    this.closed=true;
    const sessions=this.db.prepare("SELECT session_id FROM task_runs WHERE turn_open=1 UNION SELECT session_id FROM session_health WHERE state='available'").all() as {session_id:string}[];
    for(const session of sessions)this.resourceLost(session.session_id,"Core execution owner shut down; effects may persist","core.shutdown");
    if(this.continuations.executionOwnerId)this.db.prepare("UPDATE execution_owners SET state='exited' WHERE owner_id=?").run(this.continuations.executionOwnerId);
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }

  onResult(listener: (event: {
    taskId: string; originNodeId: string; body: string; messageId: string; state: string;
  }) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  async complete(input: {taskId:string;fromNodeId:string;fromSessionId:string;requestId:string;body:string}) {
    const view = getTask(this.db,input.taskId);
    const run = view.runs.find((row:any)=>row.session_id===input.fromSessionId && row.turn_open===1) as
      {run_id:string;message_id:string} | undefined;
    if (!run || view.task.centerNodeId !== input.fromNodeId) throw new SideraError("denied","Result must belong to the exact executing Run");
    const message = getMessage(this.db,run.message_id);
    await this.continuations.ingest(input.fromSessionId,{hostRef:message.hostRef!,observedMessageId:message.messageId,
      body:input.body,outcome:"completed"});
    const result = getTask(this.db,input.taskId).messages.find(m=>m.kind==="result");
    if (!result) throw new SideraError("uncertain","Result requires reconciliation");
    return result;
  }

  /** Read the original standalone Host turn. Failure closes occupancy, not work. */
  async reconcileStandaloneResult(sessionId:string,messageId:string) {
    const message=getMessage(this.db,messageId);
    if(message.targetSessionId!==sessionId || !["cooperation","context-handoff","result"].includes(message.kind) ||
      this.db.prepare("SELECT 1 FROM task_runs WHERE message_id=?").get(messageId))
      throw new SideraError("denied","Only the original standalone receiving Session can reconcile this message");
    const prior=this.db.prepare("SELECT payload FROM events WHERE kind='runtime.standalone_turn_reconciled' AND json_extract(payload,'$.messageId')=?").get(messageId);
    if(prior)return {...JSON.parse(String(prior.payload)),replay:true};
    const session=this.db.prepare("SELECT hythe_id,locator_ref,state FROM sessions WHERE session_id=?").get(sessionId);
    if(session && session.state!=="active" && !isExecutorRuntimeSession(this.db,message.toNodeId,sessionId))
      throw new SideraError("unavailable","Original Session is not an admitted runtime context; uncertainty preserved");
    const hythe=session?this.hythes.get(String(session.hythe_id)):undefined;
    if(!session || !hythe?.completedTurn || !message.hostRef)
      throw new SideraError("unavailable","No exact original Host turn reader; uncertainty preserved");
    const event=await hythe.completedTurn(String(session.locator_ref),message.hostRef,messageId);
    if(!event || event.hostRef!==message.hostRef || event.observedMessageId!==messageId || !["completed","failed"].includes(event.outcome??""))
      throw new SideraError("unavailable","Exact terminal Host turn unavailable; no replay or new inference");
    const evidence={messageId,sessionId,hostRef:event.hostRef,outcome:event.outcome,turnClosed:true,
      resultCompleted:event.outcome==="completed",replay:false};
    withTransaction(this.db,"standalone_reconcile",()=>{
      this.db.prepare("INSERT INTO events VALUES (?,?,'runtime.standalone_turn_reconciled',?,?)")
        .run(randomUUID(),message.toNodeId,JSON.stringify(evidence),new Date().toISOString());
      if(event.outcome==="completed") {
        const attempt=this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1").get(messageId);
        if(attempt && ["accepted","uncertain"].includes(effectKnowledge(this.db,String(attempt.attempt_id))))
          observeEffect(this.db,String(attempt.attempt_id),"completed",`correlated-host-turn:${event.hostRef}`);
        this.db.prepare("UPDATE messages SET state='observed' WHERE message_id=?").run(messageId);
      }
    });
    if(event.outcome==="completed" && message.kind==="result")
      await this.reviewRootResult?.(messageId,sessionId,event.hostRef,event.body);
    await this.continuations.pump();
    return evidence;
  }

  /** Called only with events sourced from the Hythe bound to this exact Session. */
  async ingest(sessionId: string, event: HostMessage) {
    if(event.observedMessageId)await awaitMessageDelivery(this.db,event.observedMessageId);
    if (await this.continuations.ingest(sessionId, event)) {
      const received=getMessage(this.db,event.observedMessageId!);
      const result=received.taskId?getTask(this.db,received.taskId).messages.find(m=>m.kind==="result"):undefined;
      return {handled:true,observed:received.messageId,result};
    }
    if (!event.observedMessageId) {
      throw new SideraError("conflict", "Host event has no linked Sidera message");
    }
    if(getMessage(this.db,event.observedMessageId).state==="sending")await this.continuations.pump();
    const received = getMessage(this.db, event.observedMessageId);
    if (received.targetSessionId !== sessionId) {
      throw new SideraError("denied", "Host event arrived from another Session");
    }
    const session = this.db.prepare("SELECT node_id FROM sessions WHERE session_id = ?")
      .get(sessionId) as { node_id: string } | undefined;
    if (!session || session.node_id !== received.toNodeId) {
      throw new SideraError("denied", "Host event is not bound to target Node");
    }
    if (!received.hostRef || received.hostRef !== event.hostRef)
      throw new SideraError("conflict", "Host event does not match the accepted exact turn");
    const observeStandalone = (knowledge: "completed" | "uncertain") => {
      const attempt = this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1")
        .get(received.messageId);
      // An explicit ACK is observation, not completion. Only this correlated
      // terminal event releases the accepted Effect; uncertainty is not retried.
      if (attempt && effectKnowledge(this.db, String(attempt.attempt_id)) === "accepted")
        observeEffect(this.db, String(attempt.attempt_id), knowledge, `correlated-host-turn:${event.hostRef}`);
    };
    if (received.kind === "result") {
      if(received.hostRef!==event.hostRef)throw new SideraError("conflict","Chief review Host reference mismatch");
      if(event.outcome!=="completed") {
        observeStandalone("uncertain");
        this.db.prepare("INSERT INTO events VALUES (?,?,'chief.review_uncertain',?,?)").run(randomUUID(),session.node_id,
          JSON.stringify({messageId:received.messageId,sessionId,reason:event.body.slice(0,2000),replay:false}),new Date().toISOString());
        return {uncertain:received.messageId}; // A failed observation/review never rewrites the completed worker Task.
      }
      if(received.state==="delivered")ackMessage(this.db,received.messageId,sessionId);
      else if(received.state!=="observed")throw new SideraError("conflict","Unconfirmed Chief result delivery");
      observeStandalone("completed");
      await this.reviewRootResult?.(received.messageId,sessionId,event.hostRef,event.body);
      await this.continuations.pump(); // A completed review releases queued next-round results.
      return {observed:received.messageId};
    }
    if (received.state === "observed" && received.taskId) {
      const task = this.db.prepare("SELECT state FROM tasks WHERE task_id = ?")
        .get(received.taskId) as { state: string } | undefined;
      if (task?.state === "completed") return { observed: received.messageId };
    }
    if (event.outcome === "failed" || (["cooperation", "context-handoff"].includes(received.kind) && event.outcome !== "completed")) {
      observeStandalone("uncertain");
      this.db.prepare("INSERT INTO events VALUES (?, ?, 'runtime.host_failure', ?, ?)").run(randomUUID(),
        session.node_id, JSON.stringify({ taskId: received.taskId, sessionId,
          messageId: received.messageId, reason: event.body.slice(0, 2000), replay: false }), new Date().toISOString());
      this.db.prepare("UPDATE messages SET state = 'uncertain' WHERE message_id = ?")
        .run(received.messageId);
      if (received.taskId) {
        this.db.prepare("UPDATE tasks SET state = 'uncertain' WHERE task_id = ?")
          .run(received.taskId);
        const task = this.db.prepare("SELECT origin_node_id FROM tasks WHERE task_id = ?")
          .get(received.taskId) as { origin_node_id: string };
        for (const listener of this.resultListeners) {
          listener({ taskId: received.taskId, originNodeId: task.origin_node_id,
            body: event.body.slice(0, 2000), messageId: received.messageId, state: "uncertain" });
        }
      }
      return { uncertain: received.messageId };
    }
    if (received.state === "delivered") ackMessage(this.db, received.messageId, sessionId);
    else if (received.state !== "observed") {
      throw new SideraError("conflict", "Host observed an unconfirmed delivery");
    }
    if (!received.taskId) {
      // The exact terminal event releases the standalone Host turn. A worker
      // may already have completed while its Supervisor kickoff was still open.
      // Pump that queued work now; no timer, retry or new Task is needed.
      observeStandalone("completed");
      await this.continuations.pump();
      return { observed: received.messageId };
    }
    if (!event.body || received.kind === "result") return { observed: received.messageId };
    const delivery = await this.complete({
      taskId: received.taskId,
      fromNodeId: session.node_id,
      fromSessionId: sessionId,
      requestId: `result:${event.hostRef}`,
      body: event.body,
    });
    return { observed: received.messageId, result: delivery };
  }

  /** One long-lived push subscription for each exact admitted runtime context. */
  receive(sessionId: string): Promise<void> {
    const existing=this.receiving.get(sessionId);if(existing)return existing;
    const received=Promise.resolve().then(()=>this.receiveOnce(sessionId));
    this.receiving.set(sessionId,received);
    void received.then(()=>this.receiving.delete(sessionId),()=>this.receiving.delete(sessionId));
    return received;
  }
  private async receiveOnce(sessionId:string):Promise<void> {
    if(this.closed||!this.db.isOpen)return;
    const row = this.db.prepare(`SELECT node_id,state,hythe_id, locator_ref FROM sessions
      WHERE session_id = ?`).get(sessionId) as
      | { node_id:string;state:string;hythe_id: string; locator_ref: string } | undefined;
    if (!row) throw new SideraError("not_found", "Session was not found");
    if(row.state!=="active"&&!isExecutorRuntimeSession(this.db,row.node_id,sessionId))
      throw new SideraError("unavailable","Cannot subscribe to an unadmitted runtime context");
    const hythe = this.hythes.get(row.hythe_id);
    if (!hythe) throw new SideraError("unavailable", "Session Hythe is unavailable");
    const incarnation=currentSessionIncarnation(this.db,sessionId)?.incarnation;
    try { for await (const event of hythe.receive(row.locator_ref)) {
      if(this.closed || !this.db.isOpen) break;
      try {
        await this.ingest(sessionId, event);
      } catch (error) {
        // An individual Host result may fail Core Authority after the Host
        // has completed. Keep later exact-Session results observable while
        // the failed Run remains uncertain for explicit reconciliation.
        this.db.prepare("INSERT INTO events VALUES (?, NULL, 'host.event.ingest_failed', ?, ?)")
          .run(randomUUID(), JSON.stringify({ sessionId,
            observedMessageId: event.observedMessageId ?? null,
            hostRef: event.hostRef,
            code: error instanceof SideraError ? error.code : "unavailable",
            reason:error instanceof SideraError ? error.message : "Host result ingestion failed",
            replay:false }),
          new Date().toISOString());
      }
    } } finally {
      // Stream completion says only that this subscription ended.  It does not
      // prove the physical Host terminated and therefore cannot fence Effects.
      if (!this.closed && this.db.isOpen) this.resourceLost(sessionId,"Host receive stream ended","hythe.receive",undefined,undefined,incarnation);
    }
  }
}

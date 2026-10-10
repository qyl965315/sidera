import { randomUUID } from "node:crypto";
import { isExecutorRuntimeSession } from "./executors.ts";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability } from "./authority.ts";
import { ackMessage, deliverMessage, enqueueMessage, getMessage, sendMessage } from "./bus.ts";
import { settleReservation } from "./authority.ts";
import { getTension, type SourceRef } from "./tensions.ts";
import { withTransaction } from "./db.ts";
import { createTask, getTask, type DispatchInput } from "./scheduler.ts";
import { observeResourceUncertainty } from "./reconciliation.ts";
import {readSessionHostCondition} from "./condition.ts";
import { SideraError } from "./types.ts";
import { ensureMessageAction, sameBasis, taskBasis } from "./semantics.ts";
import type { HostMessage, Hythe } from "../hythes/types.ts";
import { observeEffect,effectKnowledge,recordExecutionProgress,executionReality,isCurrentEffectOwner } from "./effect-gate.ts";
import { supervisionForTask,recordRound } from "./supervision.ts";

type Run = { run_id: string; task_id: string; session_id: string; message_id: string;
  state: string; turn_open: number; checkpoint: string };
type Dependency = { parent_run_id: string; child_task_id: string; state: string;
  result_message_id: string | null; continuation_run_id: string | null };

/** Canonical standalone Host occupancy, shared by scheduling and shutdown.
 * An Agent's message ACK cannot prove its Host turn ended. Only correlated
 * completed Effect evidence releases it; no historical Presence is consulted. */
export function hasPendingStandaloneTurn(db: DatabaseSync, sessionId?: string,
  options: { currentExecutorOnly?: boolean } = {}): boolean {
  const messages=db.prepare(`SELECT m.* FROM messages m JOIN sessions s ON s.session_id=m.target_session_id
    WHERE (? IS NULL OR target_session_id=?) AND (s.state='active' OR (s.state='standby' AND EXISTS(SELECT 1 FROM operator_executors e WHERE e.session_id=s.session_id AND e.routing_admitted=1 AND e.context_state='usable')))
    AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.message_id=m.message_id)
    AND kind IN ('cooperation','context-handoff','result') AND m.state IN ('sending','delivered','observed','uncertain')`)
    .all(sessionId??null,sessionId??null);
  return messages.some(message=>{
    const attempts=db.prepare(`SELECT a.attempt_id,e.state FROM action_attempts a LEFT JOIN effect_attempt_state e USING(attempt_id)
      WHERE a.source_message_id=?`).all(message.message_id);
    if(options.currentExecutorOnly && !attempts.some(a=>isCurrentEffectOwner(db,String(a.attempt_id))))return false;
    if(attempts.some(a=>a.state==='completed'))return false;
    if(db.prepare(`SELECT 1 FROM events WHERE kind IN ('runtime.standalone_turn_reconciled','chief.review_completed')
      AND json_extract(payload,'$.messageId')=? AND json_extract(payload,'$.sessionId')=?
      AND json_extract(payload,'$.hostRef')=?`).get(message.message_id,message.target_session_id,message.host_ref))return false;
    // Pre-Effect observed records have no durable occupancy lease. Preserve their
    // historical observation, without inventing either execution or completion.
    if(!attempts.length && message.state==='observed')return false;
    return true;
  });
}

/** Durable, event-driven scheduling. A waiting Run owns no Host turn after yield. */
export class Continuations {
  private db: DatabaseSync;
  private hythes: ReadonlyMap<string, Hythe>;
  private pumping: Promise<void> | null = null;
  private dirty = false;
  /** These canonical messages start Host turns without a Task Run. A durable
   * acceptance keeps the Session occupied until its exact terminal event completes it;
   * uncertainty must remain occupied until explicit reconciliation. */
  private hasStandaloneTurn(sessionId: string): boolean {
    return hasPendingStandaloneTurn(this.db, sessionId);
  }
  executionOwnerId?: string;
  /** Host session strategy may explicitly hand off before a new, still-unsent wake. */
  onResult?: (event: {taskId:string;originNodeId:string;body:string;messageId:string;state:string}) => void;
  prepareWake?: (runId: string, sessionId: string, commitWake: (nextSessionId:string) => void) => Promise<string>;
  /** Non-Run result/supervision wakes may also require a fresh Host Session. */
  prepareNodeWake?: (wakeId:string,nodeId:string,sessionId:string,commitWake?:(nextSessionId:string)=>void)=>Promise<string>;
  /** A frontend presentation is separate from delivery to the Chief's Runtime Session. */
  presentRootResult?: (messageId: string) => Promise<void>;
  /** Runtime performs scoped non-browser admission before an event self-wake. */
  admitObservation?: (nodeId: string) => Promise<boolean>;
  constructor(db: DatabaseSync, hythes: ReadonlyMap<string, Hythe>) {
    this.db = db; this.hythes = hythes;
  }

  recover(): void {
    // Restart cannot prove whether a previously open turn ended. Never replay
    // it and never turn Core process loss into a Host-resource-loss fence.
    withTransaction(this.db, "continuation_recovery", () => {
      const open = this.db.prepare("SELECT * FROM task_runs WHERE turn_open = 1").all() as Run[];
      for (const sessionId of new Set(open.map(run=>run.session_id)))
        observeResourceUncertainty(this.db,{eventId:randomUUID(),sessionId,
          reason:"Core restarted without confirmed Host turn end",source:"core.startup"});
    });
  }

  private insertRun(taskId: string, sessionId: string, messageId: string): Run {
    ensureMessageAction(this.db, messageId);
    const id = randomUUID();
    this.db.prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, 'running', 0, '', ?)")
      .run(id, taskId, sessionId, messageId, new Date().toISOString());
    return this.run(id);
  }

  run(id: string): Run {
    const row = this.db.prepare("SELECT * FROM task_runs WHERE run_id = ?").get(id) as Run | undefined;
    if (!row) throw new SideraError("not_found", "Run not found");
    return row;
  }

  checkpoint(caller: { nodeId: string; sessionId: string }, input: {
    requestId: string; runId: string; outcome: "CONTINUE" | "WAIT" | "IDLE";
    tensionId?: string; checkpoint: string; progressRefs?: SourceRef[];
  }) {
    return withTransaction(this.db, "runtime_checkpoint", () => {
      const run = this.run(input.runId);
      const task = getTask(this.db, run.task_id).task;
      if (run.session_id !== caller.sessionId || task.centerNodeId !== caller.nodeId || !run.turn_open)
        throw new SideraError("denied", "Only the executing exact Run may checkpoint");
      if (!["CONTINUE","WAIT","IDLE"].includes(input.outcome) || !input.checkpoint.trim() || input.checkpoint.length > 8000)
        throw new SideraError("conflict", "Invalid bounded runtime checkpoint");
      const refs = input.progressRefs ?? [];
      if (refs.length > 8) throw new SideraError("conflict", "Too many progress references");
      const prior = this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id = ?").get(run.run_id) as
        { request_id: string; outcome: string; tension_id: string | null; checkpoint: string; progress_refs: string } | undefined;
      if (prior) {
        if (prior.request_id !== input.requestId || prior.outcome !== input.outcome ||
            prior.tension_id !== (input.tensionId ?? null) || prior.checkpoint !== input.checkpoint || prior.progress_refs !== JSON.stringify(refs))
          throw new SideraError("conflict", "Run already has another checkpoint");
        return { outcome: prior.outcome, runId: run.run_id };
      }
      if (input.tensionId) {
        const tension = getTension(this.db, input.tensionId);
        if (tension.nodeId !== caller.nodeId || !["open","waiting"].includes(tension.status))
          throw new SideraError("denied", "Checkpoint requires your own unresolved tension");
      }
      if (input.outcome === "WAIT" && run.state !== "waiting_dependency")
        throw new SideraError("conflict", "WAIT requires a durable child dependency in v0");
      if (input.outcome !== "WAIT" && run.state !== "running")
        throw new SideraError("conflict", "A waiting dependency must finish before another outcome");
      if (input.outcome === "CONTINUE") {
        if (!input.tensionId || !refs.length) throw new SideraError("conflict", "CONTINUE needs an actionable tension and observed progress");
        const previous = this.db.prepare(`SELECT c.progress_refs FROM run_checkpoints c JOIN task_runs r USING(run_id)
          WHERE r.task_id = ? AND c.outcome = 'CONTINUE'`).all(run.task_id) as { progress_refs: string }[];
        if (previous.length >= 2) throw new SideraError("conflict", "Continuation burst exhausted; wait or escalate instead of looping");
        for (const ref of refs) {
          if (previous.some(row => (JSON.parse(row.progress_refs) as SourceRef[]).some(old => old.kind === ref.kind && old.id === ref.id)))
            throw new SideraError("conflict", "Repeated progress cannot fuel another continuation");
          const observed = ref.kind === "subjectivity" ? this.db.prepare(`SELECT 1 FROM node_subjectivity
            WHERE node_id = ? AND CAST(revision AS TEXT) = ? AND updated_at >= (SELECT created_at FROM task_runs WHERE run_id = ?)`)
            .get(caller.nodeId, ref.id, run.run_id) : ref.kind === "event" ? this.db.prepare(`SELECT 1 FROM events WHERE event_id = ?
              AND created_at >= (SELECT created_at FROM task_runs WHERE run_id = ?)
              AND (actor_node_id = ? OR json_extract(payload,'$.targetNodeId') = ?)`)
            .get(ref.id, run.run_id, caller.nodeId, caller.nodeId) : null;
          if (!observed) throw new SideraError("conflict", "Progress must cite a new authorized event or subjectivity revision");
        }
      }
      reserveCapability(this.db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
        requestId: input.requestId, capability: "self.runtime.checkpoint", resource: `node/${caller.nodeId}/runtime` });
      this.db.prepare("INSERT INTO run_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(run.run_id, input.requestId, input.outcome, input.tensionId ?? null, input.checkpoint, JSON.stringify(refs), new Date().toISOString());
      this.db.prepare("UPDATE task_runs SET checkpoint = ? WHERE run_id = ?").run(input.checkpoint, run.run_id);
      this.event(caller.nodeId, "runtime.checkpoint", { runId: run.run_id, outcome: input.outcome, tensionId: input.tensionId ?? null });
      return { outcome: input.outcome, runId: run.run_id };
    });
  }

  private event(nodeId: string, kind: string, payload: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), nodeId, kind, JSON.stringify(payload), new Date().toISOString());
  }

  private async hydrateUnsentWake(run: Run): Promise<Run> {
    if (!this.prepareWake) return run;
    await this.prepareWake(run.run_id, run.session_id, sessionId => withTransaction(this.db, "hydrate_wake", () => {
      const original = getMessage(this.db, run.message_id);
      if (original.state !== "queued" || this.run(run.run_id).turn_open)
        throw new SideraError("conflict", "Only an unsent wake can be superseded after explicit handoff");
      const nodeId = getTask(this.db, run.task_id).task.centerNodeId;
      reserveCapability(this.db, { subjectNodeId: nodeId, sessionId,
        requestId: `hydrate:${run.run_id}`, capability: "self.task.resume", resource: `node/${nodeId}/session/${sessionId}` });
      // Original pinned target is immutable. It was never sent; this is a new authorized self-wake.
      this.db.prepare("UPDATE messages SET state = 'failed' WHERE message_id = ?").run(original.messageId);
      if (original.reservationId) settleReservation(this.db, original.reservationId, "released");
      const wake = enqueueMessage(this.db, { requestId: `hydrate:${run.run_id}`, taskId: run.task_id,
        logicalActionId: ensureMessageAction(this.db, original.messageId),
        fromNodeId: nodeId, toNodeId: nodeId, targetSessionId: sessionId, kind: "wake",
        body: JSON.stringify({ type: "fresh_session_wake", sourceMessageId: original.messageId,
          sourceNodeId: original.fromNodeId, transportObservation: "The original message was never sent; its fixed old Session retired. This new authorized self-wake carries its result/checkpoint. A failed old delivery does not mean the child Agent failed.",
          currentEvent: original.body }) });
      this.db.prepare("UPDATE task_runs SET session_id = ?, message_id = ? WHERE run_id = ?")
        .run(sessionId, wake.messageId, run.run_id);
      this.event(nodeId, "runtime.wake_handoff", { runId: run.run_id, sourceMessageId: original.messageId,
        wakeMessageId: wake.messageId, fromSessionId: run.session_id, toSessionId: sessionId,
        sourceWasUnsent: true, transcriptReplay: false });
    }));
    return this.run(run.run_id);
  }

  submit(input: DispatchInput, parent?: { runId: string; checkpoint: string }) {
    const submitted=withTransaction(this.db, "continuation_submit", () => {
      let run: Run | undefined;
      if (parent) {
        run = this.run(parent.runId);
        input = { ...input, basis: input.basis ?? taskBasis(this.db, run.task_id) };
        const task = getTask(this.db, run.task_id).task;
        if (run.session_id !== input.originSessionId || task.centerNodeId !== input.originNodeId)
          throw new SideraError("denied", "Dependency caller does not own this exact Run");
        const prior = this.db.prepare("SELECT * FROM task_dependencies WHERE parent_run_id = ?")
          .get(run.run_id) as Dependency | undefined;
        if (prior) {
          const child = getTask(this.db, prior.child_task_id);
          if (child.task.requestId !== input.requestId || child.task.centerNodeId !== input.centerNodeId ||
              child.messages[0]?.body !== input.body || run.checkpoint !== parent.checkpoint || !sameBasis(taskBasis(this.db, prior.child_task_id), input.basis))
            throw new SideraError("conflict", "Run already has another dependency");
          return { task: child.task, run: this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY rowid LIMIT 1").get(child.task.taskId) as Run,
            parentRunId: run.run_id, state: run.state };
        }
        if (run.state !== "running" || !run.turn_open)
          throw new SideraError("conflict", "Only an executing Run can yield a dependency");
      } else {
        const busy = this.db.prepare("SELECT run_id FROM task_runs WHERE session_id = ? AND turn_open = 1").all(input.originSessionId);
        const ownedObservation = input.supervisionId && busy.every(r=>this.db.prepare(`SELECT 1 FROM task_runs r
          JOIN runtime_event_tasks e USING(task_id) JOIN task_bases b USING(task_id)
          JOIN supervisions s ON s.responsibility_id=b.responsibility_id
          WHERE r.run_id=? AND s.supervision_id=? AND s.chief_node_id=? AND b.responsibility_id=?`)
          .get(r.run_id,input.supervisionId!,input.originNodeId,input.basis?.responsibilityId??null));
        if (busy.length && !ownedObservation) throw new SideraError("conflict", "An executing Agent must supply parentRunId and checkpoint");
      }
      const result = createTask(this.db, input);
      const existing = this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY rowid LIMIT 1")
        .get(result.task.taskId) as Run | undefined;
      if (existing) {
        if (parent) throw new SideraError("conflict", "Existing task cannot be attached as a new dependency");
        return { task: result.task, run: existing, state: existing.state };
      }
      this.db.prepare("INSERT INTO task_origins VALUES (?, ?)").run(result.task.taskId, input.originSessionId);
      const childRun = this.insertRun(result.task.taskId, result.firstMessage.targetSessionId, result.firstMessage.messageId);
      this.db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ?").run(result.task.taskId);
      if (run && parent) {
        this.db.prepare("INSERT INTO task_dependencies VALUES (?, ?, 'waiting', NULL, NULL)").run(run.run_id, result.task.taskId);
        this.db.prepare("UPDATE task_runs SET state = 'waiting_dependency', checkpoint = ? WHERE run_id = ?")
          .run(parent.checkpoint, run.run_id);
        this.db.prepare("UPDATE tasks SET state = 'waiting_dependency' WHERE task_id = ?").run(run.task_id);
        this.event(input.originNodeId, "runtime.wait_requested", { runId: run.run_id, childTaskId: result.task.taskId });
      }
      return { task: getTask(this.db, result.task.taskId).task, run: childRun,
        parentRunId: run?.run_id, state: run ? "waiting_dependency" : "running" };
    });
    // Admission records scheduling intent. Execution needs fresh correlated
    // evidence; a newly allocated Run cannot advertise itself as running.
    const execution=executionReality(this.db,submitted.run.run_id);
    return {...submitted,schedulingState:submitted.state,
      state:submitted.state==="running"&&!execution.authoritativeRunning?"unknown":submitted.state,
      run:{...submitted.run,schedulingState:submitted.run.state,execution,
        state:submitted.run.state==="running"&&!execution.authoritativeRunning?"unknown":submitted.run.state}};
  }

  async wakeObservations(): Promise<void> {
    const targets = this.db.prepare("SELECT DISTINCT target_node_id FROM runtime_observations WHERE state='queued'").all() as {target_node_id:string}[];
    for (const target of targets) {
      const active = this.db.prepare("SELECT * FROM sessions WHERE node_id=? AND state='active'").get(target.target_node_id) as
        {session_id:string;hythe_id:string} | undefined;
      const pending=this.db.prepare(`SELECT o.event_id,e.kind,e.payload,e.created_at FROM runtime_observations o JOIN events e USING(event_id)
        WHERE o.target_node_id=? AND o.state='queued' ORDER BY o.rowid LIMIT 64`)
        .all(target.target_node_id) as {event_id:string;kind:string;payload:string;created_at:string}[];
      if (!pending.length || !active || !readSessionHostCondition(this.db,active.session_id).canExecute ||
        this.db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state IN ('running','waiting_dependency','uncertain'))").get(active.session_id) ||
        this.hasStandaloneTurn(active.session_id) ||
        this.db.prepare("SELECT 1 FROM messages WHERE target_session_id=? AND kind IN ('cooperation','context-handoff','result') AND state='queued'").get(active.session_id) ||
        !this.hythes.get(active.hythe_id)?.canStartTurn?.()) continue;
      // An event is a wake cause, not an invented execution basis. Use only an
      // accepted owned Responsibility with a current, unambiguous recorded Intent.
      const bases = this.db.prepare(`SELECT r.responsibility_id,r.created_at,b.intent_revision_id,b.context_basis_json,t.tension_id
        FROM responsibilities r JOIN responsibility_bases b USING(responsibility_id)
        JOIN intent_revisions revision ON revision.revision_id=b.intent_revision_id AND revision.world_id=b.world_id
        JOIN tensions t ON t.responsibility_id=r.responsibility_id AND t.node_id=r.owner_node_id AND t.kind='commitment'
        WHERE r.owner_node_id=? AND r.state='active' AND r.accepted_at IS NOT NULL AND r.deferred_at IS NULL
          AND t.status IN ('open','waiting') AND NOT EXISTS(SELECT 1 FROM intent_revisions child WHERE child.parent_revision_id=revision.revision_id)
          AND (SELECT count(*) FROM intent_revisions leaf WHERE leaf.intent_id=revision.intent_id
            AND NOT EXISTS(SELECT 1 FROM intent_revisions child WHERE child.parent_revision_id=leaf.revision_id))=1`)
        .all(target.target_node_id) as { responsibility_id: string; created_at: string; intent_revision_id: string; context_basis_json: string; tension_id: string }[];
      const related = pending.map(event => {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        const task = payload.taskId ?? payload.childTaskId;
        const linked = payload.responsibilityId ?? (task ? this.db.prepare("SELECT responsibility_id FROM task_bases WHERE task_id=?").get(String(task))?.responsibility_id : null);
        const candidates = bases.filter(b => Date.parse(event.created_at) >= Date.parse(b.created_at) &&
          (linked ? b.responsibility_id === linked : payload.tensionId ? b.tension_id === payload.tensionId : true));
        // Multiple unrelated obligations need a subject's selection; Core does
        // not choose a goal merely because one row happens to sort first.
        return { event, basis: candidates.length === 1 ? candidates[0] : null };
      }).filter(item => item.basis);
      if (!related.length) continue;
      const basis = related[0]!.basis!, events = related.filter(item => item.basis!.responsibility_id === basis.responsibility_id).map(item => item.event);
      const context = JSON.parse(basis.context_basis_json) as unknown;
      if (!Array.isArray(context) || !context.length || !context.every(ref => typeof ref === "string" && ref.trim())) continue;
      if (this.admitObservation && !await this.admitObservation(target.target_node_id)) continue;
      withTransaction(this.db,"observation_wake",()=>{
        // Another committed event may have admitted this batch during the live
        // observation above. Its durable identity must not be replayed.
        if (!this.db.prepare("SELECT 1 FROM runtime_observations WHERE event_id=? AND target_node_id=? AND state='queued'")
          .get(events[0]!.event_id,target.target_node_id)) return;
        // A canonical cooperation/result turn already carries the event's work.
        // Without an explicit causal mapping, preserve observations as queued;
        // never acknowledge them merely because a turn happens to be present.
        if (this.hasStandaloneTurn(active.session_id) || this.db.prepare("SELECT 1 FROM messages WHERE target_session_id=? AND kind IN ('cooperation','context-handoff','result') AND state='queued'")
          .get(active.session_id) || this.db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state IN ('running','waiting_dependency','uncertain'))")
          .get(active.session_id)) return;
        // Live Host admission is asynchronous. It cannot preserve a superseded
        // Intent, transferred obligation or old Session through that interval.
        if (!this.db.prepare(`SELECT 1 FROM responsibilities r JOIN responsibility_bases b USING(responsibility_id)
          JOIN intent_revisions revision ON revision.revision_id=b.intent_revision_id
          JOIN tensions t ON t.responsibility_id=r.responsibility_id
          JOIN sessions s ON s.node_id=r.owner_node_id
          WHERE r.responsibility_id=? AND r.owner_node_id=? AND r.state='active' AND r.accepted_at IS NOT NULL
            AND r.deferred_at IS NULL AND b.intent_revision_id=? AND b.context_basis_json=?
            AND t.tension_id=? AND t.node_id=r.owner_node_id AND t.status IN ('open','waiting')
            AND s.session_id=? AND s.state='active'
            AND NOT EXISTS(SELECT 1 FROM intent_revisions child WHERE child.parent_revision_id=revision.revision_id)
            AND (SELECT count(*) FROM intent_revisions leaf WHERE leaf.intent_id=revision.intent_id
              AND NOT EXISTS(SELECT 1 FROM intent_revisions child WHERE child.parent_revision_id=leaf.revision_id))=1`)
          .get(basis.responsibility_id,target.target_node_id,basis.intent_revision_id,basis.context_basis_json,basis.tension_id,active.session_id)) return;
        const submitted = this.submit({requestId:`event:${events[0]!.event_id}:${target.target_node_id}`,
          originNodeId:target.target_node_id,originSessionId:active.session_id,centerNodeId:target.target_node_id,
          workerNodeIds:[],basis:{responsibilityId:basis.responsibility_id,intentRevisionId:basis.intent_revision_id,
            contextBasis:[...context,...events.map(e=>`event:${e.event_id}`),`tension:${basis.tension_id}`]},
          body:JSON.stringify({type:"world_observation",events:events.map(e=>({eventId:e.event_id,kind:e.kind,payload:JSON.parse(e.payload)})),
            principle:"Event wakes Nodes; tension moves them. These observations are not replay instructions."}),
          authorityCapability:"self.task.resume"});
        this.db.prepare("INSERT OR IGNORE INTO runtime_event_tasks VALUES (?,?,?)").run(submitted.task.taskId,events[0]!.event_id,target.target_node_id);
        for(const observation of events) this.db.prepare("UPDATE runtime_observations SET state='admitted',message_id=? WHERE event_id=? AND target_node_id=?")
          .run(submitted.run.message_id,observation.event_id,target.target_node_id);
      });
    }
    await this.pump();
  }

  private fail(run: Run, state: "failed" | "uncertain", closeTurn = true, reason = ""): void {
    this.db.prepare("UPDATE task_runs SET state = ?, turn_open = ? WHERE run_id = ?")
      .run(state, closeTurn ? 0 : run.turn_open, run.run_id);
    if (state === "uncertain" && closeTurn)
      this.db.prepare("UPDATE messages SET state = 'uncertain' WHERE message_id = ? AND state IN ('sending','delivered')")
        .run(run.message_id);
    this.db.prepare("UPDATE tasks SET state = ? WHERE task_id = ?").run(state, run.task_id);
    const failedTask = getTask(this.db,run.task_id).task;
    this.onResult?.({taskId:run.task_id,originNodeId:failedTask.originNodeId,body:reason,messageId:run.message_id,state});
    const linked=supervisionForTask(this.db,run.task_id);
    if(linked && !this.db.prepare("SELECT 1 FROM supervision_rounds WHERE supervision_id=? AND task_id=?")
      .get(linked.supervisionId,run.task_id)){
      const roundIndex=Number(this.db.prepare("SELECT count(*) n FROM supervision_tasks WHERE supervision_id=?")
        .get(linked.supervisionId)!.n);
      recordRound(this.db,{supervisionId:linked.supervisionId,roundIndex,agentNodeId:failedTask.centerNodeId,
        taskId:run.task_id,resultMessageId:null});
      const basis=taskBasis(this.db,run.task_id);
      const message=getMessage(this.db,run.message_id);
      const attempt=this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1")
        .get(run.message_id) as {attempt_id:string}|undefined;
      this.event(failedTask.originNodeId,"supervision.round_failed",{
        targetNodeId:failedTask.originNodeId,responsibilityId:basis?.responsibilityId ?? null,
        supervisionId:linked.supervisionId,roundIndex,taskId:run.task_id,runId:run.run_id,
        messageId:run.message_id,hostRef:message.hostRef,state,reason:reason.slice(0,2000),
        effectState:attempt?effectKnowledge(this.db,attempt.attempt_id):"UNKNOWN",replay:false,
      });
    }
    const dep = this.db.prepare("SELECT * FROM task_dependencies WHERE child_task_id = ?").get(run.task_id) as Dependency | undefined;
    if (dep && dep.state === "waiting") {
      this.db.prepare("UPDATE task_dependencies SET state = ? WHERE parent_run_id = ?").run(state, dep.parent_run_id);
      // Failure is a world observation for the Supervisor, not a replay or success result.
      // Its own confirmed WAIT turn remains recoverable even if the child effect is uncertain.
      const parent = this.run(dep.parent_run_id);
      this.event(getTask(this.db, parent.task_id).task.centerNodeId, "runtime.dependency_failed", {
        parentRunId: parent.run_id, childTaskId: run.task_id, childRunId: run.run_id, state });
    }
  }

  async pump(): Promise<void> {
    this.dirty = true;
    if (this.pumping) return this.pumping;
    this.pumping = this.drain();
    try { await this.pumping; } finally { this.pumping = null; }
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const failures = this.db.prepare(`SELECT * FROM task_dependencies WHERE state IN ('failed','uncertain')
        AND continuation_run_id IS NULL`).all() as Dependency[];
      for (const dep of failures) {
        const parent = this.run(dep.parent_run_id);
        const task = getTask(this.db, parent.task_id).task;
        if (parent.turn_open || !["waiting_dependency","completed"].includes(parent.state) || task.state !== "waiting_dependency") continue;
        withTransaction(this.db, "dependency_failure_wake", () => {
          const active = this.db.prepare("SELECT session_id,state FROM sessions WHERE node_id = ? AND session_id=?")
            .get(task.centerNodeId,parent.session_id) as { session_id: string;state:string } | undefined;
          if (!active) return;
          if(active.state!=="active"&&!isExecutorRuntimeSession(this.db,task.centerNodeId,active.session_id))return;
          try { reserveCapability(this.db, { subjectNodeId: task.centerNodeId, sessionId: active.session_id,
            requestId: `failure:${parent.run_id}`, capability: "self.task.resume",
            resource: `node/${task.centerNodeId}/session/${active.session_id}` }); }
          catch { return; }
          const wake = enqueueMessage(this.db, { requestId: `failure:${parent.run_id}`, taskId: parent.task_id,
            fromNodeId: task.centerNodeId, toNodeId: task.centerNodeId, targetSessionId: active.session_id,
            kind: "wake", body: JSON.stringify({ type: "dependency_failure", parentRunId: parent.run_id,
              childTaskId: dep.child_task_id, dependencyState: dep.state, checkpoint: parent.checkpoint,
              observation: "The child has no confirmed completed result. Its original Task/Message and reservations are preserved; it was not resent. Your own WAIT turn ended. Decide how to reconcile or progress within your Authority; do not blindly retry the child or claim it completed." }) });
          const continuation = this.insertRun(parent.task_id, active.session_id, wake.messageId);
          this.db.prepare("UPDATE task_dependencies SET continuation_run_id = ? WHERE parent_run_id = ?")
            .run(continuation.run_id,parent.run_id); // Keep the child's failed/uncertain evidence unchanged.
          this.db.prepare("UPDATE task_runs SET state = 'completed' WHERE run_id = ?").run(parent.run_id);
          this.db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ?").run(parent.task_id);
          this.event(task.centerNodeId,"runtime.dependency_failure_wake",{parentRunId:parent.run_id,
            childTaskId:dep.child_task_id,continuationRunId:continuation.run_id,childState:dep.state,childReplay:false});
        });
      }
      const satisfied = this.db.prepare("SELECT * FROM task_dependencies WHERE state = 'satisfied'").all() as Dependency[];
      for (const dep of satisfied) {
        const parent = this.run(dep.parent_run_id);
        if (parent.turn_open || parent.state !== "waiting_dependency") continue;
        withTransaction(this.db, "continuation_ready", () => {
          const task = getTask(this.db, parent.task_id).task;
          try {
            reserveCapability(this.db, { subjectNodeId: task.centerNodeId, sessionId: parent.session_id,
              capability: "self.task.resume", resource: `node/${task.centerNodeId}/session/${parent.session_id}`,
              requestId: `resume:${parent.run_id}`, taskId: parent.task_id });
          } catch { this.fail(parent, "uncertain"); return; }
          const continuation = this.insertRun(parent.task_id, parent.session_id, dep.result_message_id!);
          this.db.prepare("UPDATE task_dependencies SET state = 'resumed', continuation_run_id = ? WHERE parent_run_id = ?")
            .run(continuation.run_id, parent.run_id);
          this.db.prepare("UPDATE task_runs SET state = 'completed' WHERE run_id = ?").run(parent.run_id);
          this.db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ?").run(parent.task_id);
        });
      }
      const queued = this.db.prepare(`SELECT r.* FROM task_runs r JOIN messages m ON m.message_id = r.message_id
        WHERE r.state = 'running' AND r.turn_open = 0 AND m.state = 'queued' ORDER BY r.rowid`).all() as Run[];
      for (let run of queued) {
        // Historical queued messages remain pinned to their original Session.
        // Startup must not invoke a fresh-wake strategy for a retired/standby
        // target or rewrite its evidence merely because another Session exists.
        if (!this.db.prepare(`SELECT 1 FROM sessions s JOIN messages m ON m.target_session_id=s.session_id
          WHERE m.message_id=? AND s.session_id=? AND (s.state='active' OR (s.state='standby' AND EXISTS(SELECT 1 FROM operator_executors e WHERE e.session_id=s.session_id AND e.routing_admitted=1 AND e.context_state='usable')))`)
          .get(run.message_id, run.session_id)) continue;
        if (this.hasStandaloneTurn(run.session_id)) continue;
        if (this.db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND turn_open=1").get(run.session_id)) continue;
        const observation=this.db.prepare("SELECT 1 FROM runtime_event_tasks WHERE task_id=?").get(run.task_id);
        // Historical uncertainty from an observation-only wake must not occupy
        // the execution lane forever. It remains preserved for audit/reconcile,
        // but only uncertain real work blocks a new non-observation Run.
        if(!observation && this.db.prepare(`SELECT 1 FROM task_runs u WHERE u.session_id=? AND u.state='uncertain'
          AND NOT EXISTS(SELECT 1 FROM runtime_event_tasks e WHERE e.task_id=u.task_id)`).get(run.session_id)) continue;
        if(!readSessionHostCondition(this.db,run.session_id).canExecute) continue;
        try { run = await this.hydrateUnsentWake(run); }
        catch { this.fail(run, "uncertain"); continue; }
        if(run.state!=="running" || getMessage(this.db,run.message_id).state!=="queued" || this.hasStandaloneTurn(run.session_id))continue;
        if(this.executionOwnerId)this.db.prepare("INSERT OR REPLACE INTO run_execution_owners VALUES (?,?)").run(run.run_id,this.executionOwnerId);
        this.db.prepare("UPDATE task_runs SET turn_open = 1 WHERE run_id = ?").run(run.run_id);
        const delivered = await deliverMessage(this.db, run.message_id, this.hythes);
        if(delivered.state==="delivered") {
          const attempt=this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1").get(run.message_id);
          // This pump still owns an open, correlated turn. Evidence expires and
          // is never reconstructed from an old host_ref after restart.
          if(attempt)recordExecutionProgress(this.db,run.run_id,String(attempt.attempt_id),`executor:open-turn:${delivered.hostRef}`);
        }
        if (delivered.state === "failed" || delivered.state === "uncertain") {
          this.fail(run, delivered.state); this.dirty = true;
        }
      }
      // A root result still travels through MessageBus; a return-only GPT backend
      // cannot acknowledge it when there is no live tool return channel.
      const results = this.db.prepare(`SELECT m.message_id, m.target_session_id FROM messages m
        JOIN task_origins o ON o.task_id = m.task_id
        WHERE m.kind = 'result' AND m.state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM task_dependencies d WHERE d.child_task_id = m.task_id)`)
        .all() as { message_id: string; target_session_id: string }[];
      for (const result of results) {
        const queuedMessage=getMessage(this.db,result.message_id);
        const task=getTask(this.db,queuedMessage.taskId!).task;
        let targetSessionId=result.target_session_id;
        if(this.prepareNodeWake){
          try{
            targetSessionId=await this.prepareNodeWake(`result-return:${result.message_id}`,task.originNodeId,targetSessionId,nextSessionId=>{
              const changed=this.db.prepare("UPDATE messages SET target_session_id=? WHERE message_id=? AND target_session_id=? AND state='queued'")
                .run(nextSessionId,result.message_id,result.target_session_id);
              if(Number(changed.changes)!==1)throw new SideraError("conflict","Queued result routing changed during fresh return handoff");
            });
          }catch(error){
            this.event(task.originNodeId,"runtime.result_return_prepare_failed",{messageId:result.message_id,taskId:task.taskId,
              targetSessionId,reason:error instanceof Error?error.message:"Return Session preparation failed",replay:false});
            continue;
          }
        }
        await this.presentRootResult?.(result.message_id);
        if (this.db.prepare("SELECT 1 FROM task_runs WHERE session_id = ? AND (turn_open = 1 OR state = 'uncertain')")
          .get(targetSessionId)) continue;
        if(this.hasStandaloneTurn(targetSessionId))continue;
        const delivery = await deliverMessage(this.db, result.message_id, this.hythes);
        this.onResult?.({taskId:task.taskId,originNodeId:task.originNodeId,body:delivery.body,messageId:delivery.messageId,state:delivery.state});
      }
    }
  }

  async ingest(sessionId: string, event: HostMessage): Promise<boolean> {
    const run = this.db.prepare("SELECT * FROM task_runs WHERE message_id = ?").get(event.observedMessageId ?? "") as Run | undefined;
    if (!run) return false;
    if (run.session_id !== sessionId) throw new SideraError("denied", "Host result came from another Session");
    // A very fast Host completion can arrive before invoke's acceptance has
    // been persisted. Wait for that in-flight delivery, never poll or resend.
    if (getMessage(this.db, run.message_id).state === "sending" && this.pumping)
      await this.pumping;
    const message = getMessage(this.db, run.message_id);
    if (message.hostRef !== event.hostRef) throw new SideraError("conflict", "Host turn reference does not match Run");
    if (!run.turn_open) return true; // Already settled; never double-complete or re-wake.
    const attempt=this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1").get(run.message_id);
    if(attempt && ["accepted","uncertain"].includes(effectKnowledge(this.db,String(attempt.attempt_id))))
      observeEffect(this.db,String(attempt.attempt_id),event.outcome==="completed"?"completed":"uncertain",`correlated-host-turn:${event.hostRef}`);
    try { withTransaction(this.db, "continuation_result", () => {
      this.db.prepare("UPDATE task_runs SET turn_open = 0 WHERE run_id = ?").run(run.run_id);
      if (event.outcome !== "completed") {
        this.event(getTask(this.db, run.task_id).task.centerNodeId, "runtime.host_failure", {
          taskId: run.task_id, runId: run.run_id, sessionId,
          messageId: run.message_id, reason: event.body.slice(0, 2000), replay: false,
        });
        this.fail(run, "uncertain",true,event.body.slice(0,2000)); return;
      }
      if (message.state === "delivered") ackMessage(this.db, message.messageId, sessionId);
      if (run.state === "waiting_dependency") {
        this.event(getTask(this.db, run.task_id).task.centerNodeId, "runtime.wait_entered", { runId: run.run_id, turnOpen: false });
        return; // Turn ended; parent Task did not. No inference until the dependency event.
      }
      if (run.state !== "running") return;
      if (!event.body.trim()) { this.fail(run, "uncertain"); return; }
      const task = getTask(this.db, run.task_id).task;
      const checkpoint = this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id = ?").get(run.run_id) as
        { outcome: string; checkpoint: string; tension_id: string } | undefined;
      if (checkpoint?.outcome === "CONTINUE") {
        const tension = getTension(this.db, checkpoint.tension_id);
        if (!["open","waiting"].includes(tension.status)) { this.fail(run, "failed"); return; }
        reserveCapability(this.db, { subjectNodeId: task.centerNodeId, sessionId,
          requestId: `continue:${run.run_id}`, capability: "self.task.resume", resource: `node/${task.centerNodeId}/runtime` });
        const wake = enqueueMessage(this.db, { requestId: `continue:${run.run_id}`, taskId: run.task_id,
          fromNodeId: task.centerNodeId, toNodeId: task.centerNodeId, targetSessionId: sessionId, kind: "wake",
          body: JSON.stringify({ type: "continue", tensionId: tension.tensionId, checkpoint: checkpoint.checkpoint }) });
        this.insertRun(run.task_id, sessionId, wake.messageId);
        this.db.prepare("UPDATE task_runs SET state = 'completed' WHERE run_id = ?").run(run.run_id);
        this.event(task.centerNodeId, "runtime.continue", { runId: run.run_id, tensionId: tension.tensionId });
        this.dirty = true;
        return;
      }
      const observation = this.db.prepare("SELECT 1 FROM runtime_event_tasks WHERE task_id=?").get(run.task_id);
      if (observation) {
        this.db.prepare("UPDATE task_runs SET state='completed' WHERE run_id=?").run(run.run_id);
        this.db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(run.task_id);
        this.event(task.centerNodeId,"runtime.observation_completed",{taskId:run.task_id,runId:run.run_id});
        return; // Archive an observation turn; never feed its answer back into another turn.
      }
      const origin = this.db.prepare("SELECT session_id FROM task_origins WHERE task_id = ?").get(run.task_id) as { session_id: string };
      const dep = this.db.prepare("SELECT * FROM task_dependencies WHERE child_task_id = ?").get(run.task_id) as Dependency | undefined;
      const parent = dep ? this.run(dep.parent_run_id) : null;
      const body = parent ? JSON.stringify({ type: "continuation", parentTaskId: parent.task_id,
        parentRunId: parent.run_id, childTaskId: run.task_id, childRunId: run.run_id,
        checkpoint: parent.checkpoint, result: event.body }) : event.body;
      const result = sendMessage(this.db, { requestId: `result:${run.run_id}`, taskId: run.task_id,
        fromNodeId: task.centerNodeId, fromSessionId: sessionId, toNodeId: task.originNodeId,
        targetSessionId: origin.session_id, kind: "result", body });
      this.db.prepare("UPDATE task_runs SET state = 'completed' WHERE run_id = ?").run(run.run_id);
      this.db.prepare("UPDATE tasks SET state = 'completed' WHERE task_id = ?").run(run.task_id);
      const linked=supervisionForTask(this.db,run.task_id);
      if(linked){
        const roundIndex=Number(this.db.prepare("SELECT count(*) n FROM supervision_tasks WHERE supervision_id=?").get(linked.supervisionId)!.n);
        recordRound(this.db,{supervisionId:linked.supervisionId,roundIndex,agentNodeId:task.centerNodeId,taskId:run.task_id,resultMessageId:result.messageId});
        this.event(task.originNodeId,"supervision.round_completed",{supervisionId:linked.supervisionId,roundIndex,messageId:result.messageId,taskId:run.task_id,sourceHostTurn:event.hostRef});
      }
      if (dep) this.db.prepare("UPDATE task_dependencies SET state = 'satisfied', result_message_id = ? WHERE parent_run_id = ?")
        .run(result.messageId, dep.parent_run_id);
    }); } catch (error) {
      this.fail(run, "uncertain");
      throw error;
    }
    await this.pump();
    return true;
  }

  /** Explicit repair of LOCAL result routing after a confirmed provider completion.
   * UNKNOWN provider effects, WAIT and resource-loss cases cannot enter this path.
   * Reuses the original result ID and current Authority; no Host prompt is resent. */
  async reconcileCompletedResult(runId:string):Promise<void> {
    const run=this.run(runId),message=getMessage(this.db,run.message_id);
    if(this.db.prepare("SELECT 1 FROM runtime_event_tasks WHERE task_id=?").get(run.task_id)) {
      if(run.state==="completed")return;
      const session=this.db.prepare("SELECT hythe_id,locator_ref,state FROM sessions WHERE session_id=?").get(run.session_id);
      if(session && session.state!=="active" && !isExecutorRuntimeSession(this.db,message.toNodeId,run.session_id))
        throw new SideraError("unavailable","Original observation Session is not an admitted runtime context; no replay");
      const adapter=session?this.hythes.get(String(session.hythe_id)):undefined;
      const event=message.hostRef && adapter?.completedTurn ? await adapter.completedTurn(String(session!.locator_ref),message.hostRef,message.messageId) : null;
      if(event?.outcome!=="completed" || event.hostRef!==message.hostRef || event.observedMessageId!==message.messageId)
        throw new SideraError("unavailable","Original observation turn has no exact provider completion; no replay");
      withTransaction(this.db,"observation_reconcile",()=>{
        const current=this.run(runId);
        if(current.state==="completed")return;
        if(current.session_id!==run.session_id || getMessage(this.db,run.message_id).hostRef!==event.hostRef)
          throw new SideraError("conflict","Observation routing changed during terminal read");
        const attempt=this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1").get(message.messageId);
        if(attempt && ["accepted","uncertain"].includes(effectKnowledge(this.db,String(attempt.attempt_id))))
          observeEffect(this.db,String(attempt.attempt_id),"completed",`correlated-host-turn:${event.hostRef}`);
        this.db.prepare("UPDATE task_runs SET state='completed',turn_open=0 WHERE run_id=?").run(runId);
        this.db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(run.task_id);
        this.db.prepare("UPDATE messages SET state='observed' WHERE message_id=?").run(message.messageId);
        this.event(message.toNodeId,"runtime.observation_reconciled",{runId,taskId:run.task_id,messageId:message.messageId,hostRef:event.hostRef,replay:false});
      });
      return; // Observation replies never generate another self-result turn.
    }
    const prior=this.db.prepare("SELECT message_id FROM messages WHERE from_node_id=? AND request_id=?")
      .get(message.toNodeId,`result:${runId}`);
    if(prior && run.state==="completed")return;
    const attempt=this.db.prepare("SELECT attempt_id FROM action_attempts WHERE source_message_id=? ORDER BY generation DESC LIMIT 1").get(run.message_id);
    if(run.state!=="uncertain" || run.turn_open || !message.hostRef || !attempt || effectKnowledge(this.db,String(attempt.attempt_id))!=="completed")
      throw new SideraError("unavailable","Reconciliation requires confirmed provider completion, not an unknown Effect");
    if(this.db.prepare("SELECT 1 FROM task_dependencies WHERE child_task_id=? OR parent_run_id=?").get(run.task_id,runId) ||
      this.db.prepare("SELECT 1 FROM run_checkpoints WHERE run_id=?").get(runId))
      throw new SideraError("unavailable","Dependency/checkpoint recovery requires its own reconciliation");
    const session=this.db.prepare("SELECT hythe_id,locator_ref FROM sessions WHERE session_id=?").get(run.session_id)!;
    const hythe=this.hythes.get(String(session.hythe_id));
    if(!hythe?.completedTurn)throw new SideraError("unavailable","Host has no supported terminal turn read");
    const event=await hythe.completedTurn(String(session.locator_ref),message.hostRef,message.messageId);
    if(event?.outcome!=="completed" || event.hostRef!==message.hostRef || event.observedMessageId!==message.messageId || !event.body.trim())
      throw new SideraError("conflict","Exact provider completion was not confirmed");
    withTransaction(this.db,"confirmed_result_reconciliation",()=>{
      const current=this.run(runId);
      if(current.state!=="uncertain" || current.turn_open || effectKnowledge(this.db,String(attempt.attempt_id))!=="completed")
        throw new SideraError("conflict","Result state changed during provider read");
      const task=getTask(this.db,run.task_id).task;
      const origin=this.db.prepare("SELECT session_id FROM task_origins WHERE task_id=?").get(run.task_id)!;
      // This is the same authorized canonical result path, including message.send.
      const result=sendMessage(this.db,{requestId:`result:${runId}`,taskId:run.task_id,fromNodeId:task.centerNodeId,
        fromSessionId:run.session_id,toNodeId:task.originNodeId,targetSessionId:String(origin.session_id),kind:"result",body:event.body});
      this.db.prepare("UPDATE messages SET state='observed' WHERE message_id=?").run(message.messageId);
      this.db.prepare("UPDATE task_runs SET state='completed' WHERE run_id=?").run(runId);
      this.db.prepare("UPDATE tasks SET state='completed' WHERE task_id=?").run(run.task_id);
      const linked=supervisionForTask(this.db,run.task_id);
      if(linked){
        const roundIndex=Number(this.db.prepare("SELECT count(*) n FROM supervision_tasks WHERE supervision_id=?").get(linked.supervisionId)!.n);
        recordRound(this.db,{supervisionId:linked.supervisionId,roundIndex,agentNodeId:task.centerNodeId,taskId:run.task_id,resultMessageId:result.messageId});
        this.event(task.originNodeId,"supervision.round_completed",{supervisionId:linked.supervisionId,roundIndex,messageId:result.messageId,taskId:run.task_id,sourceHostTurn:event.hostRef,reconciled:true});
      }
      this.event(task.centerNodeId,"runtime.result_reconciled",{runId,taskId:run.task_id,messageId:message.messageId,
        resultMessageId:result.messageId,sourceRef:`provider-terminal-turn:${event.hostRef}`,providerReplay:false});
    });
    await this.pump();
  }
}

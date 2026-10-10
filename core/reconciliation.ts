import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { settleReservation } from "./authority.ts";
import { fenceSessionEffects } from "./effect-gate.ts";

export interface ResourceLoss {
  eventId: string; sessionId: string; reason: string; source: string;
  expectedRetirement?: boolean;
}

export interface LegacyEmptyTerminalReconciliation {
  runId: string;
  evidenceEventId: string;
}

export interface CorrelatedHostFailureReconciliation {
  runId: string;
  evidenceEventId: string;
}

/** A correlated Host failure ends scheduling occupancy but does not resolve an
 * uncertain provider Effect. The Effect evidence remains uncertain and MUST
 * NOT be replayed. This only records that the semantic Task did not complete. */
export function reconcileCorrelatedHostFailure(db: DatabaseSync, input: CorrelatedHostFailureReconciliation) {
  return withTransaction(db,"correlated_host_failure_reconciliation",()=>{
    const run=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(input.runId) as
      {run_id:string;task_id:string;session_id:string;message_id:string;state:string;turn_open:number}|undefined;
    if(!run)throw new Error("Run not found");
    if(run.state!=="uncertain"||run.turn_open!==0)throw new Error("Correlated failure requires a closed uncertain Run");
    const message=db.prepare("SELECT message_id,target_session_id,state,host_ref FROM messages WHERE message_id=?").get(run.message_id) as
      {message_id:string;target_session_id:string;state:string;host_ref:string|null}|undefined;
    if(!message||message.target_session_id!==run.session_id||!message.host_ref)
      throw new Error("Exact message Host reference required");
    const event=db.prepare("SELECT kind,payload FROM events WHERE event_id=?").get(input.evidenceEventId) as
      {kind:string;payload:string}|undefined;
    if(!event||event.kind!=="runtime.host_failure")throw new Error("Exact runtime.host_failure evidence required");
    const failure=JSON.parse(event.payload) as Record<string,unknown>;
    if(failure.runId!==run.run_id||failure.taskId!==run.task_id||failure.sessionId!==run.session_id||
       failure.messageId!==run.message_id||failure.replay!==false)
      throw new Error("Host failure evidence does not match exact Run");
    const attempt=db.prepare("SELECT a.attempt_id,e.state FROM action_attempts a JOIN effect_attempt_state e USING(attempt_id) WHERE a.source_message_id=? ORDER BY a.generation DESC LIMIT 1")
      .get(run.message_id) as {attempt_id:string;state:string}|undefined;
    if(!attempt||attempt.state!=="uncertain")throw new Error("Correlated failure requires preserved uncertain Effect evidence");
    const observed=db.prepare("SELECT 1 FROM effect_audit WHERE attempt_id=? AND kind='observation.uncertain' AND json_extract(detail_json,'$.sourceRef')=?")
      .get(attempt.attempt_id,`correlated-host-turn:${message.host_ref}`);
    if(!observed)throw new Error("Correlated Host failure audit is missing");
    db.prepare("UPDATE task_runs SET state='failed',turn_open=0 WHERE run_id=?").run(run.run_id);
    db.prepare("UPDATE tasks SET state='failed' WHERE task_id=? AND state='uncertain'").run(run.task_id);
    db.prepare("UPDATE task_dependencies SET state='failed' WHERE child_task_id=? AND state='uncertain'").run(run.task_id);
    const eventId=randomUUID();
    db.prepare("INSERT INTO events VALUES (?,?,'runtime.correlated_host_failure_reconciled',?,?)")
      .run(eventId,null,JSON.stringify({runId:run.run_id,taskId:run.task_id,messageId:run.message_id,
        evidenceEventId:input.evidenceEventId,effectAttemptId:attempt.attempt_id,effectState:"uncertain",
        taskCompleted:false,businessEffects:"UNKNOWN",replay:false}),new Date().toISOString());
    return {runId:run.run_id,taskId:run.task_id,state:"failed",effectState:"uncertain",taskCompleted:false,
      businessEffects:"UNKNOWN",replay:false,evidenceEventId:input.evidenceEventId};
  });
}
export interface LegacyObservationArchive { runId:string; }

/** Archive a pre-Effect observation-only wake whose provider outcome remains
 * unknown. The observation is explicitly failed, not completed; provider-side
 * business effects stay UNKNOWN and the original Host turn is never replayed. */
export function archiveLegacyUncertainObservation(db:DatabaseSync,input:LegacyObservationArchive) {
  return withTransaction(db,"legacy_uncertain_observation_archive",()=>{
    const run=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(input.runId) as
      {run_id:string;task_id:string;session_id:string;message_id:string;state:string;turn_open:number}|undefined;
    if(!run || run.state!=="uncertain" || run.turn_open!==0)throw new Error("Closed uncertain Run required");
    const observation=db.prepare("SELECT event_id,target_node_id FROM runtime_event_tasks WHERE task_id=?").get(run.task_id) as
      {event_id:string;target_node_id:string}|undefined;
    if(!observation)throw new Error("Only runtime observation Tasks may be archived here");
    const task=db.prepare("SELECT origin_node_id,center_node_id FROM tasks WHERE task_id=?").get(run.task_id) as
      {origin_node_id:string;center_node_id:string}|undefined;
    if(!task || task.origin_node_id!==task.center_node_id || task.center_node_id!==observation.target_node_id)
      throw new Error("Observation Task identity is inconsistent");
    if(db.prepare("SELECT 1 FROM action_attempts WHERE source_message_id=?").get(run.message_id))
      throw new Error("M2 Effect attempts require normal Effect reconciliation");
    db.prepare("UPDATE task_runs SET state='failed' WHERE run_id=?").run(run.run_id);
    db.prepare("UPDATE tasks SET state='failed' WHERE task_id=? AND state='uncertain'").run(run.task_id);
    db.prepare("UPDATE task_dependencies SET state='failed' WHERE child_task_id=? AND state='uncertain'").run(run.task_id);
    const eventId=randomUUID(),at=new Date().toISOString();
    db.prepare("INSERT INTO events VALUES (?,?,'runtime.legacy_observation_archived',?,?)")
      .run(eventId,task.center_node_id,JSON.stringify({runId:run.run_id,taskId:run.task_id,
        sourceEventId:observation.event_id,taskCompleted:false,businessEffects:"UNKNOWN",replay:false}),at);
    return {runId:run.run_id,taskId:run.task_id,state:"failed",taskCompleted:false,businessEffects:"UNKNOWN",replay:false};
  });
}

/** Reconcile one pre-Effect legacy Run only when the Host itself recorded an
 * exact terminal SUCCESS with an empty response. This proves the Host turn
 * ended, but deliberately does NOT claim that provider-side business effects
 * were absent or that the Task succeeded. The semantic Task is therefore
 * failed, never completed, and nothing is replayed. */
export function reconcileLegacyEmptyTerminal(db: DatabaseSync, input: LegacyEmptyTerminalReconciliation) {
  return withTransaction(db, "legacy_empty_terminal_reconciliation", () => {
    const run=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(input.runId) as
      {run_id:string;task_id:string;session_id:string;message_id:string;state:string;turn_open:number}|undefined;
    if(!run)throw new Error("Run not found");
    if(run.state!=="uncertain" || run.turn_open!==0)throw new Error("Legacy reconciliation requires a closed uncertain Run");
    const message=db.prepare("SELECT * FROM messages WHERE message_id=?").get(run.message_id) as
      {message_id:string;request_id:string;target_session_id:string;state:string;host_ref:string|null}|undefined;
    if(!message || message.target_session_id!==run.session_id || message.state!=="observed" || !message.host_ref)
      throw new Error("Exact observed legacy message evidence required");
    if(db.prepare("SELECT 1 FROM action_attempts WHERE source_message_id=?").get(message.message_id))
      throw new Error("M2 Effect attempts must use normal Effect reconciliation");
    const session=db.prepare("SELECT locator_ref,node_id FROM sessions WHERE session_id=?").get(run.session_id) as
      {locator_ref:string;node_id:string}|undefined;
    if(!session)throw new Error("Session not found");
    const event=db.prepare("SELECT kind,payload,created_at FROM events WHERE event_id=?").get(input.evidenceEventId) as
      {kind:string;payload:string;created_at:string}|undefined;
    if(!event || event.kind!=="host.usage")throw new Error("Exact host.usage evidence required");
    const usage=JSON.parse(event.payload) as {requestId?:string;conversationId?:string;status?:string;responseLength?:number|null};
    if(usage.requestId!==message.request_id || usage.conversationId!==session.locator_ref ||
       usage.status!=="SUCCESS" || usage.responseLength!==0)
      throw new Error("Host terminal evidence does not match the exact legacy Run");
    const duplicates=db.prepare("SELECT count(*) n FROM events WHERE kind='host.usage' AND json_extract(payload,'$.requestId')=? AND json_extract(payload,'$.conversationId')=?")
      .get(message.request_id,session.locator_ref) as {n:number};
    if(Number(duplicates.n)!==1)throw new Error("Legacy terminal evidence is ambiguous");
    db.prepare("UPDATE task_runs SET state='failed',turn_open=0 WHERE run_id=?").run(run.run_id);
    db.prepare("UPDATE tasks SET state='failed' WHERE task_id=? AND state='uncertain'").run(run.task_id);
    db.prepare("UPDATE task_dependencies SET state='failed' WHERE child_task_id=? AND state='uncertain'").run(run.task_id);
    const eventId=randomUUID(),at=new Date().toISOString();
    db.prepare("INSERT INTO events VALUES (?,?,'runtime.legacy_terminal_empty_reconciled',?,?)")
      .run(eventId,session.node_id,JSON.stringify({runId:run.run_id,taskId:run.task_id,messageId:message.message_id,
        evidenceEventId:input.evidenceEventId,hostTurnEnded:true,taskCompleted:false,
        businessEffects:"UNKNOWN",replay:false}),at);
    return {runId:run.run_id,taskId:run.task_id,state:"failed",evidenceEventId:input.evidenceEventId,
      hostTurnEnded:true,taskCompleted:false,businessEffects:"UNKNOWN",replay:false};
  });
}

/** Loss is an observation, never a replay instruction or a fabricated result. */
export function reconcileResourceLoss(db: DatabaseSync, loss: ResourceLoss) {
  return withTransaction(db, "resource_loss", () => {
    const previous = db.prepare("SELECT session_id,result_json FROM runtime_reconciliations WHERE event_id=?")
      .get(loss.eventId) as { session_id:string;result_json: string } | undefined;
    if(previous && previous.session_id!==loss.sessionId)throw new Error("Loss event belongs to another Session");
    if (previous) return JSON.parse(previous.result_json) as { runs: string[] };
    const session = db.prepare("SELECT node_id FROM sessions WHERE session_id=?").get(loss.sessionId) as
      { node_id: string } | undefined;
    if (!session) throw new Error("Execution resource has no registered Session");
    fenceSessionEffects(db,loss.sessionId,loss.eventId);
    const runs = db.prepare(`SELECT r.*,m.state AS message_state,m.host_ref,m.reservation_id FROM task_runs r
      JOIN messages m USING(message_id) WHERE r.session_id=? AND
      (r.turn_open=1 OR r.state='running')`).all(loss.sessionId) as
      { run_id: string; task_id: string; message_id: string; message_state: string; host_ref: string | null;reservation_id:string|null }[];
    const priorHealth=db.prepare("SELECT state FROM session_health WHERE session_id=?").get(loss.sessionId);
    const changed=priorHealth?.state!=="unavailable" || runs.length>0;
    const kind=loss.expectedRetirement ? "runtime.resource_retired" : changed ? "runtime.resource_lost" : "runtime.resource_loss_observed";
    db.prepare("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)")
      .run(loss.eventId,session.node_id,kind,JSON.stringify({...loss,targetNodeId:session.node_id,changed}),new Date().toISOString());
    for (const run of runs) {
      const attempts=db.prepare(`SELECT s.state FROM action_attempts a LEFT JOIN effect_attempt_state s USING(attempt_id)
        WHERE a.source_message_id=?`).all(run.message_id);
      // Missing local state or a legacy failed message is not no-effect proof.
      const effect=attempts.length>0 && attempts.every(a=>["confirmed_no_effect","superseded"].includes(String(a.state))) ? "not_started" : "uncertain";
      const state = effect === "not_started" ? "failed" : "uncertain";
      if(effect==="not_started" && run.reservation_id && db.prepare("SELECT status FROM grant_uses WHERE reservation_id=?").get(run.reservation_id)?.status==="reserved")settleReservation(db,run.reservation_id,"released");
      db.prepare("UPDATE task_runs SET state=?,turn_open=0 WHERE run_id=?").run(state,run.run_id);
      db.prepare("UPDATE tasks SET state=? WHERE task_id=? AND state!='completed'").run(state,run.task_id);
      if (effect === "uncertain") db.prepare("UPDATE messages SET state='uncertain' WHERE message_id=? AND state IN ('sending','delivered')")
        .run(run.message_id);
      else db.prepare("UPDATE messages SET state='failed' WHERE message_id=? AND state='queued'").run(run.message_id);
      db.prepare("UPDATE task_dependencies SET state=? WHERE child_task_id=? AND state='waiting'").run(state,run.task_id);
      const task = db.prepare("SELECT origin_node_id,center_node_id FROM tasks WHERE task_id=?").get(run.task_id) as
        { origin_node_id: string; center_node_id: string };
      const at = new Date().toISOString();
      const eventId = randomUUID();
      db.prepare("INSERT INTO events VALUES (?, ?, 'runtime.execution_reconciled', ?, ?)").run(eventId,session.node_id,
        JSON.stringify({ ...loss, runId:run.run_id,taskId:run.task_id,state,effect,completed:false,replay:false,
          targetNodeId:task.origin_node_id }),at);
      // A failed observation does not recursively request another observation turn.
      const observationTask=db.prepare("SELECT 1 FROM runtime_event_tasks WHERE task_id=?").get(run.task_id);
      for (const target of observationTask ? [] : new Set([task.origin_node_id,task.center_node_id]))
        db.prepare("INSERT OR IGNORE INTO runtime_observations(event_id,target_node_id,state) VALUES (?,?,'queued')")
          .run(eventId,target);
    }
    db.prepare(`INSERT INTO session_health VALUES (?, 'unavailable', ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,event_id=excluded.event_id,updated_at=excluded.updated_at`)
      .run(loss.sessionId,loss.eventId,new Date().toISOString());
    const result = { runs:runs.map(run=>run.run_id) };
    db.prepare("INSERT INTO runtime_reconciliations VALUES (?,?,?)").run(loss.eventId,loss.sessionId,JSON.stringify(result));
    return result;
  });
}

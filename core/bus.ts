import { assertContextHandoffDisclosure } from "./shared-transfer.ts";
import { assertCooperationBasis } from "./cooperation.ts";
import { randomUUID } from "node:crypto";
import { isExecutorRuntimeSession } from "./executors.ts";
import { recordCapabilityCheck } from "./capability-truth.ts";
import { supervisionForTask,supervisionView } from "./supervision.ts";
import type { DatabaseSync } from "node:sqlite";
import { prepareEffect, effectBoundary, effectKnowledge, observeEffect, abandonPreparedEffect } from "./effect-gate.ts";
import { reserveCapability, settleReservation } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { wakeContext } from "./subjectivity.ts";
import { ensureMessageAction, SemanticStore } from "./semantics.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import type { Hythe, InvokeResult } from "../hythes/types.ts";

export type MessageState =
  | "queued" | "sending" | "delivered" | "observed" | "failed" | "uncertain";

export interface MessageRecord {
  messageId: string;
  requestId: string;
  taskId: string | null;
  fromNodeId: string;
  toNodeId: string;
  targetSessionId: string;
  sequence: number;
  kind: string;
  body: string;
  state: MessageState;
  hostRef: string | null;
  reservationId: string | null;
  createdAt: string;
}

export interface EnqueueInput {
  /** Trusted unsent wake handoff retains the logical action; not an RPC retry flag. */
  logicalActionId?: string;
  requestId: string;
  taskId?: string | null;
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  body: string;
  reservationId?: string | null;
  targetSessionId?: string;
}

export interface SendInput extends EnqueueInput {
  fromSessionId: string;
}

function fromRow(row: Record<string, unknown>): MessageRecord {
  return {
    messageId: String(row.message_id),
    requestId: String(row.request_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    targetSessionId: String(row.target_session_id),
    sequence: Number(row.sequence),
    kind: String(row.kind),
    body: String(row.body),
    state: String(row.state) as MessageState,
    hostRef: row.host_ref == null ? null : String(row.host_ref),
    reservationId: row.reservation_id == null ? null : String(row.reservation_id),
    createdAt: String(row.created_at),
  };
}

export function getMessage(db: DatabaseSync, messageId: string): MessageRecord {
  const row = db.prepare("SELECT * FROM messages WHERE message_id = ?")
    .get(messageId) as Record<string, unknown> | undefined;
  if (!row) throw new SideraError("not_found", "Message was not found");
  return fromRow(row);
}

function existingRequest(db: DatabaseSync, input: EnqueueInput): MessageRecord | null {
  const row = db.prepare("SELECT * FROM messages WHERE from_node_id = ? AND request_id = ?")
    .get(input.fromNodeId, input.requestId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const existing = fromRow(row);
  if (existing.toNodeId !== input.toNodeId || existing.taskId !== (input.taskId ?? null) ||
      existing.kind !== input.kind || existing.body !== input.body ||
      (input.targetSessionId !== undefined && existing.targetSessionId !== input.targetSessionId)) {
    throw new SideraError("conflict", "Request ID was already used for another message");
  }
  return existing;
}

/** Caller must have passed Authority; used by Scheduler inside its transaction. */
export function enqueueMessage(db: DatabaseSync, input: EnqueueInput): MessageRecord {
  requireWorld(db, recordWorld(db, "nodes", input.fromNodeId), "nodes", input.toNodeId);
  const prior = existingRequest(db, input);
  if (prior) return prior;
  const target = db.prepare(`SELECT session_id,state FROM sessions
    WHERE node_id = ? AND ((state = 'active' AND ? IS NULL) OR session_id = ?)`)
    .get(input.toNodeId, input.targetSessionId ?? null, input.targetSessionId ?? null) as
    | { session_id: string; state:string } | undefined;
  if (!target) throw new SideraError("unavailable", "Target node has no active session");
  if(target.state!=="active"&&!isExecutorRuntimeSession(db,input.toNodeId,target.session_id))
    throw new SideraError("unavailable","Exact target is not an admitted Executor runtime context");
  const seqRow = db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
    FROM messages WHERE target_session_id = ?`).get(target.session_id) as
    { next_sequence: number };
  const messageId = randomUUID();
  db.prepare(`INSERT INTO messages
    (message_id, request_id, task_id, from_node_id, to_node_id, target_session_id,
     sequence, kind, body, state, reservation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .run(messageId, input.requestId, input.taskId ?? null, input.fromNodeId,
      input.toNodeId, target.session_id, seqRow.next_sequence, input.kind,
      input.body, input.reservationId ?? null, new Date().toISOString());
  ensureMessageAction(db, messageId, input.logicalActionId);
  db.prepare("INSERT INTO events VALUES (?,?,'message.queued',?,?)").run(randomUUID(),input.fromNodeId,
    JSON.stringify({messageId,targetNodeId:input.toNodeId,taskId:input.taskId ?? null}),new Date().toISOString());
  return getMessage(db, messageId);
}

export function sendMessage(db: DatabaseSync, input: SendInput): MessageRecord {
  return withTransaction(db, "message_send", () => {
    const prior = existingRequest(db, input);
    if (prior) return prior;
    const permit = reserveCapability(db, {
      subjectNodeId: input.fromNodeId,
      sessionId: input.fromSessionId,
      capability: "message.send",
      resource: `node/${input.toNodeId}`,
      requestId: input.requestId,
      taskId: input.taskId ?? undefined,
    });
    return enqueueMessage(db, { ...input, reservationId: permit.reservationId });
  });
}

const pendingDeliveries=new WeakMap<DatabaseSync,Map<string,Promise<MessageRecord>>>();

/** Await this process's exact send settlement, never probe or replay a Host. */
export async function awaitMessageDelivery(db:DatabaseSync,messageId:string):Promise<void> {
  await pendingDeliveries.get(db)?.get(messageId);
}

export function deliverMessage(
  db:DatabaseSync,messageId:string,hythes:ReadonlyMap<string,Hythe>,
):Promise<MessageRecord> {
  let pending=pendingDeliveries.get(db);
  if(!pending){pending=new Map();pendingDeliveries.set(db,pending);}
  const prior=pending.get(messageId);if(prior)return prior;
  // Register before invoking the adapter: a fast correlated completion must
  // wait until acceptance/hostRef has been durably settled by this same send.
  const send=Promise.resolve().then(()=>deliverOnce(db,messageId,hythes));
  pending.set(messageId,send);
  void send.then(()=>pending!.delete(messageId),()=>pending!.delete(messageId));
  return send;
}

async function deliverOnce(
  db: DatabaseSync, messageId: string, hythes: ReadonlyMap<string, Hythe>,
): Promise<MessageRecord> {
  const route = withTransaction(db, "message_route", () => {
    const message = getMessage(db, messageId);
    if (message.state !== "queued") return null;
    const session = db.prepare(`SELECT hythe_id, locator_ref, state FROM sessions
      WHERE session_id = ?`).get(message.targetSessionId) as
      | { hythe_id: string; locator_ref: string; state: string } | undefined;
    if (!session) throw new SideraError("not_found", "Pinned session disappeared");
    if (session.state !== "active" && !isExecutorRuntimeSession(db,message.toNodeId,message.targetSessionId)) {
      db.prepare("UPDATE messages SET state = 'failed' WHERE message_id = ?")
        .run(messageId);
      if (message.reservationId) settleReservation(db, message.reservationId, "released");
      return null;
    }
    const actionId = ensureMessageAction(db, messageId);
    const attemptId = new SemanticStore(db, recordWorld(db, "messages", messageId)).attempt(actionId, message.targetSessionId, messageId);
    db.prepare("UPDATE messages SET state = 'sending' WHERE message_id = ?")
      .run(messageId);
    return { message, session, actionId, attemptId };
  });
  if (!route) return getMessage(db, messageId);

  const hythe = hythes.get(route.session.hythe_id);
  let capabilityObserved=!hythe;
  let result: InvokeResult;
  if (!hythe) {
    result = { status: "rejected", reason: "Target Hythe is unavailable" };
  } else {
    try {
      const run = db.prepare("SELECT run_id, task_id FROM task_runs WHERE message_id = ?")
        .get(route.message.messageId) as { run_id: string; task_id: string } | undefined;
      const supervised=route.message.kind==="result" && route.message.taskId?supervisionForTask(db,route.message.taskId):null;
      const review=supervised?supervisionView(db,supervised.supervisionId):null;
      const payload = {
        messageId: route.message.messageId,
        taskId: run?.task_id ?? route.message.taskId,
        runId: run?.run_id,
        logicalActionId: route.actionId,
        attemptId: route.attemptId,
        fromNodeId: route.message.fromNodeId,
        toNodeId: route.message.toNodeId,
        targetSessionId: route.message.targetSessionId,
        kind: route.message.kind,
        body: review ? `SIDERA_SUPERVISION_REVIEW_V1\n${JSON.stringify(review)}\nWorker result: ${route.message.body}\nYou are the accountable supervising Node. Compare the actual result with acceptanceCriteria and call supervision_decide exactly once for supervisionId ${review.supervisionId}, roundIndex ${review.awaitingDecisionRound}, with your own decision and reason. If REWORK/CONTINUE/RECONCILE, provide a self-contained next-round instruction and optional nextNodeId to choose a different worker/reviewer; Core dispatches it via the existing Task path. Do not dispatch a duplicate next round, poll, or ask Human to continue. Only ACCEPT/ESCALATE may present to the bound Human Chat. End this turn after your decision.` : route.message.body,
        wakeContext: wakeContext(db, route.message.toNodeId),
      };
      const profile=hythe.effectProfile?.("message.receive");
      if(!profile){capabilityObserved=true;throw new SideraError("unavailable","Hythe has no verified final-send boundary/profile");}
      const reservation=route.message.reservationId ? db.prepare("SELECT * FROM grant_uses WHERE reservation_id=?").get(route.message.reservationId) : null;
      const actorSession=reservation?.session_id ?? db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(route.message.fromNodeId)?.session_id;
      if(!actorSession)throw new SideraError("denied","Effect actor Session is unavailable");
      const capability=String(reservation?.capability ?? (route.message.fromNodeId===route.message.toNodeId?"self.task.resume":"message.send"));
      const request={actionId:route.actionId,attemptId:route.attemptId,actorSessionId:String(actorSession),capability,
        resource:String(reservation?.resource??`node/${route.message.toNodeId}`),requestId:`effect:${messageId}`,
        reservationId:route.message.reservationId,runId:run?.run_id,taskId:route.message.taskId??undefined,payload,profile,targetExecutes:true};
      const permit=prepareEffect(db,request);
      const boundary=effectBoundary(db,permit,request,()=>{
        if(route.message.kind==="context-handoff")assertContextHandoffDisclosure(db,messageId);
        if(route.message.kind==="cooperation")assertCooperationBasis(db,messageId);
      });
      capabilityObserved=true;
      result = await hythe.invoke(route.session.locator_ref,"message.receive",payload,route.message.requestId,boundary);
    } catch (error) {
      result = { status: "uncertain", reason: String(error) };
    }
  }
  const knowledge=effectKnowledge(db,route.attemptId);
  if(["allocated","prepared","not_prepared","confirmed_no_effect"].includes(knowledge)) {
    abandonPreparedEffect(db,route.attemptId,"No controlled crossing; local callback fenced");
    result={status:"rejected",reason:result.status==="accepted"?"Adapter returned acceptance without crossing the Effect gate":result.reason};
  } else {
    // A negative/empty response after the boundary cannot exclude delayed effects.
    if(result.status!=="accepted")result={status:"uncertain",reason:result.reason};
    observeEffect(db,route.attemptId,result.status==="accepted"?"accepted":"uncertain",result.status==="accepted"?result.hostRef:result.reason);
  }
  return withTransaction(db, "message_result", () => {
    // The controlled send proves this exact transport operation was callable.
    // It establishes neither Agent completion nor any permission to invoke it.
    // A local Authority denial before any adapter call is not a C observation.
    if(capabilityObserved)recordCapabilityCheck(db,{nodeRef:route.message.toNodeId,sessionRef:route.message.targetSessionId,
      operation:"message.receive",available:result.status==="accepted",sourceRef:`message-delivery:${messageId}`});
    const state = result.status === "accepted" ? "delivered" :
      result.status === "rejected" ? "failed" : "uncertain";
    db.prepare("UPDATE messages SET state = ?, host_ref = ? WHERE message_id = ?")
      .run(state, result.status === "accepted" ? result.hostRef : null, messageId);
    if (route.message.reservationId && result.status !== "uncertain") {
      settleReservation(db, route.message.reservationId,
        result.status === "accepted" ? "consumed" : "released");
    }
    if(result.status!=="accepted")db.prepare("INSERT INTO events VALUES (?,?,'message.delivery_blocked',?,?)").run(randomUUID(),route.message.fromNodeId,
      JSON.stringify({messageId,taskId:route.message.taskId,attemptId:route.attemptId,state,reason:result.reason,automaticReplay:false}),new Date().toISOString());
    return getMessage(db, messageId);
  });
}

export function ackMessage(db: DatabaseSync, messageId: string, sessionId: string): MessageRecord {
  return withTransaction(db, "message_ack", () => {
    const message = getMessage(db, messageId);
    if (message.targetSessionId !== sessionId) {
      throw new SideraError("denied", "ACK came from another session");
    }
    if (message.state === "observed") return message;
    if (message.state !== "delivered") {
      throw new SideraError("conflict", "Message is not confirmed delivered");
    }
    db.prepare("UPDATE messages SET state = 'observed' WHERE message_id = ?")
      .run(messageId);
    return getMessage(db, messageId);
  });
}

export function recoverInterruptedDelivery(db: DatabaseSync): number {
  return Number(db.prepare("UPDATE messages SET state = 'uncertain' WHERE state = 'sending'")
    .run().changes);
}

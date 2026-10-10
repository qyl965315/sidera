import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { recordWorld, requireWorld } from "./worlds.ts";

/**
 * Durable multi-round Chat -> Agent supervision.
 *
 * The product defect this replaces: every Agent completion was forwarded to the
 * Human immediately, so the Human was the reviewer, the scheduler and the loop
 * driver. Here the supervising Chat Node owns a real decision, and only ACCEPT or
 * ESCALATE may reach the Human.
 *
 * Core stores state and enforces rules. It does not choose the decision: the
 * decision is attributable to a Node, exactly like any other judgment (C19).
 */
export const SUPERVISION_DECISIONS = ["CONTINUE","REWORK","ACCEPT","WAIT","RECONCILE","ESCALATE","STOP"] as const;
export type SupervisionDecision = typeof SUPERVISION_DECISIONS[number];
/** Decisions that advance the work rather than ending the round. */
const ADVANCING: SupervisionDecision[] = ["CONTINUE","REWORK","RECONCILE"];

export function migrateSupervision(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisions (
      supervision_id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id),
      responsibility_id TEXT REFERENCES responsibilities(responsibility_id),
      chief_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      goal TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      max_rounds INTEGER NOT NULL CHECK (max_rounds BETWEEN 1 AND 50),
      rounds_completed INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('running','awaiting_decision','waiting','reconciling','completed','escalated','stopped','budget_exhausted')),
      next_action TEXT,
      next_instruction TEXT,
      waiting_for TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supervision_tasks (
      task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
      supervision_id TEXT NOT NULL REFERENCES supervisions(supervision_id),
      agent_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supervision_rounds (
      supervision_id TEXT NOT NULL REFERENCES supervisions(supervision_id),
      round_index INTEGER NOT NULL,
      task_id TEXT REFERENCES tasks(task_id),
      agent_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      result_message_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('awaiting_decision','decided')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (supervision_id, round_index)
    );
    CREATE TABLE IF NOT EXISTS supervision_decisions (
      supervision_id TEXT NOT NULL,
      round_index INTEGER NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      instruction TEXT,
      decided_by_node_id TEXT,
      decided_by_human_id TEXT,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (supervision_id, round_index),
      FOREIGN KEY (supervision_id, round_index) REFERENCES supervision_rounds(supervision_id, round_index)
    );
    CREATE TRIGGER IF NOT EXISTS supervision_decision_immutable BEFORE UPDATE ON supervision_decisions
      BEGIN SELECT RAISE(ABORT,'A recorded supervision decision cannot be rewritten'); END;
    CREATE TRIGGER IF NOT EXISTS supervision_decision_retained BEFORE DELETE ON supervision_decisions
      BEGIN SELECT RAISE(ABORT,'Supervision decisions are retained'); END;
  `);
}
export function openSupervision(db: DatabaseSync, input: {
  worldId: string; chiefNodeId: string; responsibilityId?: string | null;
  goal: string; acceptanceCriteria: string; maxRounds?: number;
}): string {
  if (!input.goal.trim()) throw new SideraError("conflict", "A supervision needs a stated goal");
  if (!input.acceptanceCriteria.trim())
    throw new SideraError("conflict", "A supervision needs explicit acceptance criteria, otherwise ACCEPT is unfalsifiable");
  if(!Number.isInteger(input.maxRounds??3) || (input.maxRounds??3)<1 || (input.maxRounds??3)>50)
    throw new SideraError("conflict","Round budget must be an integer from 1 to 50");
  requireWorld(db, input.worldId, "nodes", input.chiefNodeId);
  if (input.responsibilityId) requireWorld(db, input.worldId, "responsibilities", input.responsibilityId);
  const id = randomUUID(), at = new Date().toISOString();
  db.prepare(`INSERT INTO supervisions (supervision_id,world_id,responsibility_id,chief_node_id,goal,
      acceptance_criteria,max_rounds,rounds_completed,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,'running',?,?)`).run(id, input.worldId, input.responsibilityId ?? null,
      input.chiefNodeId, input.goal.trim(), input.acceptanceCriteria.trim(), input.maxRounds ?? 3, at, at);
  return id;
}
/** Records that a round finished and is now waiting for its supervising decision. */
export function recordRound(db: DatabaseSync, input: {
  supervisionId: string; roundIndex: number; agentNodeId: string;
  taskId?: string | null; resultMessageId?: string | null;
}): void {
  withTransaction(db, "supervision_round", () => {
    const prior = db.prepare("SELECT state FROM supervision_rounds WHERE supervision_id=? AND round_index=?")
      .get(input.supervisionId, input.roundIndex) as { state: string } | undefined;
    if (prior) return; // Duplicate callback must not create a second round.
    const s = db.prepare("SELECT * FROM supervisions WHERE supervision_id=?").get(input.supervisionId) as { world_id: string } | undefined;
    if (!s) throw new SideraError("not_found", "Supervision was not found");
    requireWorld(db, s.world_id, "nodes", input.agentNodeId);
    if (input.taskId) requireWorld(db, s.world_id, "tasks", input.taskId);
    db.prepare("INSERT INTO supervision_rounds VALUES (?,?,?,?,?, 'awaiting_decision', ?)")
      .run(input.supervisionId, input.roundIndex, input.taskId ?? null, input.agentNodeId,
        input.resultMessageId ?? null, new Date().toISOString());
    db.prepare("UPDATE supervisions SET state='awaiting_decision', updated_at=? WHERE supervision_id=?")
      .run(new Date().toISOString(), input.supervisionId);
  });
}
export interface SupervisionView {
  supervisionId: string; state: string; goal: string; acceptanceCriteria: string;
  chiefNodeId: string; roundsCompleted: number; maxRounds: number;
  awaitingDecisionRound: number | null; lastDecision: Record<string, unknown> | null;
  nextAction: string | null; nextInstruction: string | null; waitingFor: string | null; nextNodeId: string | null;
}
export function supervisionView(db: DatabaseSync, supervisionId: string): SupervisionView {
  const s = db.prepare("SELECT * FROM supervisions WHERE supervision_id=?").get(supervisionId) as Record<string, unknown> | undefined;
  if (!s) throw new SideraError("not_found", "Supervision was not found");
  const awaiting = db.prepare(`SELECT round_index FROM supervision_rounds WHERE supervision_id=? AND state='awaiting_decision'
    ORDER BY round_index DESC LIMIT 1`).get(supervisionId) as { round_index: number } | undefined;
  const last = db.prepare(`SELECT * FROM supervision_decisions WHERE supervision_id=?
    ORDER BY round_index DESC LIMIT 1`).get(supervisionId) as Record<string, unknown> | undefined;
  const selection=db.prepare("SELECT payload FROM events WHERE kind='supervision.decision_input' AND json_extract(payload,'$.supervisionId')=? ORDER BY rowid DESC LIMIT 1").get(supervisionId);
  const selected=selection?JSON.parse(String(selection.payload)).nextNodeId:null;
  return { nextNodeId:selected??null,supervisionId, state: String(s.state), goal: String(s.goal),
    acceptanceCriteria: String(s.acceptance_criteria), chiefNodeId: String(s.chief_node_id),
    roundsCompleted: Number(s.rounds_completed), maxRounds: Number(s.max_rounds),
    awaitingDecisionRound: awaiting ? Number(awaiting.round_index) : null,
    lastDecision: last ?? null, nextAction: s.next_action == null ? null : String(s.next_action),
    nextInstruction: s.next_instruction == null ? null : String(s.next_instruction),
    waitingFor: s.waiting_for == null ? null : String(s.waiting_for) };
}
export function decideSupervision(db: DatabaseSync, input: {
  supervisionId: string; roundIndex: number; decision: string; reason: string;
  instruction?: string | null; actor: { kind: "node"; nodeId: string } | { kind: "human"; id: string };
}, onDecision?: (result:{decision:string;state:string;mustPresentToHuman:boolean;replay:boolean})=>void): { decision: string; state: string; mustPresentToHuman: boolean; replay: boolean } {
  if (!SUPERVISION_DECISIONS.includes(input.decision as SupervisionDecision))
    throw new SideraError("conflict", `Unknown supervision decision: ${input.decision}`);
  const decision = input.decision as SupervisionDecision;
  if (!input.reason?.trim())
    throw new SideraError("conflict", "A supervision decision needs a stated reason");
  const owner=db.prepare("SELECT chief_node_id,world_id FROM supervisions WHERE supervision_id=?").get(input.supervisionId);
  if(!owner)throw new SideraError("not_found","Supervision was not found");
  if(input.actor.kind==="node" ? owner.chief_node_id!==input.actor.nodeId :
    !db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(String(owner.world_id),input.actor.id))
    throw new SideraError("denied","Only the accountable Supervisor or authorized Human may decide");
  // Budget exhaustion must be recorded durably AND refused. Recording it inside
  // the same transaction that throws would roll the checkpoint back, so it is
  // handled before the decision transaction, and only when this round has not
  // already been decided (a replay must stay idempotent).
  const existing = db.prepare("SELECT decision,reason FROM supervision_decisions WHERE supervision_id=? AND round_index=?")
    .get(input.supervisionId, input.roundIndex) as { decision: string; reason: string } | undefined;
  if (!existing) {
    const budget = db.prepare("SELECT rounds_completed,max_rounds FROM supervisions WHERE supervision_id=?")
      .get(input.supervisionId) as { rounds_completed: number; max_rounds: number } | undefined;
    if (budget && ADVANCING.includes(decision) && Number(budget.rounds_completed) >= Number(budget.max_rounds)) {
      withTransaction(db, "supervision_budget", () => {
        db.prepare("UPDATE supervisions SET state='budget_exhausted', updated_at=? WHERE supervision_id=?")
          .run(new Date().toISOString(), input.supervisionId);
      });
      throw new SideraError("conflict",
        `Round budget exhausted (${budget.rounds_completed}/${budget.max_rounds}); durable checkpoint kept for resume`);
    }
  }
  return withTransaction(db, "supervision_decide", () => {
    const s = db.prepare("SELECT * FROM supervisions WHERE supervision_id=?").get(input.supervisionId) as Record<string, unknown> | undefined;
    if (!s) throw new SideraError("not_found", "Supervision was not found");
    // The decision is a judgment, so it belongs to an accountable subject.
    if (input.actor.kind === "node") {
      if (String(s.chief_node_id) !== input.actor.nodeId)
        throw new SideraError("denied", "Only the supervising Node for this Responsibility may decide");
    } else {
      const world = String(s.world_id);
      const member = db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(world, input.actor.id);
      if (!member) throw new SideraError("denied", "Human is not a member of this World");
    }
    const round = db.prepare("SELECT * FROM supervision_rounds WHERE supervision_id=? AND round_index=?")
      .get(input.supervisionId, input.roundIndex) as Record<string, unknown> | undefined;
    if (!round) throw new SideraError("not_found", "That round does not exist for this supervision");
    const prior = db.prepare("SELECT * FROM supervision_decisions WHERE supervision_id=? AND round_index=?")
      .get(input.supervisionId, input.roundIndex) as Record<string, unknown> | undefined;
    if (prior) {
      // Idempotent for an identical replay; a DIFFERENT decision for the same
      // round is a conflict, never a silent overwrite.
      if (String(prior.decision) !== decision || String(prior.reason) !== input.reason.trim() ||
        (prior.instruction ?? null)!==(input.instruction?.trim() ?? null) ||
        (prior.decided_by_node_id ?? null)!==(input.actor.kind==="node"?input.actor.nodeId:null) ||
        (prior.decided_by_human_id ?? null)!==(input.actor.kind==="human"?input.actor.id:null))
        throw new SideraError("conflict", "Round already has a different decision");
      return { decision, state: String(s.state), mustPresentToHuman: false, replay: true };
    }
    const roundsCompleted = Number(s.rounds_completed);
    const maxRounds = Number(s.max_rounds);
    const at = new Date().toISOString();
    db.prepare("INSERT INTO supervision_decisions VALUES (?,?,?,?,?,?,?,?)")
      .run(input.supervisionId, input.roundIndex, decision, input.reason.trim(),
        input.instruction?.trim() ?? null, input.actor.kind === "node" ? input.actor.nodeId : null,
        input.actor.kind === "human" ? input.actor.id : null, at);
    db.prepare("UPDATE supervision_rounds SET state='decided' WHERE supervision_id=? AND round_index=?")
      .run(input.supervisionId, input.roundIndex);
    let state = "running", nextAction: string | null = null, waitingFor: string | null = null;
    let mustPresentToHuman = false;
    if (decision === "ACCEPT") { state = "completed"; mustPresentToHuman = true; }
    else if (decision === "ESCALATE") { state = "escalated"; mustPresentToHuman = true; }
    else if (decision === "STOP") state = "stopped";
    else if (decision === "WAIT") { state = "waiting"; waitingFor = input.instruction?.trim() ?? "external condition"; }
    else if (decision === "RECONCILE") {state = "reconciling";nextAction=`round ${input.roundIndex + 1}`;}
    else { state = "running"; nextAction = `round ${input.roundIndex + 1}`; }
    db.prepare(`UPDATE supervisions SET state=?, rounds_completed=?, next_action=?, next_instruction=?,
        waiting_for=?, updated_at=? WHERE supervision_id=?`)
      .run(state, roundsCompleted + 1,
        nextAction, input.instruction?.trim() ?? null, waitingFor, at, input.supervisionId);
    const result={ decision, state, mustPresentToHuman, replay: false };
    onDecision?.(result); // Decision and its scheduling/presentation intent commit together.
    return result;
  });
}

/**
 * Binds a dispatched Task to the supervision that owns it. This must happen when
 * the work is dispatched: review() cannot discover the supervision from a round
 * that the review itself would create.
 */
export function linkTaskToSupervision(db: DatabaseSync, input: {
  supervisionId: string; taskId: string; agentNodeId: string;
}): void {
  withTransaction(db, "supervision_link", () => {
    const s = db.prepare("SELECT world_id,state,chief_node_id,responsibility_id,max_rounds FROM supervisions WHERE supervision_id=?").get(input.supervisionId) as
      { world_id: string; state: string;chief_node_id:string;responsibility_id:string|null;max_rounds:number } | undefined;
    if (!s) throw new SideraError("not_found", "Supervision was not found");
    if (!["running","reconciling"].includes(s.state))
      throw new SideraError("conflict", "Supervision is not accepting new rounds");
    requireWorld(db, s.world_id, "tasks", input.taskId);
    requireWorld(db, s.world_id, "nodes", input.agentNodeId);
    const prior=db.prepare("SELECT supervision_id,agent_node_id FROM supervision_tasks WHERE task_id=?").get(input.taskId);
    if(prior){if(prior.supervision_id!==input.supervisionId || prior.agent_node_id!==input.agentNodeId)throw new SideraError("conflict","Task supervision is immutable");return;}
    const task=db.prepare("SELECT origin_node_id,center_node_id FROM tasks WHERE task_id=?").get(input.taskId)!;
    if(task.origin_node_id!==s.chief_node_id || task.center_node_id!==input.agentNodeId)throw new SideraError("denied","Task participants disagree with supervision");
    if(s.responsibility_id && db.prepare("SELECT responsibility_id FROM task_bases WHERE task_id=?").get(input.taskId)?.responsibility_id!==s.responsibility_id)
      throw new SideraError("conflict","Task belongs to a different Responsibility");
    if(Number(db.prepare("SELECT count(*) n FROM supervision_tasks WHERE supervision_id=?").get(input.supervisionId)!.n)>=s.max_rounds)
      throw new SideraError("conflict","Supervision round budget exhausted");
    if(db.prepare(`SELECT 1 FROM supervision_tasks st LEFT JOIN supervision_rounds r ON r.task_id=st.task_id
      WHERE st.supervision_id=? AND (r.state IS NULL OR r.state!='decided')`).get(input.supervisionId))
      throw new SideraError("conflict","A prior round is still executing or awaiting its decision");
    db.prepare("INSERT INTO supervision_tasks VALUES (?,?,?,?)")
      .run(input.taskId, input.supervisionId, input.agentNodeId, new Date().toISOString());
  });
}
/** Which supervision owns this Task, if any. Pure read. */
export function supervisionForTask(db: DatabaseSync, taskId: string): { supervisionId: string; roundsCompleted: number } | null {
  const row = db.prepare(`SELECT t.supervision_id, s.rounds_completed FROM supervision_tasks t
    JOIN supervisions s USING(supervision_id) WHERE t.task_id=?`).get(taskId) as
    { supervision_id: string; rounds_completed: number } | undefined;
  return row ? { supervisionId: String(row.supervision_id), roundsCompleted: Number(row.rounds_completed) } : null;
}

import type { DatabaseSync } from "node:sqlite";
import { reserveCapability } from "./authority.ts";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import type { Hythe } from "../hythes/types.ts";

type CallbackRow = { run_id: string; message_id: string; request_id: string; body: string };

/** Store GPT's own MCP callback; a Host UI completion remains a separate event. */
export async function acceptGptResult(db: DatabaseSync,
  hythes: ReadonlyMap<string, Hythe>, caller: { nodeId: string; sessionId: string },
  input: { requestId: string; runId: string; messageId: string; body: string }) {
  if (!input.body.trim() || input.body.length > 500_000)
    throw new SideraError("conflict", "Result must be nonempty and at most 500000 characters");
  const owner = db.prepare(`SELECT r.message_id, m.target_session_id, m.to_node_id
    FROM task_runs r JOIN messages m ON m.message_id = r.message_id
    WHERE r.run_id = ?`).get(input.runId) as
    { message_id: string; target_session_id: string; to_node_id: string } | undefined;
  if (!owner || owner.message_id !== input.messageId ||
      owner.target_session_id !== caller.sessionId || owner.to_node_id !== caller.nodeId)
    throw new SideraError("denied", "Callback does not belong to this exact GPT Run");
  const session = db.prepare(`SELECT hythe_id, host_kind FROM sessions
    WHERE session_id = ? AND node_id = ? AND state = 'active'`)
    .get(caller.sessionId, caller.nodeId) as
    { hythe_id: string; host_kind: string } | undefined;
  if (!session || session.host_kind !== "chatgpt-web")
    throw new SideraError("unavailable", "No active ChatGPT UI Session is bound");
  const hythe = hythes.get(session.hythe_id);
  if (!hythe?.acceptResult) throw new SideraError("unavailable", "GPT result backend is unavailable");
  const outcome = withTransaction(db, "gpt_result_callback", () => {
    const run = db.prepare(`SELECT r.run_id, r.message_id, r.turn_open, r.state,
      m.target_session_id, m.to_node_id, m.kind, m.state AS message_state
      FROM task_runs r JOIN messages m ON m.message_id = r.message_id
      WHERE r.run_id = ?`).get(input.runId) as
      { run_id: string; message_id: string; turn_open: number; state: string;
        target_session_id: string; to_node_id: string; kind: string; message_state: string } | undefined;
    if (!run || run.message_id !== input.messageId ||
        run.target_session_id !== caller.sessionId || run.to_node_id !== caller.nodeId ||
        run.kind !== "task")
      throw new SideraError("denied", "Callback does not belong to this exact GPT Run");
    reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
      capability: "self.task.result", resource: `node/${caller.nodeId}/session/${caller.sessionId}`,
      requestId: input.requestId, taskId: undefined });
    const prior = db.prepare("SELECT * FROM gpt_result_callbacks WHERE run_id = ? OR request_id = ?")
      .get(input.runId, input.requestId) as CallbackRow | undefined;
    if (prior) {
      if (prior.run_id !== input.runId || prior.message_id !== input.messageId ||
          prior.request_id !== input.requestId || prior.body !== input.body)
        throw new SideraError("conflict", "GPT callback ID or body conflicts with a stored result");
      return { stored: true, duplicate: true };
    }
    if (!run.turn_open || run.state !== "running" ||
        !["sending", "delivered", "observed"].includes(run.message_state))
      throw new SideraError("conflict", "GPT Run is not accepting a result");
    db.prepare("INSERT INTO gpt_result_callbacks VALUES (?, ?, ?, ?, ?)")
      .run(input.runId, input.messageId, input.requestId, input.body, new Date().toISOString());
    return { stored: true, duplicate: false };
  });
  if (!outcome.duplicate) {
    try { await hythe.acceptResult(input.runId, input.messageId, input.body); }
    catch { throw new SideraError("uncertain", "Result was stored but UI turn correlation is unconfirmed"); }
  }
  return { ...outcome, runId: input.runId, messageId: input.messageId,
    agentCompleted: false };
}

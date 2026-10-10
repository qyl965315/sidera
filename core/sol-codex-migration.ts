import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { IdentityStore } from "./identity.ts";
import { SideraError } from "./types.ts";

export interface SolCodexMigration {
  nodeId: string;
  fromSessionId: string;
  toSessionId: string;
  locatorRef: string;
  hytheId: string;
  modelId: string;
}

/** Explicit Host handoff. Historical Messages retain their original Session IDs. */
export function promoteSolToCodex(db: DatabaseSync, input: SolCodexMigration): void {
  const active = db.prepare("SELECT session_id FROM sessions WHERE node_id = ? AND state = 'active'")
    .get(input.nodeId) as { session_id: string } | undefined;
  if (active?.session_id === input.toSessionId) {
    const bound = new IdentityStore(db).currentModel(input.nodeId);
    if (bound?.provider !== "openai" || bound.modelId !== input.modelId)
      throw new SideraError("conflict", "Sol Session and ModelBinding disagree");
    return;
  }
  if (active?.session_id !== input.fromSessionId)
    throw new SideraError("conflict", "Sol active Session changed before handoff");
  const busyTasks = db.prepare(`SELECT count(*) AS n FROM tasks
    WHERE (origin_node_id = ? OR center_node_id = ?) AND state IN ('queued','running')`)
    .get(input.nodeId, input.nodeId) as { n: number };
  const busyRuns = db.prepare(`SELECT count(*) AS n FROM task_runs
    WHERE session_id = ? AND state IN ('running','waiting_dependency')`)
    .get(input.fromSessionId) as { n: number };
  const pendingMessages = db.prepare(`SELECT count(*) AS n FROM messages
    WHERE (target_session_id = ? OR from_node_id = ?)
    AND state IN ('queued','sending','delivered')`)
    .get(input.fromSessionId, input.nodeId) as { n: number };
  if (busyTasks.n || busyRuns.n || pendingMessages.n)
    throw new SideraError("conflict", "Sol has live work; reconcile before Host handoff");

  withTransaction(db, "sol_codex_migrate", () => {
    const retired = db.prepare(`UPDATE sessions SET state = 'retired'
      WHERE session_id = ? AND node_id = ? AND state = 'active'`)
      .run(input.fromSessionId, input.nodeId);
    if (retired.changes !== 1)
      throw new SideraError("conflict", "Sol active Session changed during handoff");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 'codex-app-server', ?, 'active', ?)")
      .run(input.toSessionId, input.nodeId, input.hytheId,
        input.locatorRef, new Date().toISOString());
    const identities = new IdentityStore(db);
    const current = identities.currentModel(input.nodeId);
    const choice = { provider: "openai", modelId: input.modelId,
      reasoningConfig: { effort: "medium" } };
    if (current) identities.migrateModel({ nodeId: input.nodeId, sessionId: input.toSessionId },
      randomUUID(), current.bindingId, choice);
    else identities.bindModel({ nodeId: input.nodeId, sessionId: input.toSessionId },
      randomUUID(), choice);
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(randomUUID(),
      input.nodeId, "session.handoff", JSON.stringify({
        from: input.fromSessionId, to: input.toSessionId,
        locatorRef: input.locatorRef, hytheId: input.hytheId,
        reason: "human-selected-codex-sol-host",
      }), new Date().toISOString());
  });
}

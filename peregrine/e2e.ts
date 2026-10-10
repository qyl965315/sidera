import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getMessage } from "../core/bus.ts";
import { SideraError } from "../core/types.ts";
import type { LocalPeregrineManager } from "./local.ts";

/** One fixed action for the first real E2E; no arbitrary shell or path input. */
export async function writeE2EMarker(db: DatabaseSync, manager: LocalPeregrineManager,
  caller: { nodeId: string; sessionId: string }, messageId: string) {
  const message = getMessage(db, messageId);
  if (message.toNodeId !== caller.nodeId || message.targetSessionId !== caller.sessionId ||
      message.kind !== "task" || !message.taskId || !message.body.includes("SIDERA_E2E_OK")) {
    throw new SideraError("denied", "Marker action requires the caller's exact E2E task message");
  }
  if (!["delivered", "observed"].includes(message.state)) {
    throw new SideraError("conflict", "Delivery is unconfirmed; do not run or retry the task");
  }
  const prior = db.prepare(`SELECT kind, payload FROM events
    WHERE actor_node_id = ? AND kind IN ('peregrine.e2e.started', 'peregrine.e2e.completed')
      AND json_extract(payload, '$.messageId') = ? ORDER BY rowid DESC LIMIT 1`)
    .get(caller.nodeId, messageId) as { kind: string; payload: string } | undefined;
  if (prior?.kind === "peregrine.e2e.completed") return JSON.parse(prior.payload) as Record<string, unknown>;
  if (prior) throw new SideraError("uncertain", "Prior marker action needs reconciliation; it was not repeated");
  const task = db.prepare("SELECT state FROM tasks WHERE task_id = ?").get(message.taskId);
  if (!task || !["queued", "running"].includes(String(task.state))) {
    throw new SideraError("conflict", "Task is no longer executable");
  }
  const record = (kind: string, payload: unknown) => db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), caller.nodeId, kind, JSON.stringify(payload), new Date().toISOString());
  // A durable start marker prevents an unconfirmed process from being repeated.
  record("peregrine.e2e.started", { messageId, taskId: message.taskId, sessionId: caller.sessionId });
  try {
    // Both manager operations perform their existing Authority check.
    const domain = manager.create(caller.nodeId, caller.sessionId, `e2e:create:${messageId}`);
    const path = join(domain.workspaceRef, "SIDERA_E2E_OK.txt");
    const run = await manager.run({
      peregrineId: domain.peregrineId, ownerNodeId: caller.nodeId, sessionId: caller.sessionId,
      requestId: `e2e:run:${messageId}`, executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('SIDERA_E2E_OK.txt','SIDERA_E2E_OK',{flag:'wx'});process.stdout.write(require('node:path').resolve('SIDERA_E2E_OK.txt'))"],
      timeoutMs: 10_000,
    });
    if (run.exitCode !== 0 || run.timedOut || readFileSync(path, "utf8") !== "SIDERA_E2E_OK") {
      throw new SideraError("uncertain", "Marker process or file verification did not complete");
    }
    const result = { messageId, taskId: message.taskId, sessionId: caller.sessionId,
      peregrineId: domain.peregrineId, path, content: "SIDERA_E2E_OK", exitCode: run.exitCode };
    record("peregrine.e2e.completed", result);
    return result;
  } catch {
    // Keep the durable start marker, even if the host result is unknown.
    throw new SideraError("uncertain", "Peregrine action needs reconciliation; do not retry");
  }
}

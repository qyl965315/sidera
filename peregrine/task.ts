import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getMessage } from "../core/bus.ts";
import { SideraError } from "../core/types.ts";
import type { LocalPeregrineManager } from "./local.ts";
import { writeOwnedText } from "./text.ts";

/**
 * The built-in, publicly distributable local executor action set.
 *
 * One task message carries one bounded JSON instruction. There is no shell,
 * no arbitrary path and no model-chosen executable: `write_text` writes one
 * simple-named text artifact, and `run_node` writes one bounded script and
 * runs it with the bundled Node executable inside the caller's contained
 * Peregrine workspace. Both produce hash-bearing evidence.
 *
 * Durable `local.executor.started` / `local.executor.completed` events make the
 * action idempotent by exact message id. A started-without-completed action is
 * UNCERTAIN and is never automatically repeated.
 */

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_TEXT_BYTES = 200_000;
const MAX_SCRIPT_BYTES = 200_000;
const MAX_TIMEOUT_MS = 30_000;

export interface LocalTaskInstruction { [key: string]: unknown }

function simpleName(value: unknown, label: string): string {
  if (typeof value !== "string" || !FILE_NAME.test(value) || value === "." || value === "..")
    throw new SideraError("conflict", `Local task ${label} must be a simple file name`);
  return value;
}
function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes)
    throw new SideraError("conflict", `Local task ${label} must be 1..${maxBytes} bytes`);
  return value;
}
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function parseLocalTaskInstruction(body: string): LocalTaskInstruction {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw new SideraError("conflict", "Local task body must be a bounded JSON instruction"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new SideraError("conflict", "Local task body must be a bounded JSON object");
  const input = parsed as LocalTaskInstruction;
  if (input.protocolVersion !== 1)
    throw new SideraError("conflict", "Local task protocolVersion must be 1");
  if (input.op !== "write_text" && input.op !== "run_node")
    throw new SideraError("conflict", "Local task op must be write_text or run_node");
  return input;
}

function workspaceFile(manager: LocalPeregrineManager, nodeId: string, peregrineId: string, fileName: string): string {
  const domain = manager.get(peregrineId);
  if (domain.ownerNodeId !== nodeId || domain.state !== "ready")
    throw new SideraError("denied", "Local task workspace is not owned by the executing Node");
  return join(domain.workspaceRef, fileName);
}

/** Execute one exact task message through the built-in local executor. */
export async function runLocalTask(db: DatabaseSync, manager: LocalPeregrineManager,
  caller: { nodeId: string; sessionId: string }, input: { messageId: string }): Promise<Record<string, unknown>> {
  const message = getMessage(db, input.messageId);
  if (message.toNodeId !== caller.nodeId || message.targetSessionId !== caller.sessionId ||
      message.kind !== "task" || !message.taskId)
    throw new SideraError("denied", "Local executor requires the caller's exact task message");
  if (!["delivered", "observed", "sending"].includes(message.state))
    throw new SideraError("conflict", "Task delivery is not confirmed; do not execute or repeat");
  const instruction = parseLocalTaskInstruction(message.body);
  const prior = db.prepare(`SELECT kind, payload FROM events
    WHERE actor_node_id = ? AND kind IN ('local.executor.started', 'local.executor.completed')
      AND json_extract(payload, '$.messageId') = ? ORDER BY rowid DESC LIMIT 1`)
    .get(caller.nodeId, input.messageId) as { kind: string; payload: string } | undefined;
  if (prior?.kind === "local.executor.completed")
    return (JSON.parse(String(prior.payload)) as { evidence: Record<string, unknown> }).evidence;
  if (prior) throw new SideraError("uncertain", "Prior local task needs reconciliation; it was not repeated");
  const task = db.prepare("SELECT state FROM tasks WHERE task_id = ?").get(message.taskId) as { state: string } | undefined;
  if (!task || !["queued", "running"].includes(task.state))
    throw new SideraError("conflict", "Task is no longer executable");
  const record = (kind: string, payload: unknown) => db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), caller.nodeId, kind, JSON.stringify(payload), new Date().toISOString());
  // A durable start marker prevents an unconfirmed action from being repeated.
  record("local.executor.started", { messageId: input.messageId, taskId: message.taskId,
    sessionId: caller.sessionId, op: instruction.op });
  const startedAt = Date.now();
  // The durable start marker is written synchronously at the Effect boundary.
  // Yield one event-loop turn so the Bus delivery commit can never race an
  // extremely fast local completion. The marker stays authoritative either way.
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    let evidence: Record<string, unknown>;
    if (instruction.op === "write_text") {
      const fileName = simpleName(instruction.fileName, "fileName");
      const text = boundedText(instruction.content, "content", MAX_TEXT_BYTES);
      const written = writeOwnedText(db, manager, caller, { requestId: `local:${input.messageId}:write`,
        fileName, content: text, mode: "create" });
      const actual = readFileSync(written.path);
      if (actual.toString("utf8") !== text)
        throw new SideraError("uncertain", "Local write verification failed");
      evidence = { status: "completed", op: "write_text", fileName, path: written.path,
        peregrineId: written.peregrineId, bytes: actual.length, sha256: sha256(actual) };
    } else {
      const script = instruction.script as Record<string, unknown> | undefined;
      const artifact = instruction.artifact as Record<string, unknown> | undefined;
      if (!script || !artifact) throw new SideraError("conflict", "run_node requires script and artifact");
      const scriptName = simpleName(script.fileName, "script.fileName");
      const scriptText = boundedText(script.content, "script.content", MAX_SCRIPT_BYTES);
      const artifactName = simpleName(artifact.fileName, "artifact.fileName");
      const written = writeOwnedText(db, manager, caller, { requestId: `local:${input.messageId}:script`,
        fileName: scriptName, content: scriptText, mode: "create" });
      const requested = Number(instruction.timeoutMs ?? 15_000);
      const timeoutMs = Math.min(Math.max(Number.isFinite(requested) ? requested : 15_000, 1_000), MAX_TIMEOUT_MS);
      const run = await manager.run({ peregrineId: written.peregrineId, ownerNodeId: caller.nodeId,
        sessionId: caller.sessionId, requestId: `local:${input.messageId}:run`,
        executable: process.execPath, args: [scriptName], timeoutMs });
      const artifactPath = workspaceFile(manager, caller.nodeId, written.peregrineId, artifactName);
      let artifactBytes: Buffer | undefined, artifactSha256: string | null = null;
      let artifactReadError: string | null = null;
      try { artifactBytes = readFileSync(artifactPath); artifactSha256 = sha256(artifactBytes); }
      catch { artifactReadError = "artifact-missing-or-unreadable"; }
      const status = run.exitCode === 0 && !run.timedOut && existsSync(artifactPath) ? "completed" : "failed";
      evidence = { status, op: "run_node", scriptFileName: scriptName, scriptSha256: sha256(scriptText),
        exitCode: run.exitCode, timedOut: run.timedOut, stdoutSha256: sha256(run.stdout),
        stdoutBytes: Buffer.byteLength(run.stdout), stderrTail: run.stderr.slice(-1000),
        artifact: { fileName: artifactName, path: artifactPath, exists: Boolean(artifactBytes),
          bytes: artifactBytes?.length ?? 0, sha256: artifactSha256, readError: artifactReadError },
        durationMs: Date.now() - startedAt };
    }
    const completed = { ...evidence, messageId: input.messageId, taskId: message.taskId, sessionId: caller.sessionId };
    record("local.executor.completed", { messageId: input.messageId, taskId: message.taskId,
      sessionId: caller.sessionId, evidence: completed });
    return completed;
  } catch (error) {
    if (error instanceof SideraError && error.code === "uncertain") throw error;
    throw new SideraError("uncertain",
      `Local task needs reconciliation; do not retry (${error instanceof Error ? error.message : "unknown"})`);
  }
}

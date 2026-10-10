import { randomUUID } from "node:crypto";
import { localEffect } from "../core/local-effect.ts";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "../core/authority.ts";
import { SideraError } from "../core/types.ts";
import type { LocalPeregrineManager } from "./local.ts";
import { assertOutsideSovereignty } from "../core/sovereignty-store.ts";

/** Read only a simple-name text file from the caller's own ready domain. */
export function readOwnedText(db: DatabaseSync, manager: LocalPeregrineManager,
  caller: { nodeId: string; sessionId: string }, fileName: string): {
    path: string; peregrineId: string; content: string; bytes: number;
  } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(fileName) ||
      fileName === "." || fileName === "..")
    throw new SideraError("conflict", "Workspace file must have a simple name");
  const row = db.prepare(`SELECT peregrine_id FROM peregrines WHERE owner_node_id = ?
    AND state = 'ready' ORDER BY rowid LIMIT 1`).get(caller.nodeId) as
    { peregrine_id: string } | undefined;
  if (!row) throw new SideraError("not_found", "Owned workspace is unavailable");
  const domain = manager.get(row.peregrine_id);
  if (domain.ownerNodeId !== caller.nodeId || domain.state !== "ready")
    throw new SideraError("denied", "Workspace is outside the caller's Peregrine");
  const permit = reserveCapability(db, { subjectNodeId: caller.nodeId,
    sessionId: caller.sessionId, capability: "self.workspace.read",
    resource: `node/${caller.nodeId}/workspace/${fileName}`,
    requestId: `read:${randomUUID()}` });
  try {
    const path = join(domain.workspaceRef, fileName);
    if (!existsSync(path))
      throw new SideraError("not_found", "Owned workspace file does not exist");
    const workspace = realpathSync(domain.workspaceRef).toLowerCase();
    const actual = realpathSync(path).toLowerCase();
    assertOutsideSovereignty(db, path);
    if (!actual.startsWith(`${workspace}${sep}`) || !statSync(path).isFile())
      throw new SideraError("denied", "Workspace file escapes the owned domain");
    const size = statSync(path).size;
    if (size > 500_000) throw new SideraError("conflict", "Workspace text exceeds read limit");
    const content = readFileSync(path, "utf8");
    const bytes = Buffer.byteLength(content);
    if (bytes > 500_000) throw new SideraError("conflict", "Workspace text exceeds read limit");
    if (permit.reservationId) settleReservation(db, permit.reservationId, "consumed");
    return { path, peregrineId: domain.peregrineId, content, bytes };
  } catch (error) {
    if (permit.reservationId) settleReservation(db, permit.reservationId, "released");
    throw error;
  }
}

/** Write one text artifact in the caller's own Peregrine workspace. */
export function writeOwnedText(db: DatabaseSync, manager: LocalPeregrineManager,
  caller: { nodeId: string; sessionId: string }, input: {
    requestId: string; fileName: string; content: string;
    mode?: "create" | "replace"; expectedContent?: string;
  }): { path: string; peregrineId: string; bytes: number } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.fileName) ||
      input.fileName === "." || input.fileName === "..")
    throw new SideraError("conflict", "Workspace file must have a simple name");
  if (!input.content || Buffer.byteLength(input.content) > 500_000)
    throw new SideraError("conflict", "Workspace text must be 1 to 500000 bytes");
  const mode = input.mode ?? "create";
  if (mode !== "create" && mode !== "replace")
    throw new SideraError("conflict", "Unsupported workspace write mode");
  if (mode === "replace" && (!input.expectedContent ||
      Buffer.byteLength(input.expectedContent) > 500_000))
    throw new SideraError("conflict", "Replacement requires the exact previous content");
  reserveCapability(db, { subjectNodeId: caller.nodeId, sessionId: caller.sessionId,
    capability: "self.workspace.write", resource: `node/${caller.nodeId}/workspace/${input.fileName}`,
    requestId: input.requestId });
  const prior = db.prepare(`SELECT kind, payload FROM events WHERE actor_node_id = ?
    AND kind IN ('workspace.write.started', 'workspace.write.completed')
    AND json_extract(payload, '$.requestId') = ? ORDER BY rowid DESC LIMIT 1`)
    .get(caller.nodeId, input.requestId) as { kind: string; payload: string } | undefined;
  if (prior) {
    if (prior.kind !== "workspace.write.completed")
      throw new SideraError("uncertain", "Prior workspace write needs reconciliation");
    const result = JSON.parse(prior.payload) as { path: string; peregrineId: string;
      bytes: number; fileName: string };
    assertOutsideSovereignty(db, result.path);
    if (result.fileName !== input.fileName || readFileSync(result.path, "utf8") !== input.content)
      throw new SideraError("conflict", "Request ID was used for different workspace text");
    return { path: result.path, peregrineId: result.peregrineId, bytes: result.bytes };
  }
  let row = db.prepare(`SELECT peregrine_id FROM peregrines WHERE owner_node_id = ?
    AND state = 'ready' ORDER BY rowid LIMIT 1`).get(caller.nodeId) as
    { peregrine_id: string } | undefined;
  if (!row) row = { peregrine_id: manager.create(caller.nodeId, caller.sessionId,
    `workspace:create:${input.requestId}`).peregrineId };
  const domain = manager.get(row.peregrine_id);
  if (domain.ownerNodeId !== caller.nodeId || domain.state !== "ready")
    throw new SideraError("denied", "Workspace is outside the caller's Peregrine");
  const path = join(domain.workspaceRef, input.fileName);
  assertOutsideSovereignty(db, path);
  if (mode === "replace") {
    let current: string;
    try { current = readFileSync(path, "utf8"); }
    catch { throw new SideraError("conflict", "Workspace file to replace is missing"); }
    if (current !== input.expectedContent)
      throw new SideraError("conflict", "Workspace file changed since the draft");
  }
  const record = (kind: string, payload: unknown) => db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), caller.nodeId, kind, JSON.stringify(payload), new Date().toISOString());
  record("workspace.write.started", { requestId: input.requestId,
    sessionId: caller.sessionId, peregrineId: domain.peregrineId, fileName: input.fileName,
    mode });
  try {
    localEffect(db,{...caller,requestId:input.requestId,capability:"self.workspace.write",
      resource:`node/${caller.nodeId}/workspace/${input.fileName}`,targetRef:path,payload:{...input,path,peregrineId:domain.peregrineId}},()=>{
    if (mode === "create") writeFileSync(path, input.content, { encoding: "utf8", flag: "wx" });
    else {
      const temporary = join(domain.workspaceRef, `.${input.fileName}.${input.requestId}.tmp`);
      writeFileSync(temporary, input.content, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, path);
    }
    });
    if (readFileSync(path, "utf8") !== input.content)
      throw new Error("Workspace write verification failed");
    const result = { requestId: input.requestId, fileName: input.fileName,
      path, peregrineId: domain.peregrineId, bytes: Buffer.byteLength(input.content) };
    record("workspace.write.completed", result);
    return { path, peregrineId: domain.peregrineId, bytes: result.bytes };
  } catch {
    throw new SideraError("uncertain", "Workspace write needs reconciliation; do not retry");
  }
}

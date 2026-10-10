import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "./authority.ts";
import { SideraError } from "./types.ts";
import { assertOutsideSovereignty } from "./sovereignty-store.ts";

/** Explicit source/document surface; runtime profiles, credentials and ignored data are excluded. */
export function readProjectSource(db: DatabaseSync, project: string, caller: { nodeId: string; sessionId: string }, input: {
  requestId: string; path: string; startLine?: number; lineCount?: number;
}) {
  if (!/^(?:[A-Z][A-Z0-9_-]*\.md|(?:core|hythes|peregrine|qwen|scripts|tests)\/[a-z0-9-]+(?:\.test)?\.(?:ts|md)|scripts\/[a-z0-9-]+\.ps1)$/.test(input.path))
    throw new SideraError("denied", "Path is outside the integration source/document surface");
  const start = input.startLine ?? 1, count = input.lineCount ?? 160;
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 200)
    throw new SideraError("conflict", "Invalid bounded source range");
  const root = realpathSync(project);
  let path: string;
  try { path = realpathSync(resolve(root,input.path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new SideraError("not_found", "Integration source file does not exist; Node artifacts use their own workspace surface");
    throw error;
  }
  const local = relative(root,path);
  assertOutsideSovereignty(db, path);
  if (local.startsWith(`..${sep}`) || local === ".." || statSync(path).size > 256_000)
    throw new SideraError("denied", "Source path escaped or exceeded the bounded source surface");
  const permit = reserveCapability(db,{subjectNodeId:caller.nodeId,sessionId:caller.sessionId,
    requestId:input.requestId,capability:"project.source.read",resource:`project/sidera/source/${input.path}`});
  const lines = readFileSync(path,"utf8").split(/\r?\n/);
  const text = lines.slice(start-1,start-1+count).map((line,i)=>`${start+i}: ${line}`).join("\n");
  if (permit.reservationId) settleReservation(db,permit.reservationId,"consumed");
  return { path:input.path,startLine:start,totalLines:lines.length,text };
}

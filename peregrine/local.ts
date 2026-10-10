import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reserveCapability, settleReservation } from "../core/authority.ts";
import { SideraError } from "../core/types.ts";
import { localEffect } from "../core/local-effect.ts";

export interface PeregrineRecord {
  peregrineId: string;
  ownerNodeId: string;
  workspaceRef: string;
  homeRef: string;
  tempRef: string;
  state: "ready" | "stopped";
  backend: "local";
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function contained(root: string, target: string): boolean {
  const base = resolve(root).toLowerCase();
  const path = resolve(target).toLowerCase();
  return path.startsWith(`${base}${sep}`);
}

export class LocalPeregrineManager {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly running = new Map<string, ChildProcess>();

  constructor(db: DatabaseSync, root: string) {
    this.db = db;
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  get(peregrineId: string): PeregrineRecord {
    const row = this.db.prepare("SELECT * FROM peregrines WHERE peregrine_id = ?")
      .get(peregrineId) as Record<string, unknown> | undefined;
    if (!row) throw new SideraError("not_found", "Peregrine was not found");
    return {
      peregrineId: String(row.peregrine_id),
      ownerNodeId: String(row.owner_node_id),
      workspaceRef: String(row.workspace_ref),
      homeRef: String(row.home_ref),
      tempRef: String(row.temp_ref),
      state: String(row.state) as PeregrineRecord["state"],
      backend: "local",
    };
  }

  create(ownerNodeId: string, sessionId: string, requestId: string): PeregrineRecord {
    const permit = reserveCapability(this.db, {
      subjectNodeId: ownerNodeId, sessionId, capability: "self.peregrine.create",
      resource: `node/${ownerNodeId}/peregrine`, requestId,
    });
    const id = randomUUID();
    const base = join(this.root, id);
    const workspace = join(base, "workspace");
    const home = join(base, "home");
    const temp = join(base, "temp");
    localEffect(this.db,{nodeId:ownerNodeId,sessionId,requestId,capability:"self.peregrine.create",resource:`node/${ownerNodeId}/peregrine`,targetRef:base,payload:{base,workspace,home,temp}},()=>{
    for (const path of [workspace, home, temp, join(home, "AppData", "Roaming"),
      join(home, "AppData", "Local"), join(home, "codex")]) {
      mkdirSync(path, { recursive: true });
    }
    });
    try {
      this.db.prepare(`INSERT INTO peregrines
        (peregrine_id, owner_node_id, workspace_ref, home_ref, temp_ref, state, backend)
        VALUES (?, ?, ?, ?, ?, 'ready', 'local')`)
        .run(id, ownerNodeId, workspace, home, temp);
      if (permit.reservationId) settleReservation(this.db, permit.reservationId, "consumed");
      return this.get(id);
    } catch (error) {
      // The directory effect already happened. Preserve its durable Action and
      // path for reconciliation; cleanup would be another unadmitted Effect.
      throw new SideraError("uncertain", `Peregrine created but registry result is unconfirmed: ${String(error)}`);
    }
  }

  async run(input: {
    peregrineId: string;
    ownerNodeId: string;
    sessionId: string;
    requestId: string;
    executable: string;
    args: string[];
    timeoutMs?: number;
  }): Promise<RunResult> {
    const domain = this.get(input.peregrineId);
    if (domain.ownerNodeId !== input.ownerNodeId || domain.state !== "ready") {
      throw new SideraError("denied", "Peregrine is not ready for this node");
    }
    if (this.running.has(input.peregrineId)) {
      throw new SideraError("conflict", "Peregrine already has a running process");
    }
    const permit = reserveCapability(this.db, {
      subjectNodeId: input.ownerNodeId, sessionId: input.sessionId,
      capability: "self.peregrine.run",
      resource: `node/${input.ownerNodeId}/peregrine/${input.peregrineId}`,
      requestId: input.requestId,
    });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      HOME: domain.homeRef,
      USERPROFILE: domain.homeRef,
      APPDATA: join(domain.homeRef, "AppData", "Roaming"),
      LOCALAPPDATA: join(domain.homeRef, "AppData", "Local"),
      TEMP: domain.tempRef,
      TMP: domain.tempRef,
      TMPDIR: domain.tempRef,
      CODEX_HOME: join(domain.homeRef, "codex"),
      SIDERA_WORKSPACE: domain.workspaceRef,
    };
    let child: ChildProcess;
    try {
      child = localEffect(this.db,{nodeId:input.ownerNodeId,sessionId:input.sessionId,requestId:input.requestId,capability:"self.peregrine.run",
        resource:`node/${input.ownerNodeId}/peregrine/${input.peregrineId}`,targetRef:domain.workspaceRef,payload:{...input,workspace:domain.workspaceRef},autonomous:true},()=>spawn(input.executable, input.args, {
        cwd: domain.workspaceRef, env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch (error) {
      throw error;
    }
    this.running.set(input.peregrineId, child);
    if (permit.reservationId) settleReservation(this.db, permit.reservationId, "consumed");
    const cap = 64 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, cap); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, cap); });
    const timer = setTimeout(() => {
      timedOut = true;
      this.killTree(child);
    }, input.timeoutMs ?? 60_000);
    try {
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", code => resolveExit(code));
      });
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
      this.running.delete(input.peregrineId);
    }
  }

  stop(peregrineId: string, ownerNodeId: string, sessionId: string, requestId: string): void {
    const domain = this.get(peregrineId);
    if (domain.ownerNodeId !== ownerNodeId) throw new SideraError("denied", "Wrong owner");
    const permit = reserveCapability(this.db, {
      subjectNodeId: ownerNodeId, sessionId, capability: "self.peregrine.stop",
      resource: `node/${ownerNodeId}/peregrine/${peregrineId}`, requestId,
    });
    const child = this.running.get(peregrineId);
    if (child) localEffect(this.db,{nodeId:ownerNodeId,sessionId,requestId,capability:"self.peregrine.stop",
      resource:`node/${ownerNodeId}/peregrine/${peregrineId}`,targetRef:`process:${child.pid}`,payload:{peregrineId,pid:child.pid},autonomous:true},()=>this.killTree(child));
    this.db.prepare("UPDATE peregrines SET state = 'stopped' WHERE peregrine_id = ?")
      .run(peregrineId);
    if (permit.reservationId) settleReservation(this.db, permit.reservationId, "consumed");
  }

  destroy(peregrineId: string, ownerNodeId: string, sessionId: string, requestId: string): void {
    const domain = this.get(peregrineId);
    if (domain.ownerNodeId !== ownerNodeId || this.running.has(peregrineId)) {
      throw new SideraError("denied", "Peregrine owner or process state does not match");
    }
    const base = join(this.root, peregrineId);
    if (!contained(this.root, base) ||
        ![domain.workspaceRef, domain.homeRef, domain.tempRef].every(path => contained(base, path)) ||
        !contained(this.root, realpathSync(base))) {
      throw new SideraError("denied", "Peregrine path escaped its root");
    }
    const permit = reserveCapability(this.db, {
      subjectNodeId: ownerNodeId, sessionId, capability: "self.peregrine.destroy",
      resource: `node/${ownerNodeId}/peregrine/${peregrineId}`, requestId,
    });
    localEffect(this.db,{nodeId:ownerNodeId,sessionId,requestId,capability:"self.peregrine.destroy",resource:`node/${ownerNodeId}/peregrine/${peregrineId}`,targetRef:base,payload:{peregrineId,base}},()=>rmSync(base, { recursive: true }));
    this.db.prepare("DELETE FROM peregrines WHERE peregrine_id = ?").run(peregrineId);
    if (permit.reservationId) settleReservation(this.db, permit.reservationId, "consumed");
  }

  private killTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }
}

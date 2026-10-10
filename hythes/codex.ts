import { hostManifest, controlsFromManifest, operationEffect } from "./manifest.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";
import { SideraError } from "../core/types.ts";
import { renderWakeContext, type WakeContext } from "./wake-context.ts";
import { canonicalToolNames } from "./canonical-mcp.ts";
import { GATEWAY_TOOL_NAMES } from "./mcp-gateway.ts";

/** A managed Sidera MCP profile exposes the canonical vocabulary. Core still
 * authorizes each action; this does not expose other MCP servers or Host tools. */
export function canonicalCodexMcpOverrides(configText:string):string[] {
  if(/^\[mcp_servers\.sidera_peregrine\]\s*$/m.test(configText)){
    const names=canonicalToolNames().sort();
    return ["-c",'mcp_servers.sidera_peregrine.default_tools_approval_mode="approve"',
      "-c",`mcp_servers.sidera_peregrine.enabled_tools=${JSON.stringify(names)}`,
      ...names.flatMap(name=>["-c",`mcp_servers.sidera_peregrine.tools.${name}.approval_mode="approve"`])];
  }
  if(/^\[mcp_servers\.sidera\]\s*$/m.test(configText)){
    // The Gateway deliberately exposes a tiny stable northbound catalog. A
    // Codex Host using this profile must approve those transport tools rather
    // than the larger direct canonical catalog behind sidera_peregrine.
    const names=[...GATEWAY_TOOL_NAMES];
    return ["-c",'mcp_servers.sidera.default_tools_approval_mode="approve"',
      "-c",`mcp_servers.sidera.enabled_tools=${JSON.stringify(names)}`,
      ...names.flatMap(name=>["-c",`mcp_servers.sidera.tools.${name}.approval_mode="approve"`])];
  }
  return [];
}

interface RpcReply {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexHytheOptions {
  hytheId?: string;
  codexExecutable: string;
  workspace: string;
  home: string;
  temp: string;
  codexHome?: string;
  model: string;
  coreToken?: string;
  coreTokenEnvName?: string;
  corePort?: number;
}

/** Thin stdio bridge to Codex app-server in a separate CODEX_HOME. */
export class CodexHythe implements Hythe {
  effectProfile() {return providerAdmissionProfile(this.hostKind,"app-server stdin request initiation");}
  readonly hytheId: string;
  readonly hostKind = "codex-app-server";
  private readonly options: CodexHytheOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events = new Map<string, RpcReply[]>();
  private readonly waiters = new Map<string, Array<(event: RpcReply) => void>>();
  private readonly messageByTurn = new Map<string, string>();
  private readonly answerByTurn = new Map<string, string>();
  private readonly earlyCompleted = new Map<string, RpcReply>();
  private readonly controlTurns = new Set<string>();

  constructor(options: CodexHytheOptions) {
    this.options = options;
    this.hytheId = options.hytheId ?? "codex";
  }

  private readonly lifecycle = new HostLifecycle();
  onLifecycle(listener: Parameters<HostLifecycle["subscribe"]>[0]) { return this.lifecycle.subscribe(listener); }
  canStartTurn():boolean {return Boolean(this.process);}
  manifest() { return hostManifest(this); }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }

  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }
  async completedTurn(locatorRef:string,hostRef:string,messageId:string):Promise<HostMessage|null> {
    const result=await this.control(locatorRef,"conversation.read",{});
    const thread=result.thread as {id?:string;turns?:Array<{id?:string;status?:string;items?:Array<{type?:string;text?:string;phase?:string|null}>}>}|undefined;
    if(thread?.id!==locatorRef)throw new SideraError("conflict","Provider read returned another conversation");
    const turn=thread.turns?.find(t=>t.id===hostRef);
    if(turn && ["failed","interrupted"].includes(turn.status??""))
      return {hostRef,observedMessageId:messageId,body:`Original Host turn ended: ${turn.status}`,outcome:"failed"};
    if(turn?.status!=="completed")return null;
    const body=turn.items?.filter(i=>i.type==="agentMessage" && typeof i.text==="string" && (!i.phase||i.phase==="final_answer")).at(-1)?.text;
    return body?.trim()?{hostRef,observedMessageId:messageId,body,outcome:"completed"}:null;
  }

  async control(locatorRef: string, operation: string,
    input: Record<string, unknown>, boundary?:EffectBoundary): Promise<Record<string, unknown>> {
    const text = (key: string): string => {
      if (typeof input[key] !== "string" || !input[key])
        throw new SideraError("conflict", `${key} is required`);
      return input[key] as string;
    };
    let method: string;
    let params: Record<string, unknown>;
    // Never forward arbitrary host parameters: threadId/path/history overrides
    // could escape Core's pinned Session and its Authority resource.
    switch (operation) {
      case "conversation.read":
      case "session.inspect":
        method = "thread/read";
        params = { threadId: locatorRef, includeTurns: operation === "conversation.read" };
        break;
      case "conversation.resume":
        method = "thread/resume"; params = { threadId: locatorRef, excludeTurns: true }; break;
      case "conversation.interrupt":
        method = "turn/interrupt"; params = { threadId: locatorRef, turnId: text("turnId") }; break;
      case "conversation.steer":
        method = "turn/steer";
        params = { threadId: locatorRef, expectedTurnId: text("turnId"),
          input: [{ type: "text", text: text("body") }] }; break;
      case "conversation.send":
        method = "turn/start";
        params = { threadId: locatorRef,
          input: [{ type: "text", text: text("body") }],
          cwd: this.options.workspace, model: this.options.model === 'auto' ? undefined : this.options.model,
          ...this.localExecutionPolicy() };
        break;
      case "model.list":
        method = "model/list"; params = { limit: 100 }; break;
      case "tool.list":
        method = "mcpServerStatus/list"; params = { threadId: locatorRef }; break;
      default: throw new SideraError("unavailable", "Host control is not implemented");
    }
    await this.start();
    const result = await (operationEffect(operation)==="read" ? this.request(method,params) :
      crossEffect(boundary,this.hostKind,locatorRef,operation,()=>this.request(method,params)));
    if (operation === "conversation.send") {
      const turn = result.turn as { id?: string } | undefined;
      if (!turn?.id) throw new SideraError("uncertain", "Codex control turn ID is missing");
      this.controlTurns.add(turn.id);
      this.earlyCompleted.delete(turn.id);
      this.answerByTurn.delete(turn.id);
      return { status: "accepted", hostRef: turn.id };
    }
    return result;
  }

  async createSession(boundary?:EffectBoundary, sourceLocator?:string): Promise<string> {
    await this.start();
    const begin = () => this.request("thread/start", {
      model: this.options.model === 'auto' ? undefined : this.options.model,
      cwd: this.options.workspace,
      ...this.localExecutionPolicy(),
    });
    if (boundary && !sourceLocator) throw new SideraError("denied", "Session creation requires the exact source locator");
    const result = boundary
      ? await crossEffect(boundary,this.hostKind,sourceLocator!,"session.create",begin)
      : await begin();
    const thread = result.thread as { id?: string } | undefined;
    if (!thread?.id) throw new Error("Codex did not return a Session locator");
    return thread.id;
  }

  async start(): Promise<void> {
    if (this.process) return;
    const { home, temp, workspace } = this.options;
    const codexHome = this.options.codexHome ?? join(home, "codex");
    for (const path of [home, temp, workspace, codexHome,
      join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) {
      mkdirSync(path, { recursive: true });
    }
    // A Codex update moves its bin hash directory, which silently invalidates a
    // pinned path. Fail with the exact reason instead of an opaque Host failure;
    // never substitute a different binary than the one that was pinned.
    if (!existsSync(this.options.codexExecutable))
      throw new Error(`Configured Codex executable is missing: ${this.options.codexExecutable}. ` +
        "A Codex update changes its bin hash directory; re-pin options.codexExecutable to the installed codex.exe.");
    const configPath=join(codexHome,"config.toml");
    const exposure=canonicalCodexMcpOverrides(existsSync(configPath)?readFileSync(configPath,"utf8"):"");
    const child = spawn(this.options.codexExecutable, ["app-server",...exposure], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        COMSPEC: process.env.COMSPEC,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        TEMP: temp,
        TMP: temp,
        CODEX_HOME: codexHome,
        [this.options.coreTokenEnvName ?? "SIDERA_NODE_CORE_TOKEN"]: this.options.coreToken,
        SIDERA_CORE_PORT: String(this.options.corePort ?? 8765),
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => this.onLine(line));
    child.once("exit", () => this.disconnected());
    child.once("error", () => this.disconnected());
    // stderr may include private host details; do not forward it into Sidera logs.
    child.stderr.resume();
    await this.request("initialize", {
      clientInfo: { name: "sidera-codex-hythe", title: "Sidera Codex Hythe", version: "0.1.0" },
    });
    this.write({ method: "initialized", params: {} });
  }

  async locate(locatorRef: string): Promise<boolean> {
    await this.start();
    try {
      const result = await this.request("thread/resume", { threadId: locatorRef,
        excludeTurns: true });
      const thread = result.thread as { id?: string } | undefined;
      return thread?.id === locatorRef;
    } catch {
      return false;
    }
  }

  async invoke(locatorRef: string, capability: string, input: unknown,
    requestId: string, boundary?:EffectBoundary): Promise<InvokeResult> {
    if (capability !== "message.receive") {
      return { status: "rejected", reason: "Capability is not implemented by this R1 Hythe" };
    }
    await this.start();
    const message = input as { messageId?: string; body?: string; taskId?: string; runId?: string; wakeContext?: WakeContext };
    if (!message?.messageId || typeof message.body !== "string") {
      return { status: "rejected", reason: "Message envelope is incomplete" };
    }
    try {
      const result = await crossEffect(boundary,this.hostKind,locatorRef,"message.receive",()=>this.request("turn/start", {
        threadId: locatorRef,
        input: [{ type: "text", text: renderWakeContext(message.wakeContext) + `Sidera message ${message.messageId}\n` +
          (message.runId ? `Task ${message.taskId}; Run ${message.runId}. To delegate, call task_dispatch with parentRunId=${message.runId} and a checkpoint. After waiting_dependency, end this turn; do not poll or wait. Sidera will start a new continuation turn with the result.\n` : "") + message.body }],
        cwd: this.options.workspace,
        model: this.options.model === 'auto' ? undefined : this.options.model,
        ...this.localExecutionPolicy(),
      }));
      const turn = result.turn as { id?: string } | undefined;
      if (!turn?.id) return { status: "uncertain", reason: "Codex did not return a turn ID" };
      this.messageByTurn.set(turn.id, message.messageId);
      const completed = this.earlyCompleted.get(turn.id);
      if (completed) {
        this.earlyCompleted.delete(turn.id);
        this.pushEvent(completed);
      }
      return { status: "accepted", hostRef: turn.id };
    } catch {
      // The host may have accepted a turn before the transport failed.
      return { status: "uncertain", reason: `Codex turn start is unconfirmed (${requestId})` };
    }
  }

  async *receive(locatorRef: string): AsyncIterable<HostMessage> {
    await this.start();
    for (;;) {
      const event = await this.nextEvent(locatorRef);
      const p = event.params ?? {};
      if (p.threadId !== locatorRef) continue;
      const turnId = typeof p.turnId === "string" ? p.turnId :
        typeof (p.turn as { id?: unknown } | undefined)?.id === "string" ?
          (p.turn as { id: string }).id : null;
      if (!turnId) continue;
      if (this.controlTurns.has(turnId)) {
        if (event.method === "turn/completed") {
          this.controlTurns.delete(turnId);
          this.answerByTurn.delete(turnId);
        }
        continue;
      }
      if (event.method === "item/completed") {
        const item = p.item as { type?: string; text?: string; phase?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string" &&
            (!item.phase || item.phase === "final_answer")) {
          this.answerByTurn.set(turnId, item.text);
        }
      }
      if (event.method === "turn/completed") {
        const messageId = this.messageByTurn.get(turnId);
        if (!messageId) {
          this.earlyCompleted.set(turnId, event);
          continue;
        }
        this.messageByTurn.delete(turnId);
        const turn = p.turn as { status?: unknown; items?: Array<{
          type?: string; text?: string; phase?: string | null;
        }> } | undefined;
        const finalItem = turn?.items?.filter(item => item.type === "agentMessage" &&
          typeof item.text === "string" &&
          (!item.phase || item.phase === "final_answer")).at(-1);
        const body = this.answerByTurn.get(turnId) ?? finalItem?.text ?? "";
        this.answerByTurn.delete(turnId);
        const status = turn?.status;
        yield { hostRef: turnId, observedMessageId: messageId, body,
          outcome: status === "completed" ? "completed" : "failed" };
      }
    }
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    child.kill();
    this.disconnected();
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private write(payload: unknown): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is unavailable");
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** Astra may edit only its Peregrine paths without waiting on a UI client. */
  private localExecutionPolicy(): Record<string, unknown> {
    return { approvalPolicy: "never", sandboxPolicy: {
      type: "workspaceWrite", writableRoots: [this.options.workspace,
        this.options.home, this.options.temp], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    } };
  }

  private onLine(line: string): void {
    let event: RpcReply;
    try { event = JSON.parse(line) as RpcReply; } catch { return; }
    // The two peers own independent request ID spaces. A Host request may use
    // the same ID as our pending request; its method makes it a request, never
    // a response. Preserve our pending result and fail closed on Host approvals.
    if ((typeof event.id === "number" || typeof event.id === "string") && event.method) {
      if (event.method === "item/commandExecution/requestApproval" ||
          event.method === "item/fileChange/requestApproval") {
        this.write({ id: event.id, result: { decision: "decline" } });
      } else {
        this.write({ id: event.id, error: { code: -32601,
          message: "Sidera Hythe cannot approve this Host request" } });
      }
      return;
    }
    if (typeof event.id === "number") {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      if (event.error) pending.reject(new SideraError("unavailable", "Codex rejected the host request"));
      else pending.resolve(event.result ?? {});
      return;
    }
    if (!event.method) return;
    this.pushEvent(event);
  }

  private pushEvent(event:RpcReply):void {
    const locatorRef=event.params?.threadId;
    if(typeof locatorRef!=="string")return;
    const waiting=this.waiters.get(locatorRef),waiter=waiting?.shift();
    if(waiting?.length===0)this.waiters.delete(locatorRef);
    if(waiter)waiter(event);
    else {
      const queue=this.events.get(locatorRef)??[];
      queue.push(event);this.events.set(locatorRef,queue);
    }
  }

  private nextEvent(locatorRef:string): Promise<RpcReply> {
    const queue=this.events.get(locatorRef),event=queue?.shift();
    if(queue?.length===0)this.events.delete(locatorRef);
    if (event) return Promise.resolve(event);
    return new Promise(resolve => {
      const waiting=this.waiters.get(locatorRef)??[];
      waiting.push(resolve);this.waiters.set(locatorRef,waiting);
    });
  }

  private disconnected(): void {
    this.lifecycle.lost("Host process or protocol connection ended");
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server disconnected"));
    }
    this.pending.clear();
  }
}

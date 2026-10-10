import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { hostManifest, controlsFromManifest } from "./manifest.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SideraError } from "../core/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";
import { renderWakeContext, type WakeContext } from "./wake-context.ts";
import { canonicalToolNames } from "./canonical-mcp.ts";

type Json = Record<string, unknown>;
type RpcMessage = { id?: number | string; method?: string; params?: Json;
  result?: Json; error?: { message?: string } };
type Pending = { resolve(result: Json): void; reject(error: Error): void;
  timer?: NodeJS.Timeout };
type ActiveTurn = { hostRef: string; messageId: string; body: string;
  requestId: number; sessionId: string; accepted: boolean; unknown: boolean;
  accept(value: boolean): void };

export interface GrokHytheOptions {
  executable: string;
  home: string;
  workspace: string;
  coreToken: string;
  corePort: number;
  mcpEntry: string;
  db: DatabaseSync;
  /** Only used by an ACP fixture; production starts the official Grok Build CLI. */
  launchArgs?: string[];
}

/** Exact-session ACP bridge. Grok Bot is a separate Host and is never impersonated here. */
export class GrokHythe implements Hythe {
  effectProfile(operation:string) {return ["message.receive","conversation.interrupt","session.create"].includes(operation) ? providerAdmissionProfile(this.hostKind,"ACP stdin prompt/cancel/session creation initiation") : undefined;}
  readonly hytheId = "grok-build";
  readonly hostKind = "grok-build-acp";
  private readonly options: GrokHytheOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly events: Array<{ locatorRef: string; event: HostMessage }> = [];
  private readonly waiters = new Map<string, Array<(event: HostMessage) => void>>();
  private active: ActiveTurn | null = null;
  private loadedSession: string | null = null;
  private boundModel: string | null = null;
  private sessionInfo: Json = {};

  constructor(options: GrokHytheOptions) { this.options = options; }
  private mcpServers() { return [{ name:"sidera", command:process.execPath, args:[this.options.mcpEntry], env:[
    {name:"SIDERA_NODE_CORE_TOKEN",value:this.options.coreToken},
    {name:"SIDERA_CORE_PORT",value:String(this.options.corePort)},
  ] }]; }

  private readonly lifecycle = new HostLifecycle();
  onLifecycle(listener: Parameters<HostLifecycle["subscribe"]>[0]) { return this.lifecycle.subscribe(listener); }
  manifest() { return hostManifest(this); }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }

  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }

  canStartTurn(): boolean { return Boolean(this.process) && !this.active; }

  modelId(): string | null { return this.boundModel; }

  async start(): Promise<void> {
    if (this.process && !this.starting) return;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async open(): Promise<void> {
    mkdirSync(this.options.home, { recursive: true });
    mkdirSync(this.options.workspace, { recursive: true });
    const roaming = join(this.options.home, "AppData", "Roaming");
    const local = join(this.options.home, "AppData", "Local");
    const temp = join(this.options.home, "temp");
    for (const path of [roaming, local, temp]) mkdirSync(path, { recursive: true });
    const proxy = process.env.SIDERA_GROK_PROXY;
    const child = spawn(this.options.executable,
      this.options.launchArgs ?? ["--no-auto-update", "agent", "stdio"], {
        cwd: this.options.workspace,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
          HOME: this.options.home, USERPROFILE: this.options.home,
          APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
          GROK_HOME: this.options.home,
          SIDERA_NODE_CORE_TOKEN: this.options.coreToken,
          SIDERA_CORE_PORT: String(this.options.corePort),
          ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
        },
      });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", line => this.onLine(line));
    // Host diagnostics can contain private text. Never forward them to Core logs.
    child.stderr.resume();
    this.lifecycle.watchChildExit(child,"Grok ACP child process exited",undefined,()=>this.process===child,
      ()=>this.disconnected());
    child.once("error", () => this.disconnected());
    try {
      const init = await this.request("initialize", {
        protocolVersion: 1, clientCapabilities: {},
      }, 30_000);
      const methods = Array.isArray(init.authMethods) ? init.authMethods as Json[] : [];
      if (!methods.some(method => method.id === "cached_token"))
        throw new SideraError("unavailable", "Grok Build has no cached account login in Sidera GROK_HOME");
      await this.request("authenticate", { methodId: "cached_token",
        _meta: { headless: true } }, 30_000);
    } catch (error) {
      child.kill();
      this.disconnected();
      throw error;
    }
  }

  async createSession(boundary?:EffectBoundary, sourceLocator?:string): Promise<string> {
    if (this.active) throw new SideraError("conflict", "Grok has an open turn; no Session switch");
    await this.start();
    const begin = () => this.request("session/new", {
      cwd: this.options.workspace, mcpServers: this.mcpServers(),
    }, 60_000);
    if (boundary && !sourceLocator) throw new SideraError("denied", "Session creation requires the exact source locator");
    const response = boundary
      ? await crossEffect(boundary,this.hostKind,sourceLocator!,"session.create",begin)
      : await begin();
    if (typeof response.sessionId !== "string" || !response.sessionId)
      throw new SideraError("unavailable", "Grok Build returned no Session locator");
    this.loadedSession = response.sessionId;
    this.captureSessionInfo(response);
    return response.sessionId;
  }

  async locate(locatorRef: string): Promise<boolean> {
    if (!locatorRef || typeof locatorRef !== "string") return false;
    if (this.active) return this.active.sessionId === locatorRef;
    try {
      await this.start();
      if (this.loadedSession === locatorRef) return true;
      const response = await this.request("session/load", {
        sessionId: locatorRef, cwd: this.options.workspace, mcpServers: this.mcpServers(),
      }, 60_000);
      // ACP LoadSessionResponse normally does not echo sessionId.
      if (response.sessionId && response.sessionId !== locatorRef) return false;
      this.loadedSession = locatorRef;
      this.captureSessionInfo(response);
      return true;
    } catch { return false; }
  }

  async invoke(locatorRef: string, capability: string, input: unknown,
    requestId: string, boundary?:EffectBoundary): Promise<InvokeResult> {
    if (capability !== "message.receive")
      return { status: "rejected", reason: "Grok Build does not expose this capability" };
    const message = input as { messageId?: string; body?: string;
      taskId?: string; runId?: string; wakeContext?: WakeContext } | null;
    if (!message || typeof message.messageId !== "string" ||
        typeof message.body !== "string")
      return { status: "rejected", reason: "Message envelope is incomplete" };
    if (this.active) return { status: "rejected", reason: "Pinned Grok Build Session has an open turn" };
    if (!await this.locate(locatorRef))
      return { status: "rejected", reason: "Pinned Grok Build Session is unavailable" };
    if (this.active) return { status: "rejected", reason: "Pinned Grok Build Session became busy" };
    const hostRef = randomUUID();
    const prompt = renderWakeContext(message.wakeContext) + `Sidera message ${message.messageId}\n` +
      (message.runId ? `Task ${message.taskId}; Run ${message.runId}. To delegate, call task_dispatch with parentRunId=${message.runId} and a checkpoint. After waiting_dependency, end this turn; do not poll. Sidera will resume this exact Session with the result.\n` : "") +
      `Fresh requestIds for this exact Host turn, each usable once: workspace_write_text=${randomUUID()}, task_dispatch=${randomUUID()}, responsibility_complete=${randomUUID()}. You can use these UUIDs directly in tool arguments; do not open a terminal just to generate IDs. A missing workspace file is normal before mode=create, so do not read an uncreated file merely to check existence.\n` +
      message.body;
    const id = this.nextId++;
    let accept!: (value: boolean) => void;
    const acknowledged = new Promise<boolean>(resolve => { accept = resolve; });
    this.active = { hostRef, messageId: message.messageId, body: "",
      requestId: id, sessionId: locatorRef, accepted: false, unknown: false, accept };
    try {
      // ACP has no separate prompt acceptance response. Wait for an exact-session
      // update or the final response; merely writing stdin is not Host acceptance.
      crossEffect(boundary,this.hostKind,locatorRef,"message.receive",()=>this.requestWithId(id, "session/prompt", { sessionId: locatorRef,
        prompt: [{ type: "text", text: prompt }] }, undefined)).then(result => {
        this.finishTurn(id, result);
      }, () => this.finishTurn(id, null));
      const timeout = setTimeout(() => {
        if (this.active?.requestId === id && !this.active.accepted) {
          this.active.unknown = true;
          this.active.accept(false);
        }
      }, 90_000);
      const accepted = await acknowledged;
      clearTimeout(timeout);
      return accepted ? { status: "accepted", hostRef } :
        { status: "uncertain", reason: `Grok ACP acceptance is unconfirmed (${requestId})` };
    } catch {
      this.active = null;
      return { status: "uncertain", reason: `Grok ACP prompt submission is unconfirmed (${requestId})` };
    }
  }

  async *receive(locatorRef: string): AsyncIterable<HostMessage> {
    for (;;) {
      const index = this.events.findIndex(item => item.locatorRef === locatorRef);
      const event = index >= 0 ? this.events.splice(index, 1)[0]!.event :
        await new Promise<HostMessage>(resolve => {
          const waiting = this.waiters.get(locatorRef) ?? [];
          waiting.push(resolve); this.waiters.set(locatorRef, waiting);
        });
      yield event;
    }
  }

  async control(locatorRef: string, operation: string,
    input: Record<string, unknown>, boundary?:EffectBoundary): Promise<Record<string, unknown>> {
    if (!await this.locate(locatorRef))
      throw new SideraError("not_found", "Pinned Grok Build Session is unavailable");
    if (operation === "session.inspect")
      return { sessionId: locatorRef, hostKind: this.hostKind,
        active: Boolean(this.active), modelId: this.boundModel,
        ...this.sessionInfo };
    if (operation === "session.create") return { sessionId: await this.createSession(), modelId: this.boundModel };
    if (operation === "conversation.resume")
      return { sessionId: locatorRef, loaded: true };
    if (operation === "conversation.interrupt") {
      if (!this.active) return { sessionId: locatorRef, interrupted: false };
      if (input.turnId !== this.active.hostRef)
        throw new SideraError("conflict", "Grok turn reference does not match the active turn");
      crossEffect(boundary,this.hostKind,locatorRef,operation,()=>this.write({ jsonrpc: "2.0", method: "session/cancel",
        params: { sessionId: locatorRef } }));
      return { status: "transport_admitted", sessionId: locatorRef, cancelRequested: true, interrupted: false,
        hostRef: this.active.hostRef };
    }
    throw new SideraError("unavailable", "Grok Build control is not implemented");
  }

  async close(): Promise<void> {
    this.process?.kill();
    this.disconnected();
  }

  private captureSessionInfo(response: Json): void {
    // ACP exposes the chosen model in session/new and session/load config.
    const models = response.models as Json | undefined;
    const option = Array.isArray(response.configOptions) ?
      (response.configOptions as Json[]).find(item => item.id === "model" ||
        item.configId === "model") : undefined;
    const selected = models?.currentModelId ?? option?.currentValue ??
      option?.value ?? response.modelId;
    this.boundModel = typeof selected === "string" && selected ? selected : null;
    this.sessionInfo = { availableControlOptions: Array.isArray(response.configOptions) ?
      (response.configOptions as Json[]).map(item => item.id ?? item.configId).filter(Boolean) : [] };
  }

  private finishTurn(id: number, result: Json | null): void {
    const turn = this.active;
    if (!turn || turn.requestId !== id) return;
    if (!turn.accepted && !turn.unknown) {
      turn.accept(Boolean(result && result.stopReason === "end_turn"));
      turn.accepted = Boolean(result && result.stopReason === "end_turn");
    }
    this.active = null;
    if (turn.unknown || !turn.accepted) return;
    const stopReason = result?.stopReason;
    const event: HostMessage = { hostRef: turn.hostRef,
      observedMessageId: turn.messageId, body: turn.body,
      outcome: result && stopReason === "end_turn" ? "completed" : "failed" };
    const item = { locatorRef: turn.sessionId, event };
    const waiter = this.waiters.get(turn.sessionId)?.shift();
    if (waiter) waiter(event); else this.events.push(item);
  }

  private request(method: string, params: Json, timeoutMs?: number): Promise<Json> {
    return this.requestWithId(this.nextId++, method, params, timeoutMs);
  }

  private requestWithId(id: number, method: string, params: Json,
    timeoutMs?: number): Promise<Json> {
    const promise = new Promise<Json>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (timeoutMs) pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, pending);
    });
    try { this.write({ jsonrpc: "2.0", id, method, params }); }
    catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending?.timer) clearTimeout(pending.timer);
      pending?.reject(error instanceof Error ? error : new Error("Grok ACP write failed"));
      // The caller distinguishes an unconfirmed write from Host acceptance.
      void promise.catch(() => {});
      throw error;
    }
    return promise;
  }

  private write(payload: Json): void {
    if (!this.process?.stdin.writable)
      throw new SideraError("unavailable", "Grok ACP stream is closed");
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handlePermission(id:number|string,params:Json|undefined):void {
    const toolCall=params?.toolCall as Json|undefined;
    const raw=toolCall?.rawInput as Json|undefined;
    const candidates=[toolCall?.name,toolCall?.title,raw?.toolName].filter((x):x is string=>typeof x==="string");
    const canonical=new Set(canonicalToolNames());
    const toolName=candidates.find(name=>{
      const normalized=name.startsWith("mcp__sidera__")?name.slice("mcp__sidera__".length):name;
      return canonical.has(normalized);
    });
    const options=Array.isArray(params?.options)?params!.options as Json[]:[];
    const allow=options.find(option=>option.kind==="allow_once"||option.kind==="allowOnce");
    const sameSession=!this.active || params?.sessionId===this.active.sessionId;
    if(toolName&&allow&&sameSession&&typeof allow.optionId==="string"){
      this.options.db.prepare("INSERT INTO events VALUES (?,NULL,\'host.permission.intent\',?,?)").run(randomUUID(),
        JSON.stringify({hostKind:this.hostKind,sessionId:params?.sessionId,toolName,optionId:allow.optionId,
          policy:"canonical-sidera-mcp-allow-once"}),new Date().toISOString());
      this.write({jsonrpc:"2.0",id,result:{outcome:{outcome:"selected",optionId:allow.optionId}}});
      return;
    }
    this.write({jsonrpc:"2.0",id,result:{outcome:{outcome:"cancelled"}}});
  }

  private onLine(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch { return; }
    if (typeof message.id === "number" || typeof message.id === "string") {
      // Server requests use an independent ID namespace. Never resolve a client
      // prompt merely because an incoming permission request reused its ID.
      if (message.method) {
        if (message.method === "session/request_permission") this.handlePermission(message.id,message.params);
        else this.write({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Sidera cannot satisfy Host requests" } });
        return;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) {
        // ACP may ask for permissions. This client cannot confer Host authority.
        if (message.method === "session/request_permission")
          this.write({ jsonrpc: "2.0", id: message.id,
            result: { outcome: { outcome: "cancelled" } } });
        else if (message.method) this.write({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Sidera cannot satisfy Host requests" } });
        return;
      }
      this.pending.delete(message.id as number);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Grok ACP request failed"));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method !== "session/update" || !this.active) return;
    if (message.params?.sessionId !== this.active.sessionId) return;
    const update = message.params.update as Json | undefined;
    const isPromptUpdate = ["user_message_chunk", "agent_message_chunk",
      "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]
      .includes(String(update?.sessionUpdate));
    if (isPromptUpdate && !this.active.accepted && !this.active.unknown) {
      this.active.accepted = true;
      this.active.accept(true);
    }
    const content = update?.content as Json | undefined;
    if (update?.sessionUpdate === "agent_message_chunk" && typeof content?.text === "string")
      this.active.body += content.text;
  }

  private disconnected(): void {
    this.lifecycle.lost("Host process or protocol connection ended");
    this.process = null;
    this.loadedSession = null;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("Grok ACP disconnected"));
    }
    this.pending.clear();
    if (this.active) this.finishTurn(this.active.requestId, null);
  }
}

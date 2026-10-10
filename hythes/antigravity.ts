import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { hostManifest, controlsFromManifest } from "./manifest.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "../core/types.ts";
import { renderWakeContext, type WakeContext } from "./wake-context.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";

export interface AntigravityOptions {
  executable: string; workspace: string; provider: string; modelId: string; effort: string;
  coreToken: string; corePort: number; mcpEntry: string; db: DatabaseSync;
  launchArgs?: string[]; settingsPath?: string;
}
type Turn = { messageId: string; requestId: string; hostRef: string;
  accepted: boolean; unknown: boolean; timer: NodeJS.Timeout; acknowledge(result: InvokeResult): void };

/** Official native NDJSON machine interface. Account credentials remain in the installed Host. */
export class AntigravityHythe implements Hythe {
  effectProfile(operation:string) {return ["message.receive","session.create"].includes(operation) ? providerAdmissionProfile(this.hostKind,"headless CLI process/user-event initiation") : undefined;}
  readonly hytheId = "antigravity-cli";
  readonly hostKind = "antigravity-cli-headless";
  private options: AntigravityOptions;
  private observedModel:{provider:string;modelId:string}|null=null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private locator: string | null = null;
  private discoveredTools: string[] = [];
  private turn: Turn | null = null;
  private events: HostMessage[] = [];
  private waiters: Array<(value: HostMessage) => void> = [];
  private initialized: ((id: string) => void) | null = null;
  private initializationError: ((error: Error) => void) | null = null;
  constructor(options: AntigravityOptions) { this.options = options; }
  private readonly lifecycle = new HostLifecycle();
  onLifecycle(listener: Parameters<HostLifecycle["subscribe"]>[0]) { return this.lifecycle.subscribe(listener); }
  manifest() { return hostManifest(this); }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }
  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }
  canStartTurn(): boolean { return Boolean(this.child) && !this.turn && (this.options.modelId!=='auto'||Boolean(this.observedModel)); }
  canReplaceLostSession(_locatorRef:string):boolean { return !this.turn; }
  modelBinding(locatorRef:string):{provider:string;modelId:string}|null {
    return this.locator===locatorRef?(this.options.modelId==='auto'?this.observedModel:{provider:this.options.provider,modelId:this.options.modelId}):null;
  }
  async control(locatorRef: string, operation: string) {
    if (operation !== "session.inspect" || !await this.locate(locatorRef))
      throw new SideraError("unavailable", "Exact Antigravity Session unavailable");
    return { conversationId: this.locator, modelId: this.options.modelId,
      effort: this.options.effort, backend: "native-stream-json", turnOpen: Boolean(this.turn), tools: this.discoveredTools };
  }
  prepare(): void {
    const dir = join(this.options.workspace, ".agents");
    mkdirSync(dir, { recursive: true });
    // No account credential is copied. MCP authenticates only this Node to Core.
    writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: { sidera: {
      command: process.execPath, args: [this.options.mcpEntry],
    } } }, null, 2));
    const settingsPath = this.options.settingsPath ?? join(process.env.USERPROFILE!, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
    settings.permissions ??= {};
    settings.permissions.allow ??= [];
    // CLI lazily exposes MCP schemas outside the workspace. Allow only this
    // server's schema metadata; terminal commands retain their Host policy.
    const schemaPath = join(process.env.USERPROFILE!, ".gemini", "antigravity-cli", "mcp", "sidera").replaceAll("\\", "/");
    const rules = ["mcp(sidera/*)", `read_file(${schemaPath})`];
    if (rules.some(rule => !settings.permissions.allow.includes(rule))) {
      if (existsSync(settingsPath)) writeFileSync(join(dir, "host-settings-before.json"), readFileSync(settingsPath));
      for (const rule of rules) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  }
  async createSession(boundary?:EffectBoundary,sourceLocator?:string): Promise<string> {
    this.prepare();
    if(boundary&&!sourceLocator)throw new SideraError("denied","Session creation requires the exact source locator");
    const begin=()=>this.open();
    return boundary?await crossEffect(boundary,this.hostKind,sourceLocator!,"session.create",begin):await begin();
  }
  async locate(locatorRef: string): Promise<boolean> {
    if (this.child) return this.locator === locatorRef;
    try { return await this.open(locatorRef) === locatorRef; } catch { return false; }
  }
  private async open(expected?: string): Promise<string> {
    if (this.child) throw new SideraError("conflict", "Antigravity Session is already open");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initialized = null; this.initializationError = null;
        this.child?.kill(); reject(new SideraError("unavailable", "Antigravity did not initialize; no inference was submitted"));
      }, 60_000);
      this.initialized = id => {
        clearTimeout(timer); this.initialized = null; this.initializationError = null;
        if (expected && id !== expected) {
          const child=this.child;
          if(!child){reject(new SideraError("unavailable","Antigravity resume process disappeared"));return;}
          child.once("exit",()=>reject(new SideraError("unavailable","Antigravity resumed another conversation")));
          child.kill();
        } else { this.locator = id; resolve(id); }
      };
      this.initializationError = error => { clearTimeout(timer); this.initialized = null; this.initializationError = null; reject(error); };
      const env: NodeJS.ProcessEnv = { ...process.env, SIDERA_NODE_CORE_TOKEN: this.options.coreToken,
        SIDERA_CORE_PORT: String(this.options.corePort) };
      // Do not offer unrelated API credentials as an alternate billing path.
      delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY; delete env.DEEPSEEK_API_KEY;
      const child = spawn(this.options.executable, [...this.options.launchArgs ?? [], "--input-format", "stream-json", "--output-format", "stream-json",
        // Discovery IDs already encode effort; passing --effort again is rejected
        // for these exact model variants. Do not fall back to the Host default.
        ...(this.options.modelId==='auto'?[]:["--model", this.options.modelId]),
        ...(expected ? ["--conversation", expected] : [])], {
        cwd: this.options.workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      createInterface({ input: child.stdout }).on("line", line => this.onLine(line));
      // Authentication diagnostics may be private. Do not expose them in Core logs.
      child.stderr.resume();
      child.once("error", () => this.disconnected());
      this.lifecycle.watchChildExit(child,"Antigravity child process exited",undefined,()=>this.child===child,
        ()=>this.disconnected());
    });
  }
  private onLine(line: string): void {
    let packet: Record<string, any>;
    try { packet = JSON.parse(line); } catch { return; }
    if (packet.event === "init" && typeof packet.conversation_id === "string") {
      const model=packet.init?.model;
      // Native agy 1.3 stream-json officially reports the selected Model ID
      // as a string, not the older {provider,modelId} object. This is Host
      // attestation of the chosen model, never a browser/API credential claim.
      this.observedModel=model&&typeof model==='object'&&typeof model.provider==='string'&&typeof model.modelId==='string'&&model.provider.length>0&&model.modelId.length>0
        ? {provider:model.provider,modelId:model.modelId}
        : typeof model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(model)
          ? {provider:'antigravity-cli',modelId:model}:null;
      this.discoveredTools = Array.isArray(packet.init?.tools) ? packet.init.tools.filter((name: unknown) => typeof name === "string") : [];
      this.options.db.prepare("INSERT INTO events VALUES (?, NULL, 'host.capabilities', ?, ?)").run(randomUUID(),
        JSON.stringify({ hostKind: this.hostKind, conversationId: packet.conversation_id,
          tools: this.discoveredTools, permissionMode: packet.init?.permission_mode }), new Date().toISOString());
      this.initialized?.(packet.conversation_id); return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (packet.event === "step_update") {
      const update = packet.step_update;
      if (update?.conversation_id !== this.locator) return;
      if (update.step_type === "user_input" && !turn.accepted) {
        turn.accepted = true; turn.acknowledge({ status: "accepted", hostRef: turn.hostRef });
      }
      return;
    }
    if (packet.event !== "result") return;
    const result = packet.result;
    if (result?.conversation_id !== this.locator) { this.unknown(); return; }
    // A late terminal event can reconcile the Host, but cannot complete or
    // release an already uncertain Core turn or emit another result.
    if (turn.unknown) return;
    if (!turn.accepted) { turn.accepted = true; turn.acknowledge({ status: "accepted", hostRef: turn.hostRef }); }
    // SUCCESS confirms a closed Host turn, even if it yielded without prose.
    // Core alone decides whether WAIT is established or a nonempty result
    // completes the Agent Task; an empty non-WAIT result remains uncertain.
    const completed = result.status === "SUCCESS" && typeof result.response === "string";
    this.options.db.prepare("INSERT INTO events VALUES (?, NULL, 'host.usage', ?, ?)").run(randomUUID(),
      JSON.stringify({ hostKind: this.hostKind, conversationId: this.locator, requestId: turn.requestId,
        modelId: this.options.modelId, effort: this.options.effort, status: result.status,
        usage: result.usage, responseLength: typeof result.response === "string" ? result.response.length : null,
        error: typeof result.error === "string" ? result.error.slice(0, 2000) : null,
        counters: "cumulative native session" }), new Date().toISOString());
    clearTimeout(turn.timer); this.turn = null;
    this.emit({ hostRef: turn.hostRef, observedMessageId: turn.messageId,
      body: completed ? result.response : String(result.error ?? `Antigravity terminal status ${result.status}`).slice(0, 2000),
      outcome: completed ? "completed" : "failed" });
  }
  private unknown(): void {
    const turn = this.turn;
    if (!turn || turn.unknown) return;
    turn.unknown = true;
    clearTimeout(turn.timer);
    turn.acknowledge({ status: "uncertain", reason: "Antigravity turn cannot be confirmed; never replay" });
    this.emit({ hostRef: turn.hostRef, observedMessageId: turn.messageId,
      body: "Antigravity turn cannot be confirmed; never replay", outcome: "failed" });
  }
  private disconnected(): void {
    this.lifecycle.lost("Host process or protocol connection ended");
    this.initializationError?.(new SideraError("unavailable", "Antigravity authentication or native initialization unavailable"));
    this.unknown(); this.child = null; this.locator=null;
  }
  async invoke(locatorRef: string, capability: string, input: unknown, requestId: string, boundary?:EffectBoundary): Promise<InvokeResult> {
    if (capability !== "message.receive" || !await this.locate(locatorRef))
      return { status: "rejected", reason: "Exact Antigravity Session unavailable" };
    if(this.options.modelId==='auto'&&!this.observedModel)return {status:'rejected',reason:'Owning product has not attested the default model identity; no model work submitted'};
    if (this.turn) return { status: "rejected", reason: "Antigravity has an open or uncertain turn" };
    const message = input as { messageId?: string; body?: string; kind?: string; taskId?: string; runId?: string; wakeContext?: WakeContext };
    if (!message.messageId || typeof message.body !== "string") return { status: "rejected", reason: "Missing canonical message" };
    const ordinaryConversation=message.kind==="conversation";
    if (ordinaryConversation && (typeof message.taskId==="string" || typeof message.runId==="string"))
      return {status:"rejected",reason:"Ordinary Human Conversation cannot claim Task or Run authority"};
    return new Promise(resolve => {
      const timer = setTimeout(() => this.unknown(), 12 * 60_000); timer.unref();
      this.turn = { messageId: message.messageId!, requestId, hostRef: randomUUID(), accepted: false, unknown: false, timer, acknowledge: resolve };
      const prompt = ordinaryConversation
        ? renderWakeContext(message.wakeContext) +
          `\nSidera Human Conversation ${locatorRef}; Message ${message.messageId}. ` +
          `Respond directly to the Human. This is not a Task or Run; do not dispatch tasks, operate tools or assume delegated authority.\n` +
          message.body
        : renderWakeContext(message.wakeContext) +
          `\nExact native conversation ${locatorRef}; Message ${message.messageId}; Task ${message.taskId}; Run ${message.runId}.\n` +
          `Canonical Sidera MCP is the only organizational control transport. If delegating use task_dispatch with this parentRunId and a self-contained checkpoint. ` +
          `Use the native call_mcp_tool surface with server sidera (session_active, grant_list, task_dispatch, workspace_write_text, runtime_checkpoint). ` +
          `Use the Host's file-read surface if schemas are needed; do not launch shell commands merely to discover MCP tools. ` +
          `End your turn after the child is durably dispatched (WAIT); Core will wake this exact conversation with the child result. Never poll or treat Host acceptance as Agent completion.\n` + message.body;
      try { crossEffect(boundary,this.hostKind,locatorRef,"message.receive",()=>this.child!.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n", error => { if (error) this.unknown(); })); }
      catch {clearTimeout(timer);this.turn=null;resolve({status:"rejected",reason:"Final Effect boundary denied"});}
    });
  }
  private emit(value: HostMessage): void { const waiter = this.waiters.shift(); if (waiter) waiter(value); else this.events.push(value); }
  async *receive(locatorRef: string): AsyncIterable<HostMessage> {
    while (this.locator === locatorRef) yield this.events.shift() ?? await new Promise<HostMessage>(resolve => this.waiters.push(resolve));
  }
  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.stdin.end(); });
  }
}

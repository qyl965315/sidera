import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { hostManifest, controlsFromManifest } from "./manifest.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { wakeContext } from "../core/subjectivity.ts";
import { SideraError } from "../core/types.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";

type Json = Record<string, unknown>;
type Packet = { id?: number | string; method?: string; params?: Json;
  result?: Json; error?: { message?: string } };
type Pending = { resolve(value: Json): void; reject(error: Error): void; timer?: NodeJS.Timeout };
type Turn = { id: number; sessionId: string; hostRef: string; messageId: string;
  output: string; accepted: boolean; uncertain: boolean; acknowledge(value: boolean): void };

export interface DshHytheOptions {
  executable: string;
  cliEntry: string;
  dshHome: string;
  workspace: string;
  db: DatabaseSync;
  coreToken: string;
  corePort: number;
  mcpEntry: string;
}

/** Packaged DSH Harness ACP Host. Each wake uses a fresh DSH Session. */
export class DshHythe implements Hythe {
  effectProfile(operation:string) {return ["message.receive","conversation.resume","session.create"].includes(operation) ? providerAdmissionProfile(this.hostKind,"ACP stdin prompt/resume/session creation initiation") : undefined;}
  readonly hytheId = "dsh-acp";
  readonly hostKind = "dsh-harness-acp";
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private catalog = new Set<string>();
  private negotiated:Json|null=null;
  private lastExit:{code:number|null;signal:string|null;errorCode?:string}|null=null;
  private starts=0;
  private stderrBytes=0;
  private retryAfter=0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessions = new Set<string>();
  private usedSessions = new Set<string>();
  private models = new Map<string, { provider: string; modelId: string }>();
  private turn: Turn | null = null;
  private probe: { locatorRef: string; output: string; tools: Map<string, { name: string; status?: string; output?: string }> } | null = null;
  private events = new Map<string, HostMessage[]>();
  private waiters = new Map<string, Array<(value: HostMessage) => void>>();
  private readonly options: DshHytheOptions;

  constructor(options: DshHytheOptions) { this.options = options; }

  private readonly lifecycle = new HostLifecycle();
  onLifecycle(listener: Parameters<HostLifecycle["subscribe"]>[0]) { return this.lifecycle.subscribe(listener); }
  manifest() { return hostManifest(this); }
  async prepareWake(locatorRef:string,boundary?:EffectBoundary):Promise<string> {
    if(!this.needsFreshWake(locatorRef))return locatorRef;
    const before=this.modelBinding(locatorRef),next=await this.createSession(boundary,locatorRef),after=this.modelBinding(next);
    if(!before || !after || before.provider!==after.provider || before.modelId!==after.modelId)
      throw new Error("Wake cannot silently migrate ModelBinding");
    return next;
  }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }
  canStartTurn(): boolean { return Boolean(this.child); }
  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }

  async start(): Promise<void> {
    if (this.child && !this.starting) return;
    if (this.starting) return this.starting;
    if(Date.now()<this.retryAfter)throw new SideraError("unavailable","DSH transport failure cooldown; no automatic retry");
    this.starting = this.open();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async open(): Promise<void> {
    mkdirSync(this.options.dshHome, { recursive: true });
    mkdirSync(this.options.workspace, { recursive: true });
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP, TMP: process.env.TMP,
      HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      ELECTRON_RUN_AS_NODE: "1", DSH_HOME: this.options.dshHome,
      DSH_TELEMETRY_MODE: "DISABLED" };
    const child = spawn(this.options.executable,
      [this.options.cliEntry, "--profile", "acp"], {
        cwd: this.options.workspace, env, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    this.child = child;
    this.starts++;this.stderrBytes=0;this.negotiated=null;
    createInterface({ input: child.stdout }).on("line", line => this.onLine(line));
    // DSH diagnostics can include private context; never send them to Core logs.
    child.stderr.on("data",value=>{this.stderrBytes+=value.length;});
    child.once("exit", (code,signal) => {if(this.child!==child)return;this.lastExit={code,signal};this.disconnected();});
    child.once("error", error => {if(this.child!==child)return;this.lastExit={code:null,signal:null,errorCode:(error as NodeJS.ErrnoException).code};this.disconnected();});
    try {
      const init = await this.request("initialize", {
        protocolVersion: 1, clientCapabilities: {},
      }, 12_000);
      if (init.protocolVersion !== 1)
        throw new SideraError("unavailable", "DSH ACP v1 was not negotiated");
      this.negotiated=init;
    } catch (error) {
      child.kill();
      this.disconnected();
      throw error;
    }
  }
  private mcpServers(){return [{name:"sidera",command:process.execPath,args:[this.options.mcpEntry],env:[
    {name:"SIDERA_NODE_CORE_TOKEN",value:this.options.coreToken},{name:"SIDERA_CORE_PORT",value:String(this.options.corePort)}]}];}

  async createSession(boundary?:EffectBoundary, sourceLocator?:string): Promise<string> {
    await this.start();
    const begin = () => this.request("session/new", {
      cwd: this.options.workspace,
      mcpServers:this.mcpServers(),
    }, 90_000);
    if (boundary && !sourceLocator) throw new SideraError("denied", "Session creation requires the exact source locator");
    const result = boundary
      ? await crossEffect(boundary,this.hostKind,sourceLocator!,"session.create",begin)
      : await begin();
    if (typeof result.sessionId !== "string" || !result.sessionId)
      throw new SideraError("unavailable", "DSH returned no Session locator");
    // Read only nonsecret Desktop configuration. The Host resolves credentials.
    const patch = readFileSync(join(this.options.dshHome, "profiles", "desktop", "cordis.patch.yml"), "utf8");
    const row = patch.split(/\n(?=- id:)/).find(row => row.includes('id: agent-default-model'));
    const provider = row?.match(/\n\s+provider:\s*([^\s]+)\s*\n/)?.[1];
    const modelId = row?.match(/\n\s+model:\s*([^\s]+)\s*\n/)?.[1];
    if (!provider || !modelId) throw new SideraError("unavailable", "Desktop model route is not configured");
    const selected = await this.request("session/set_config_option", {
      sessionId: result.sessionId, configId: "model", value: JSON.stringify([provider, modelId]),
    }, 60_000);
    const binding = this.parseModel(selected);
    if (!binding) {
      await this.request("session/close", { sessionId: result.sessionId }, 30_000);
      throw new SideraError("unavailable", "DSH did not report an actual model route");
    }
    this.sessions.add(result.sessionId);
    this.models.set(result.sessionId, binding);
    return result.sessionId;
  }

  modelBinding(locatorRef: string): { provider: string; modelId: string } | null {
    return this.models.get(locatorRef) ?? null;
  }
  canReplaceLostSession(locatorRef:string):boolean {return !this.sessions.has(locatorRef) && !this.turn;}
  needsFreshWake(locatorRef: string): boolean { return this.usedSessions.has(locatorRef); }

  /** One throwaway Host inference before creating a new Node; never retried on uncertainty. */
  async verifyInference(locatorRef: string): Promise<void> {
    if (!await this.locate(locatorRef) || this.turn || this.probe)
      throw new SideraError("unavailable", "DSH probe Session is unavailable");
    this.probe = { locatorRef, output: "", tools: new Map() };
    this.usedSessions.add(locatorRef);
    try {
      const result = await this.request("session/prompt", { sessionId: locatorRef,
        prompt: [{ type: "text", text: "Reply with exactly SIDERA_DSH_READY." }] }, 120_000);
      if (result.stopReason !== "end_turn" ||
          !this.probe.output.includes("SIDERA_DSH_READY"))
        throw new SideraError("unavailable", "DSH account inference was not confirmed");
    } catch {
      throw new SideraError("uncertain", "DSH account inference was not confirmed; do not replay the probe");
    } finally { this.probe = null; }
  }

  /** Actual Agent MCP call and its correlated Core response, without a Task. */
  async verifySessionActive(locatorRef: string, expectedSessionId: string): Promise<Json> {
    if (!await this.locate(locatorRef) || this.turn || this.probe)
      throw new SideraError("unavailable", "DSH acceptance Session is unavailable");
    this.probe = { locatorRef, output: "", tools: new Map() };
    this.usedSessions.add(locatorRef);
    try {
      const result = await this.request("session/prompt", { sessionId: locatorRef,
        prompt: [{ type: "text", text: "Host binding acceptance only. Call mcp__sidera__session_active exactly once. Do not call any other tool. After the successful result reply SIDERA_DSH_CORE_READY." }] }, 120_000);
      const calls = [...this.probe.tools.values()].filter(call => call.name === "mcp__sidera__session_active");
      if (result.stopReason !== "end_turn" || calls.length !== 1 ||
          calls[0]?.status !== "completed" || !calls[0].output?.includes(expectedSessionId))
        throw new SideraError("unavailable", "DSH session_active did not confirm its exact Core binding");
      return { stopReason: result.stopReason, tool: calls[0].name,
        toolStatus: calls[0].status, coreSessionId: expectedSessionId };
    } finally { this.probe = null; }
  }

  async closeSession(locatorRef: string): Promise<void> {
    if (!this.sessions.has(locatorRef)) return;
    await this.request("session/close", { sessionId: locatorRef }, 60_000);
    this.sessions.delete(locatorRef);
  }

  async locate(locatorRef: string): Promise<boolean> {
    await this.discoverSessions();
    // Persisted catalog presence is not an active Agent. Resuming requires an
    // explicit governed operation, never a hidden side effect of discovery.
    return this.sessions.has(locatorRef) && Boolean(this.child);
  }

  async discoverSessions():Promise<{locatorRef:string;active:boolean}[]> {
    await this.start();
    const capabilities=this.negotiated?.agentCapabilities as Json|undefined;
    if(!(capabilities?.sessionCapabilities as Json|undefined)?.list)return [...this.sessions].map(locatorRef=>({locatorRef,active:true}));
    const found=new Set<string>();let cursor:unknown;
    for(let page=0;page<20;page++){
      const result=await this.request("session/list",{cwd:this.options.workspace,...(cursor?{cursor}: {})},5_000);
      if(!Array.isArray(result.sessions))throw new SideraError("unavailable","DSH catalog schema invalid");
      for(const item of result.sessions as Json[])if(typeof item.sessionId==="string")found.add(item.sessionId);
      if(!result.nextCursor){this.catalog=found;return [...found].map(locatorRef=>({locatorRef,active:this.sessions.has(locatorRef)}));}
      if(result.nextCursor===cursor)throw new SideraError("unavailable","DSH catalog cursor did not advance");
      cursor=result.nextCursor;
    }
    throw new SideraError("unavailable","DSH catalog bounded pagination exceeded");
  }
  diagnostics(){return {transportConnected:Boolean(this.child&&this.negotiated),negotiatedProtocol:this.negotiated?.protocolVersion??null,
    sessionCount:this.catalog.size,activeSessionCount:this.sessions.size,starts:this.starts,stderrBytes:this.stderrBytes,lastExit:this.lastExit,
    recovery:"Explicit catalog observation; exact session resume requires Authority/Effect gate; no prompt replay"};}

  async control(locatorRef: string, operation: string,_input?:unknown,boundary?:EffectBoundary): Promise<Json> {
    const catalog=await this.discoverSessions();
    if(operation==="conversation.resume"){
      if(!catalog.some(x=>x.locatorRef===locatorRef))throw new SideraError("unavailable","Exact DSH persisted locator absent");
      if(this.sessions.has(locatorRef))return {locatorRef,alreadyActive:true};
      const result=await crossEffect(boundary,this.hostKind,locatorRef,operation,()=>this.request("session/resume",{sessionId:locatorRef,cwd:this.options.workspace,mcpServers:this.mcpServers()},60_000));
      const binding=this.parseModel(result);
      if(!binding)throw new SideraError("uncertain","Resumed DSH Session did not report ModelBinding; do not replay");
      this.sessions.add(locatorRef);this.models.set(locatorRef,binding);
      return {locatorRef,modelBinding:binding,status:"host_confirmed"};
    }
    if (operation !== "session.inspect" || !catalog.some(x=>x.locatorRef===locatorRef))
      throw new SideraError("unavailable", "DSH Session is unavailable");
    return { locatorRef, modelBinding: this.modelBinding(locatorRef),
      active: this.sessions.has(locatorRef),inFlight:this.turn?.sessionId===locatorRef,transport:this.diagnostics() };
  }

  async invoke(locatorRef: string, capability: string, input: unknown,
    requestId: string, boundary?:EffectBoundary): Promise<InvokeResult> {
    if (capability !== "message.receive" || !await this.locate(locatorRef))
      return { status: "rejected", reason: "Pinned DSH Session is unavailable" };
    if (this.turn) return { status: "rejected", reason: "DSH has an open turn" };
    const message = input as { messageId?: string; body?: string; taskId?: string;
      runId?: string; targetSessionId?: string } | null;
    if (!message || typeof message.messageId !== "string" ||
        typeof message.body !== "string" || typeof message.targetSessionId !== "string")
      return { status: "rejected", reason: "DSH message envelope is incomplete" };
    const bound = this.options.db.prepare(`SELECT node_id, session_id FROM sessions WHERE
      locator_ref = ? AND hythe_id = ? AND host_kind = ? AND state = 'active'`)
      .get(locatorRef, this.hytheId, this.hostKind) as { node_id: string; session_id: string } | undefined;
    if (!bound || bound.session_id !== message.targetSessionId)
      return { status: "rejected", reason: "DSH exact Node Session binding does not match" };
    if (this.usedSessions.has(locatorRef)) return { status: "rejected", reason: "A fresh wake requires explicit Session handoff" };
    const context = wakeContext(this.options.db, bound.node_id);
    const prompt = `Sidera fresh wake. This is a new Host Session; no previous conversation is supplied.\n` +
      `Node identity: ${JSON.stringify(context.identity)}\n` +
      `Current Description: ${context.subjectivity.description}\n` +
      `Current Explanation: ${context.subjectivity.explanation}\n` +
      `Subjectivity revision: ${context.subjectivity.revision}\n` +
      `Current Roles: ${JSON.stringify(context.roles)}\n` +
      `Current Responsibilities: ${JSON.stringify(context.responsibilities)}\n` +
      `Proposed Responsibilities (accept, decline or negotiate before commitment): ${JSON.stringify(context.proposals)}\n` +
      `Open/waiting Tensions: ${JSON.stringify(context.tensions)}\n` +
      `Events wake a Node; tensions move it. Choose the meaningful unresolved tension yourself. ` +
      `Authority, accepted public Responsibilities and actual world consequences are Rules; private reinterpretation cannot erase them.\n` +
      `Description is your subjective impression, not Shared History evidence. ` +
      `Use subjectivity_revise to author both documents when this wake changes your view.\n` +
      `Message ${message.messageId}; Task ${message.taskId}; Run ${message.runId}. ` +
      `If delegating, use task_dispatch with this parentRunId and a self-contained checkpoint, ` +
      `then runtime_checkpoint WAIT and end your turn. A child result event will wake you in a fresh Session. ` +
      `For CONTINUE cite new progress; IDLE when no immediate action remains. Never poll or await a child in a Host turn.\n` +
      `Fresh requestIds: subjectivity_revise=${randomUUID()}, ` +
      `responsibility_complete=${randomUUID()}, task_dispatch=${randomUUID()}.\n` +
      `Current authorized event/request (workflow record, not your subjective motivation): ${message.body}`;
    const id = this.nextId++;
    const hostRef = `dsh:${randomUUID()}`;
    let acknowledge!: (value: boolean) => void;
    const acknowledged = new Promise<boolean>(resolve => { acknowledge = resolve; });
    this.turn = { id, sessionId: locatorRef, hostRef,
      messageId: message.messageId, output: "", accepted: false,
      uncertain: false, acknowledge };
    this.usedSessions.add(locatorRef);
    this.options.db.prepare("INSERT INTO events VALUES (?, ?, 'runtime.wake_hydrated', ?, ?)")
      .run(randomUUID(), bound.node_id, JSON.stringify({ runId: message.runId ?? null,
        sessionId: bound.session_id, locatorRef, subjectivityRevision: context.subjectivity.revision,
        responsibilityIds: context.responsibilities.map(item => item.responsibilityId),
        tensionIds: context.tensions.map(item => item.tensionId), transcriptReplay: false }), new Date().toISOString());
    try {
      crossEffect(boundary,this.hostKind,locatorRef,"message.receive",()=>this.requestWithId(id, "session/prompt", { sessionId: locatorRef,
        prompt: [{ type: "text", text: prompt }] }, 0)).then(
          result => this.finishTurn(id, result), () => this.finishTurn(id, null));
      const timer = setTimeout(() => {
        if (this.turn?.id === id && !this.turn.accepted) {
          this.turn.uncertain = true;
          this.turn.acknowledge(false);
        }
      }, 90_000);
      const accepted = await acknowledged;
      clearTimeout(timer);
      return accepted ? { status: "accepted", hostRef } :
        { status: "uncertain", reason: `DSH prompt acceptance is unconfirmed (${requestId})` };
    } catch {
      this.turn = null;
      return { status: "uncertain", reason: `DSH prompt submission is unconfirmed (${requestId})` };
    }
  }

  async *receive(locatorRef: string): AsyncIterable<HostMessage> {
    if (!await this.locate(locatorRef))
      throw new SideraError("unavailable", "DSH Session is unavailable");
    for (;;) {
      const queue = this.events.get(locatorRef);
      const item = queue?.shift() ?? await new Promise<HostMessage>(resolve => {
        const listeners = this.waiters.get(locatorRef) ?? [];
        listeners.push(resolve);
        this.waiters.set(locatorRef, listeners);
      });
      yield item;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // The official ACP profile drains and flushes on stdin EOF. Close its
    // quiescent Sessions first, then wait for that shutdown instead of killing it.
    for (const locator of [...this.sessions]) await this.closeSession(locator);
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SideraError("uncertain",
        "ACP shutdown did not settle; do not force a test restart")), 30_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    child.stdin.end();
    await exited;
  }

  private parseModel(result: Json): { provider: string; modelId: string } | null {
    const options = Array.isArray(result.configOptions) ? result.configOptions as Json[] : [];
    const option = options.find(item => item.id === "model");
    const value = option?.currentValue;
    if (typeof value !== "string") return null;
    try {
      const pair = JSON.parse(value) as unknown;
      if (Array.isArray(pair) && pair.length === 2 &&
          typeof pair[0] === "string" && typeof pair[1] === "string")
        return { provider: pair[0], modelId: pair[1] };
    } catch { /* The catalog may use another opaque shape. */ }
    return null;
  }

  private request(method: string, params: Json, timeout: number): Promise<Json> {
    return this.requestWithId(this.nextId++, method, params, timeout);
  }

  private requestWithId(id: number, method: string, params: Json, timeout: number): Promise<Json> {
    const promise = new Promise<Json>((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ACP ${method} timed out`));
      }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
    });
    try { this.write({ jsonrpc: "2.0", id, method, params }); }
    catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending?.timer) clearTimeout(pending.timer);
      pending?.reject(error instanceof Error ? error : new Error("DSH write failed"));
      void promise.catch(() => {});
      throw error;
    }
    return promise;
  }

  private write(value: Json): void {
    if (!this.child?.stdin.writable)
      throw new SideraError("unavailable", "DSH ACP stream is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private onLine(line: string): void {
    let packet: Packet;
    try { packet = JSON.parse(line) as Packet; } catch { return; }
    // ACP server-to-client requests may reuse numeric IDs from our client-to-server
    // sequence. Route by method first so a permission request cannot settle a prompt.
    if (packet.method && packet.id !== undefined) {
      if (packet.method === "session/request_permission")
        this.write({ jsonrpc: "2.0", id: packet.id,
          result: { outcome: { outcome: "cancelled" } } });
      else this.write({ jsonrpc: "2.0", id: packet.id,
        error: { code: -32601, message: "Sidera cannot satisfy Host requests" } });
      return;
    }
    if (packet.id !== undefined) {
      const pending = typeof packet.id === "number" ? this.pending.get(packet.id) : undefined;
      if (!pending) return;
      this.pending.delete(packet.id as number);
      if (pending.timer) clearTimeout(pending.timer);
      if (packet.error) pending.reject(new Error(packet.error.message ?? "DSH ACP request failed"));
      else pending.resolve(packet.result ?? {});
      return;
    }
    if (packet.method !== "session/update") return;
    const update = packet.params?.update as Json | undefined;
    const content = update?.content as Json | undefined;
    if (this.probe && packet.params?.sessionId === this.probe.locatorRef) {
      if (update?.sessionUpdate === "tool_call" && typeof update.toolCallId === "string")
        this.probe.tools.set(update.toolCallId, { name: String(update.title), status: String(update.status) });
      if (update?.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string") {
        const call = this.probe.tools.get(update.toolCallId);
        if (call) { call.status = String(update.status); call.output = JSON.stringify(update.content); }
      }
    }
    if (this.probe && packet.params?.sessionId === this.probe.locatorRef &&
        update?.sessionUpdate === "agent_message_chunk" &&
        typeof content?.text === "string") this.probe.output += content.text;
    if (!this.turn || packet.params?.sessionId !== this.turn.sessionId) return;
    if (update && !this.turn.accepted && !this.turn.uncertain) {
      this.turn.accepted = true;
      this.turn.acknowledge(true);
    }
    if (update?.sessionUpdate === "agent_message_chunk" && typeof content?.text === "string")
      this.turn.output += content.text;
  }

  private finishTurn(id: number, result: Json | null): void {
    const turn = this.turn;
    if (!turn || turn.id !== id) return;
    if (!turn.accepted && !turn.uncertain) {
      turn.accepted = Boolean(result?.stopReason === "end_turn");
      turn.acknowledge(turn.accepted);
    }
    this.turn = null;
    if (turn.uncertain || !turn.accepted) return;
    const event: HostMessage = { hostRef: turn.hostRef,
      observedMessageId: turn.messageId, body: turn.output,
      outcome: result?.stopReason === "end_turn" && turn.output.trim() ?
        "completed" : "failed" };
    const waiter = this.waiters.get(turn.sessionId)?.shift();
    if (waiter) waiter(event);
    else {
      const queue = this.events.get(turn.sessionId) ?? [];
      queue.push(event);
      this.events.set(turn.sessionId, queue);
    }
  }

  private disconnected(): void {
    this.lifecycle.lost("Host process or protocol connection ended");
    this.child = null;
    this.sessions.clear();
    this.catalog.clear();this.negotiated=null;this.retryAfter=Date.now()+30_000;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("DSH ACP disconnected"));
    }
    this.pending.clear();
    if (this.turn) this.finishTurn(this.turn.id, null);
  }
}

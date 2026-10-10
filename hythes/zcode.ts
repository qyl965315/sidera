import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { hostManifest, controlsFromManifest } from "./manifest.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "../core/types.ts";
import { renderWakeContext, type WakeContext } from "./wake-context.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";
type Json = Record<string, any>;
type Binding = { provider: string; modelId: string; effort?: string };
type Turn = { messageId: string; requestId: string; commandId: string; hostRef: string;
  text: string; nativeTurnId?: string; uncertain: boolean; runningSeen?: boolean; terminalRead?: boolean; timer: NodeJS.Timeout };
export interface ZcodeOptions {
  serviceUrl: string; sdkPath: string; workspace: string; mcpConnectionPath: string;
  mcpEntry: string; db: DatabaseSync;
}
/** Version-pinned official ZCode service + client SDK. The Host alone resolves
 * subscription authentication. Writes use native v4; the official read-only
 * conversation rows supply correlated turn IDs and terminal results; native
 * state frames supply usage. Legacy Session events are a different interface.
 */
export class ZcodeHythe implements Hythe {
  effectProfile(operation:string) {return ["message.receive","session.create"].includes(operation) ? providerAdmissionProfile(this.hostKind,"native SDK command/session creation admission (SDK may queue after handoff)") : undefined;}
  readonly hytheId = "zcode-service";
  readonly hostKind = "zcode-native-service";
  private options: ZcodeOptions;
  private sdk: Json | null = null;
  private socket: WebSocket | null = null;
  private locator: string | null = null;
  private binding: Binding | null = null;
  private turn: Turn | null = null;
  private subscription: { dispose(): void } | null = null;
  private events: HostMessage[] = [];
  private waiters: Array<(value: HostMessage) => void> = [];
  private eventChain = Promise.resolve();
  private clientId = randomUUID();
  private locateFailure="Exact ZCode Session has not been observed";
  private snapshotReady: ((snapshot: Json) => void) | null = null;
  private permissionIntents = new Set<string>();
  private usage: Json | null = null;
  constructor(options: ZcodeOptions) {
    const url = new URL(options.serviceUrl);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/ws")
      throw new Error("ZCode service must use its loopback terminal-client interface");
    this.options = options;
  }
  private readonly lifecycle = new HostLifecycle();
  onLifecycle(listener: Parameters<HostLifecycle["subscribe"]>[0]) { return this.lifecycle.subscribe(listener); }
  manifest() { return hostManifest(this); }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }
  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }
  canStartTurn(): boolean { return this.socket?.readyState===1 && !this.turn; }
  canReplaceLostSession():boolean {return !this.turn && this.locateFailure.includes("fault.subscribe.sessionNotFound");}
  modelBinding(): Binding | null { return this.binding; }
  private workspace(): Json { return { workspacePath: this.options.workspace }; }
  private mcpServers(): Json[] { return [{ name: "sidera", command: process.execPath,
    args: [this.options.mcpEntry, this.options.mcpConnectionPath], env: [], isolation: "session" }]; }
  private async connect(): Promise<Json> {
    if (this.sdk) return this.sdk;
    const module = await import(pathToFileURL(this.options.sdkPath).href);
    const sdk = await module.connectViaWebSocket(this.options.serviceUrl, {
      onOpenSocket: (socket: WebSocket) => { this.socket = socket; },
      onClose: () => { this.lifecycle.lost("ZCode service disconnected"); this.unknown("ZCode service disconnected; do not replay"); },
    });
    const hello = await sdk.zcodeAgentService.helloConversationV4();
    if (hello.clientMode !== "web-remote-replayable") { this.socket?.close(); throw new Error("Unexpected ZCode Host connection role"); }
    await sdk.zcodeAgentService.initializeConversationV4({ kind: "clientHello",
      protocolVersion: hello.protocolVersion, clientId: this.clientId, clientKind: "web", appVersion: "sidera-r1" });
    this.sdk = sdk;
    this.subscription = sdk.zcodeAgentService.onDynamicConversationFrame(this.workspace())((frame: Json) => {
      this.eventChain = this.eventChain.then(() => this.onFrame(frame)).catch(() => this.unknown("ZCode native frame cannot be confirmed; never replay"));
    });
    return sdk;
  }
  private acceptSnapshot(snapshot: Json, expected?: string): string {
    const locator = snapshot.sessionId, current = snapshot.config?.modelSelection;
    if (!locator || expected && locator !== expected) throw new SideraError("unavailable", "ZCode returned another native Session");
    if (!/^account:(bigmodel|zai)-(individual-coding-plan|start-plan)$/.test(current?.providerId ?? ""))
      throw new SideraError("unavailable", "ZCode subscription ModelBinding unavailable");
    const binding = { provider: current.providerId, modelId: current.modelId, effort: snapshot.config?.thought };
    if (this.binding && (binding.provider !== this.binding.provider || binding.modelId !== this.binding.modelId || binding.effort !== this.binding.effort))
      throw new SideraError("conflict", "ZCode ModelBinding changed; use explicit model.migrate");
    this.binding = binding; this.locator = locator;
    return locator;
  }
  private async subscribe(locator: string): Promise<string> {
    this.locator = locator;
    let timer: NodeJS.Timeout;
    const snapshot = new Promise<Json>((resolve, reject) => {
      this.snapshotReady = resolve;
      timer = setTimeout(() => reject(new Error("Exact ZCode snapshot deadline")), 30_000); timer.unref();
    });
    try {
      await this.sdk!.zcodeAgentService.subscribeConversationV4({ ...this.workspace(), sessionId: locator, visibility: "foreground" });
      return this.acceptSnapshot(await snapshot, locator);
    } finally { clearTimeout(timer!); this.snapshotReady = null; }
  }
  async createSession(boundary?:EffectBoundary, sourceLocator?:string): Promise<string> {
    const sdk = await this.connect(), view = await sdk.modelSelectionService.getView(this.workspace());
    const provider = view.providers?.find((p: Json) => /^account:(bigmodel|zai)-(individual-coding-plan|start-plan)$/.test(p.providerId) && p.config?.access?.entitled === true);
    const model = provider?.models?.find((m: Json) => /flash/i.test(m.modelId) && m.config?.enabled) ?? provider?.models?.find((m: Json) => m.config?.enabled);
    if (!model) throw new SideraError("unavailable", "No entitled ZCode account model; no API fallback");
    const levels = model.config?.optionSpecs?.reasoningLevel?.values ?? [];
    const options = levels.includes("high") ? { reasoningLevel: "high" } : {};
    const commandId = randomUUID();
    const begin = () => sdk.zcodeAgentService.sendConversationCommandV4({ ...this.workspace(), envelope: {
      commandId, clientId: this.clientId, sessionId: null, type: "createSession", issuedAt: Date.now(),
      payload: { workspaceId: this.options.workspace, config: { provider: provider.providerId, model: model.modelId,
        thought: options.reasoningLevel, mode: "build" }, mcpServers: this.mcpServers() } } });
    if (boundary && !sourceLocator) throw new SideraError("denied", "Session creation requires the exact source locator");
    const ack = boundary
      ? await crossEffect(boundary,this.hostKind,sourceLocator!,"session.create",begin)
      : await begin();
    if (ack.commandId !== commandId || ack.status !== "accepted" || ack.result?.type !== "createSession" || !ack.result.sessionId)
      throw new SideraError("unavailable", "Native ZCode createSession was not confirmed");
    return this.subscribe(ack.result.sessionId);
  }
  async locate(locator: string): Promise<boolean> {
    if (this.turn) return this.locator === locator;
    const prior = this.locator;
    try { const sdk = await this.connect();
      await this.subscribe(locator);
      return true;
    } catch(error) {
      this.locator = prior;
      this.locateFailure=(error instanceof Error?error.message:String(error)).replace(/(sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/gi,"[REDACTED]").slice(0,1000);
      return false;
    }
  }
  async control(locator: string, operation: string): Promise<Json> {
    if (operation !== "session.inspect" || !await this.locate(locator)) throw new SideraError("unavailable", this.locateFailure);
    return { conversationId: locator, ...this.binding, backend: this.hostKind, turnOpen: Boolean(this.turn) };
  }
  private async command(type: string, payload: Json, commandId: string,locator=this.locator): Promise<Json> {
    return this.sdk!.zcodeAgentService.sendConversationCommandV4({ ...this.workspace(), envelope: {
      commandId, clientId: this.clientId, sessionId: locator, type, payload, issuedAt: Date.now() } });
  }
  private async onFrame(candidate: Json): Promise<void> {
    if (candidate.topic !== `conversation/${this.locator}`) return;
    if (candidate.kind !== "complete") { this.unknown("Unsupported ZCode fragmented frame; no replay"); return; }
    const payload = candidate.frame?.payload;
    if (payload?.kind === "snapshot" && this.snapshotReady) { this.snapshotReady(payload.snapshot); return; }
    const turn = this.turn; if (!turn || turn.uncertain) return;
    const states = payload?.kind === "snapshot" ? [payload.snapshot] : (payload?.deltas ?? []).filter((op: Json) => op.op === "state.updated").map((op: Json) => op.patch);
    for (const state of states) {
      if (state.usage) this.usage = state.usage;
      for (const interaction of state.pendingInteractions ?? []) {
        if (this.permissionIntents.has(interaction.interactionId)) continue;
        const request = interaction.payload;
        const option = request?.options?.find((item: Json) => item.kind === "allowOnce");
        if (interaction.kind !== "permission" || !/^mcp__sidera__[a-z_]+$/.test(request?.toolName ?? "") || !option) {
          this.unknown("ZCode requires an additional Host interaction; never infer authorization"); return;
        }
        // Permit this canonical transport invocation once. Core independently
        // evaluates the Node's Authority before every cross-subject effect.
        this.permissionIntents.add(interaction.interactionId);
        const commandId = randomUUID();
        this.options.db.prepare("INSERT INTO events VALUES (?, NULL, 'host.permission.intent', ?, ?)").run(randomUUID(),
          JSON.stringify({ conversationId: this.locator, interactionId: interaction.interactionId, toolName: request.toolName, commandId }), new Date().toISOString());
        const ack = await this.command("resolveInteraction", { interactionId: interaction.interactionId, answer: { optionId: option.optionId } }, commandId);
        if (ack.commandId !== commandId || !["accepted", "noop"].includes(ack.status)) { this.unknown("ZCode permission response uncertain; never replay"); return; }
      }
      const phase = state.control?.phase;
      if (phase === "running" || phase === "prewarming") turn.runningSeen = true;
      if (!turn.runningSeen || turn.terminalRead || !["completedSuccess", "completedInterrupted", "error"].includes(phase)) continue;
      turn.terminalRead = true;
      if (phase !== "completedSuccess") { this.unknown(`ZCode native turn ended ${phase}; no replay`); return; }
      const result = await this.sdk!.zcodeAgentService.conversationRowsRangeV4({ ...this.workspace(), sessionId: this.locator, limit: 200 });
      const rows = result.rows ?? [];
      const header = rows.find((r: Json) => r.kind === "turnHeader" && r.sourceCommandId === turn.commandId && r.state === "completedSuccess");
      const user = rows.find((r: Json) => r.kind === "userInput" && r.sourceCommandId === turn.commandId && r.text === turn.text);
      const answer = rows.findLast((r: Json) => r.kind === "assistantText" && r.turnId === header?.turnId && r.state === "complete" && typeof r.text === "string" && r.text.trim());
      if (!header || !user || user.turnId !== header.turnId || !answer) { this.unknown("No correlated native ZCode terminal rows"); return; }
      turn.nativeTurnId = header.turnId;
      this.finish(turn, { type: "turn.completed", sessionId: this.locator, turnId: header.turnId,
        payload: { response: answer.text, usage: this.usage, duration: header.activeMs }, source: "native-v4-command-and-rows" });
    }
  }
  private finish(turn: Turn, fact: Json): void {
    const body = fact.payload?.response;
    if (fact.type !== "turn.completed" || typeof body !== "string" || !body.trim()) {
      this.unknown("ZCode did not produce a confirmed nonempty terminal result"); return; }
    this.options.db.prepare("INSERT INTO events VALUES (?, NULL, 'host.usage', ?, ?)").run(randomUUID(), JSON.stringify({
      hostKind: this.hostKind, conversationId: this.locator, nativeTurnId: fact.turnId,
      requestId: turn.requestId, commandId: turn.commandId, ...this.binding,
      source: fact.source, tokenCount: fact.payload.tokenCount, usage: fact.payload.usage, duration: fact.payload.duration }), new Date().toISOString());
    clearTimeout(turn.timer); this.turn = null;
    this.emit({ hostRef: turn.hostRef, observedMessageId: turn.messageId, body, outcome: "completed" });
  }
  private unknown(reason: string): void {
    const turn = this.turn; if (!turn || turn.uncertain) return;
    turn.uncertain = true; clearTimeout(turn.timer);
    this.options.db.prepare("INSERT INTO events VALUES (?, NULL, 'host.transport.uncertain', ?, ?)").run(randomUUID(),
      JSON.stringify({ hostKind: this.hostKind, requestId: turn.requestId, commandId: turn.commandId, reason }), new Date().toISOString());
    this.emit({ hostRef: turn.hostRef, observedMessageId: turn.messageId, body: reason, outcome: "failed" });
  }
  async invoke(locator: string, capability: string, input: unknown, requestId: string, boundary?:EffectBoundary): Promise<InvokeResult> {
    if (capability !== "message.receive" || !await this.locate(locator)) return { status: "rejected", reason: "Exact ZCode Session unavailable" };
    if (this.turn) return { status: "rejected", reason: "ZCode has an open or uncertain turn" };
    const message = input as { messageId?: string; body?: string; taskId?: string; runId?: string; wakeContext?: WakeContext };
    if (!message.messageId || typeof message.body !== "string") return { status: "rejected", reason: "Missing canonical message" };
    const text = renderWakeContext(message.wakeContext) + `\nExact ZCode conversation ${locator}; Message ${message.messageId}; Task ${message.taskId}; Run ${message.runId}.\n` +
      "Use the actual callable canonical MCP catalog, including project_source_read/grant_list/runtime_checkpoint where exposed. A remembered list of three tools is not catalog discovery. If a required tool cannot be called, report that boundary; do not silently substitute a Host file-read channel.\n" +
      "Use canonical Sidera MCP. Delegation uses this exact parentRunId and a self-contained checkpoint. After durable child dispatch end the turn (WAIT); Core automatically resumes this same conversation with the result. Do not poll.\n" + message.body;
    const timer = setTimeout(() => this.unknown("ZCode turn deadline; never replay"), 12 * 60_000); timer.unref();
    const turn: Turn = { messageId: message.messageId, requestId, commandId: randomUUID(), hostRef: randomUUID(), text, uncertain: false, timer };
    this.turn = turn;
    try { const finalLocator=this.locator??"";
      const ack = await crossEffect(boundary,this.hostKind,finalLocator,"message.receive",()=>this.command("sendText", { text, requestedDelivery: "startNow" }, turn.commandId,finalLocator));
      if (ack.commandId !== turn.commandId) throw new Error("Command correlation mismatch");
      if (ack.status !== "accepted") {
        if (["rejected", "stale", "noop"].includes(ack.status)) { clearTimeout(timer); this.turn = null;
          return { status: "rejected", reason: ack.reasonCode ?? "ZCode refused command" }; }
        throw new Error("Native command effect is unknown"); }
      return { status: "accepted", hostRef: turn.hostRef };
    } catch { this.unknown("ZCode command acceptance cannot be confirmed; never replay");
      return { status: "uncertain", reason: "ZCode command acceptance cannot be confirmed; never replay" }; }
  }
  private emit(value: HostMessage): void { const waiter = this.waiters.shift(); if (waiter) waiter(value); else this.events.push(value); }
  async *receive(locator: string): AsyncIterable<HostMessage> {
    while (this.locator === locator) yield this.events.shift() ?? await new Promise<HostMessage>(resolve => this.waiters.push(resolve));
  }
  async close(): Promise<void> { this.subscription?.dispose(); if (this.turn) clearTimeout(this.turn.timer); this.socket?.close(); }
}

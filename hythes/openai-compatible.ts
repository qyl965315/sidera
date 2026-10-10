import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { hostManifest, controlsFromManifest } from "./manifest.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { callCore, type CoreClientConfig } from "./core-client.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";
import { withTransaction } from "../core/db.ts";
import { SideraError } from "../core/types.ts";
import { renderWakeContext, type WakeContext } from "./wake-context.ts";
import { wakeContext } from "../core/subjectivity.ts";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_MAX_TOKENS = 8192;

type ChatMessage = { role: "user" | "assistant" | "tool"; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string; reasoning_content?: string };
type ToolCall = { id: string; type: "function";
  function: { name: string; arguments: string } };
type StreamResult = { content: string; reasoningContent: string;
  finishReason: string | null; toolCalls: ToolCall[]; usage: StreamUsage | null };
type StreamUsage = { promptTokens: number; cachedPromptTokens: number;
  completionTokens: number; totalTokens: number };
type Envelope = { messageId: string; taskId: string; runId: string;
  fromNodeId: string; targetSessionId: string; body: string; wakeContext?: WakeContext };

export interface CompatibleProvider {
  providerId: string;
  baseUrl: string;
  credentialRef?: string;
  supportsModelsEndpoint?: boolean;
  modelsEndpoint?: string;
  chatCompletionsEndpoint?: string;
  compatibility?: {
    thinking?: boolean;
    reasoningEffort?: boolean;
    promptCacheHitTokens?: boolean;
  };
}

export interface OpenAICompatibleHytheOptions {
  db: DatabaseSync;
  provider: CompatibleProvider;
  resolveCredential: (credentialRef: string) => string | undefined;
  fetchImpl?: typeof fetch;
  nodeId: string;
  sessionId: string;
  locatorRef: string;
  /** @deprecated Historical config alias for the same renamed Codex Node. */
  astraNodeId?: string;
  core: CoreClientConfig;
  hytheId?: string;
  hostKind?: string;
}

/** Stateless provider hydrated from current D/Exp; stored exchanges are audit only. */
export class OpenAICompatibleHythe implements Hythe {
  effectProfile(operation:string) {return operation==="message.receive" ? providerAdmissionProfile(this.hostKind,"HTTP fetch invocation; provider stream continues independently") : undefined;}
  readonly hytheId: string;
  readonly hostKind: string;
  private readonly options: OpenAICompatibleHytheOptions;
  private readonly events: HostMessage[] = [];
  private readonly waiters: Array<(event: HostMessage) => void> = [];

  constructor(options: OpenAICompatibleHytheOptions) {
    this.options = options;
    this.hytheId = options.hytheId ?? `api:${options.provider.providerId}`;
    this.hostKind = options.hostKind ?? "generic-api";
    const url = new URL(options.provider.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" &&
        url.hostname !== "localhost")
      throw new Error("Provider base URL must use HTTPS outside loopback");
    if (!url.pathname.endsWith("/"))
      throw new Error("Provider base URL must end with /");
  }

  private credential(): string | undefined {
    return this.options.provider.credentialRef ?
      this.options.resolveCredential(this.options.provider.credentialRef) : undefined;
  }

  private ready(): boolean {
    return !this.options.provider.credentialRef || Boolean(this.credential());
  }

  private headers(): HeadersInit {
    const credential = this.credential();
    return { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      "Content-Type": "application/json" };
  }

  private endpoint(path: string): URL {
    const base = new URL(this.options.provider.baseUrl);
    const endpoint = new URL(path, base);
    if (endpoint.origin !== base.origin)
      throw new Error("Provider endpoint must stay on its configured origin");
    return endpoint;
  }

  manifest() { return hostManifest(this); }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }

  canStartTurn(): boolean { return this.ready(); }
  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }

  async control(locatorRef: string, operation: string): Promise<Record<string, unknown>> {
    if (operation !== "session.inspect" || !await this.locate(locatorRef))
      throw new SideraError("unavailable", "Provider Session is unavailable");
    const row = this.options.db.prepare(`SELECT messages_json, updated_at FROM api_session_history
      WHERE session_id = ?`).get(this.options.sessionId) as
      { messages_json: string; updated_at: string } | undefined;
    return { nodeId: this.options.nodeId, sessionId: this.options.sessionId,
      locatorRef, modelId: this.currentModel()?.modelId ?? null,
      storedMessages: row ? (JSON.parse(row.messages_json) as unknown[]).length : 0,
      updatedAt: row?.updated_at ?? null };
  }

  async locate(locatorRef: string): Promise<boolean> {
    if (!this.ready() || locatorRef !== this.options.locatorRef) return false;
    const row = this.options.db.prepare(`SELECT 1 FROM sessions WHERE session_id = ?
      AND node_id = ? AND hythe_id = ? AND host_kind = ? AND locator_ref = ?
      AND state = 'active'`).get(this.options.sessionId, this.options.nodeId,
        this.hytheId, this.hostKind, locatorRef);
    return Boolean(row);
  }

  /** Read-only credential/model check; no inference turn or Sidera binding is created. */
  async verifyProvider(): Promise<boolean> {
    if (!this.ready()) return false;
    const binding = this.currentModel();
    if (!binding || binding.provider !== this.options.provider.providerId) return false;
    if (this.options.provider.supportsModelsEndpoint === false) return true;
    const response = await (this.options.fetchImpl ?? fetch)(this.endpoint(
      this.options.provider.modelsEndpoint ?? "models"), {
      headers: this.headers(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return body.data?.some(model => model.id === binding?.modelId) ?? false;
  }

  /** A restart cannot prove whether an open provider request ran to completion. */
  recoverUnfinishedCalls(): void {
    this.options.db.prepare(`UPDATE api_calls SET state = 'uncertain',
      updated_at = ? WHERE session_id = ? AND state IN ('started','accepted')`)
      .run(new Date().toISOString(), this.options.sessionId);
  }

  async invoke(locatorRef: string, capability: string, input: unknown,
    _requestId: string, boundary?:EffectBoundary): Promise<InvokeResult> {
    if (capability !== "message.receive" || !await this.locate(locatorRef))
      return { status: "rejected", reason: "Exact provider Session is unavailable" };
    const message = input as Partial<Envelope> | null;
    if (!message || typeof message.messageId !== "string" ||
        typeof message.taskId !== "string" || typeof message.runId !== "string" ||
        typeof message.body !== "string" ||
        message.targetSessionId !== this.options.sessionId)
      return { status: "rejected", reason: "Provider turn envelope is incomplete" };
    const envelope = message as Envelope;
    const binding = this.currentModel();
    if (!binding || binding.provider !== this.options.provider.providerId)
      return { status: "rejected", reason: "ModelBinding is unavailable on this Host" };
    const effort = binding.reasoningConfig.effort;
    const reasoningEffort = effort === "low" ? "low" : effort === "max" ? "max" : "high";
    const thinking = effort === "none" ? { type: "disabled" } : { type: "enabled" };
    const history: ChatMessage[] = [];
    const context = envelope.wakeContext ?? wakeContext(this.options.db, this.options.nodeId);
    const prompt = renderWakeContext(context) + `Sidera message ${envelope.messageId}\nTask ${envelope.taskId}; Run ${envelope.runId}. ` +
      `If you delegate, call task_dispatch with this exact parentRunId and a checkpoint. ` +
      `After accepted delegation, end this turn. Sidera will start a continuation turn.\n` +
      envelope.body;
    // The canonical dependency proves this Run has already delegated once.
    // A continuation reports the child result; it cannot dispatch again.
    const isContinuation = Boolean(this.options.db.prepare(`SELECT 1 FROM task_dependencies
      WHERE continuation_run_id = ? AND state = 'resumed'`).get(envelope.runId));
    const userMessage: ChatMessage = { role: "user", content: prompt +
      (isContinuation ? "\nThe child result is available. Complete the parent task " +
        "using the observed result. Do not call tools in this continuation. " +
        "Answer fully and concisely; state uncertainty where evidence is missing." : "") };
    const configuredMaxTokens = binding.reasoningConfig.maxTokens;
    const maxTokens = configuredMaxTokens === undefined ?
      (effort === "none" ? DEFAULT_MAX_TOKENS : DEFAULT_THINKING_MAX_TOKENS) :
      configuredMaxTokens;
    if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1)
      return { status: "rejected", reason: "Invalid ModelBinding maxTokens configuration" };
    let reservation: ReturnType<OpenAICompatibleHythe["reserveCall"]>;
    try { reservation = this.reserveCall(envelope.messageId, binding.modelId, maxTokens); }
    catch {
      // A failed local transaction precedes all provider I/O.
      return { status: "rejected", reason: "Local provider call reservation failed" };
    }
    if (reservation.status !== "reserved")
      return { status: "uncertain", reason: "This Message already has a provider call record; reconcile without resending" };
    const callId = reservation.callId;
    let response: Response;
    try {
      if (!this.ready()) {
        this.markCall(callId, "rejected");
        return { status: "rejected", reason: "Provider credential is unavailable" };
      }
      response = await crossEffect(boundary,this.hostKind,locatorRef,"message.receive",()=>(this.options.fetchImpl ?? fetch)(this.endpoint(
        this.options.provider.chatCompletionsEndpoint ?? "chat/completions"), {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        body: JSON.stringify({ model: binding.modelId, stream: true,
          stream_options: { include_usage: true },
          ...(this.options.provider.compatibility?.thinking ? { thinking } : {}),
          ...(thinking.type === "enabled" && this.options.provider.compatibility?.reasoningEffort ?
            { reasoning_effort: reasoningEffort } : {}),
          max_tokens: maxTokens,
          messages: [{ role: "system", content: this.systemPrompt() },
            ...history, userMessage],
          tools: [this.dispatchTool()], tool_choice: isContinuation ? "none" : "auto" }),
        signal: AbortSignal.timeout(5 * 60_000),
      }));
    } catch {
      this.markCall(callId, "uncertain");
      return { status: "uncertain", reason: "Provider request acceptance is unknown" };
    }
    if (!response.ok) {
      this.markCall(callId, response.status >= 500 ? "uncertain" : "rejected");
      return response.status >= 500 ?
        { status: "uncertain", reason: `Provider returned ${response.status}` } :
        { status: "rejected", reason: `Provider returned ${response.status}` };
    }
    if (!response.body) {
      this.markCall(callId, "uncertain");
      return { status: "uncertain", reason: "Provider accepted without a result stream" };
    }
    const hostRef = `${this.options.provider.providerId}:${randomUUID()}`;
    this.markCall(callId, "accepted", hostRef);
    setImmediate(() => { void this.consume(response.body!, callId, hostRef, envelope,
      [...history, userMessage]).catch(() => {
        // Restart recovery preserves the call as uncertain if the DB closed mid-stream.
      }); });
    return { status: "accepted", hostRef };
  }

  async *receive(locatorRef: string): AsyncIterable<HostMessage> {
    if (!await this.locate(locatorRef))
      throw new SideraError("unavailable", "Provider Session is unavailable");
    for (;;) {
      const event = this.events.shift() ?? await new Promise<HostMessage>(resolve => {
        this.waiters.push(resolve);
      });
      yield event;
    }
  }

  private async consume(body: ReadableStream<Uint8Array>, callId: string, hostRef: string,
    envelope: Envelope, history: ChatMessage[]): Promise<void> {
    let stage = "stream";
    let finishReason: string | null = null;
    let outputChars = 0;
    let toolCount = 0;
    try {
      const result = await this.readStream(body);
      finishReason = result.finishReason;
      outputChars = result.content.length;
      toolCount = result.toolCalls.length;
      this.recordUsage(callId, result);
      if (result.finishReason === "tool_calls") {
        stage = "child_submit";
        if (result.toolCalls.length !== 1 ||
            result.toolCalls[0]?.function.name !== "task_dispatch")
          throw new Error("Unexpected provider tool call set");
        const tool = result.toolCalls[0];
        if (!tool.id || !tool.function.arguments)
          throw new Error("Provider tool call has no stable ID or arguments");
        const args = JSON.parse(tool.function.arguments) as Record<string, unknown>;
        if (typeof args.centerNodeId !== "string" || !args.centerNodeId.trim() ||
            typeof args.body !== "string" || !args.body.trim() ||
            typeof args.checkpoint !== "string" || !args.checkpoint.trim() ||
            args.parentRunId !== envelope.runId)
          throw new Error("Provider delegation arguments are invalid");
        const submitted = await callCore(this.options.core, "task.submit", {
          requestId: randomUUID(), centerNodeId: args.centerNodeId,
          body: args.body, parentRunId: envelope.runId, checkpoint: args.checkpoint,
        }) as { state?: string };
        if (submitted.state !== "waiting_dependency")
          throw new Error("Provider delegation was not accepted as a dependency");
        stage = "history_commit";
        this.saveHistory([...history,
          { role: "assistant", content: result.content || null, tool_calls: [tool],
            ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}) },
          { role: "tool", tool_call_id: tool.id,
            content: JSON.stringify({ state: "waiting_dependency" }) }]);
        this.markCall(callId, "completed", hostRef);
        this.emit({ hostRef, observedMessageId: envelope.messageId,
          body: "", outcome: "completed" });
        return;
      }
      stage = "final_result";
      if (result.finishReason !== "stop" || !result.content.trim())
        throw new Error("Provider turn did not finish with a result");
      stage = "history_commit";
      this.saveHistory([...history, { role: "assistant", content: result.content,
        ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}) }]);
      this.markCall(callId, "completed", hostRef);
      this.emit({ hostRef, observedMessageId: envelope.messageId,
        body: result.content, outcome: "completed" });
    } catch {
      // The API or Core may already have accepted an action. Do not retry it.
      try {
        this.options.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(
          randomUUID(), this.options.nodeId, "api.call.diagnostic",
          JSON.stringify({ callId, stage, finishReason, outputChars, toolCount }),
          new Date().toISOString());
      } catch { /* A closing DB may prevent diagnostics. */ }
      try { this.markCall(callId, "uncertain", hostRef); } catch {
        // A closing DB leaves the durable accepted row for restart recovery.
      }
      this.emit({ hostRef, observedMessageId: envelope.messageId,
        body: "", outcome: "failed" });
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<StreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    let finishReason: string | null = null;
    let done = false;
    let usage: StreamUsage | null = null;
    const calls = new Map<number, ToolCall>();
    const ingest = (line: string) => {
      if (!line.startsWith("data: ")) return;
      const value = line.slice(6);
      if (value.trimEnd() === "[DONE]") { done = true; return; }
      const chunk = JSON.parse(value) as { usage?: { prompt_tokens?: number;
        prompt_cache_hit_tokens?: number; completion_tokens?: number;
        total_tokens?: number } | null; choices?: Array<{ finish_reason?: string | null;
        delta?: { content?: string | null; reasoning_content?: string | null;
          tool_calls?: Array<{ index: number;
          id?: string; function?: { name?: string; arguments?: string } }> } }> };
      const reported = chunk.usage;
      if (reported && [reported.prompt_tokens, reported.completion_tokens,
          reported.total_tokens].every(value => Number.isSafeInteger(value) && value! >= 0))
        usage = { promptTokens: reported.prompt_tokens!,
          cachedPromptTokens: Number.isSafeInteger(reported.prompt_cache_hit_tokens) ?
            reported.prompt_cache_hit_tokens! : 0,
          completionTokens: reported.completion_tokens!, totalTokens: reported.total_tokens! };
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === "string") content += choice.delta.content;
      if (typeof choice?.delta?.reasoning_content === "string")
        reasoningContent += choice.delta.reasoning_content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      for (const delta of choice?.delta?.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { id: "", type: "function" as const,
          function: { name: "", arguments: "" } };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.function.name += delta.function.name;
        if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
        calls.set(delta.index, call);
      }
    };
    try {
      while (!done) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r\n", "\n");
        if (buffer.length > 2_000_000) throw new Error("Provider stream exceeded limit");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          ingest(line);
          newline = buffer.indexOf("\n");
        }
      }
    } finally { reader.releaseLock(); }
    if (!done) throw new Error("Provider result stream ended without DONE");
    return { content, reasoningContent, finishReason, usage,
      toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) };
  }

  private history(): ChatMessage[] {
    const row = this.options.db.prepare(`SELECT messages_json FROM api_session_history
      WHERE session_id = ?`).get(this.options.sessionId) as
      { messages_json: string } | undefined;
    return row ? JSON.parse(row.messages_json) as ChatMessage[] : [];
  }

  private currentModel(): { provider: string; modelId: string;
    reasoningConfig: Record<string, unknown> } | null {
    const row = this.options.db.prepare(`SELECT provider, model_id, reasoning_config
      FROM model_bindings WHERE node_id = ? AND valid_until IS NULL`)
      .get(this.options.nodeId) as { provider: string; model_id: string;
        reasoning_config: string } | undefined;
    return row ? { provider: row.provider, modelId: row.model_id,
      reasoningConfig: JSON.parse(row.reasoning_config) as Record<string, unknown> } : null;
  }

  private reserveCall(messageId: string, modelId: string, maxTokens: number):
    { status: "reserved"; callId: string } | { status: "prior" } {
    return withTransaction(this.options.db, "api_call_reserve", () => {
      const prior = this.options.db.prepare(`SELECT 1 FROM api_calls
        WHERE message_id = ?`).get(messageId);
      if (prior) return { status: "prior" };
      const callId = randomUUID();
      const at = new Date().toISOString();
      this.options.db.prepare(`INSERT INTO api_calls
        (call_id, session_id, message_id, provider_id, model_id, max_tokens, state,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)`)
        .run(callId, this.options.sessionId, messageId, this.options.provider.providerId, modelId,
          maxTokens, at, at);
      return { status: "reserved", callId };
    });
  }

  private markCall(callId: string, state: "accepted" | "completed" | "rejected" | "uncertain",
    hostRef?: string): void {
    this.options.db.prepare(`UPDATE api_calls
      SET state = ?, host_ref = COALESCE(?, host_ref), updated_at = ? WHERE call_id = ?`)
      .run(state, hostRef ?? null, new Date().toISOString(), callId);
  }

  private recordUsage(callId: string, result: StreamResult): void {
    const usage = result.usage;
    this.options.db.prepare(`UPDATE api_calls SET finish_reason = ?,
      prompt_tokens = ?, cached_prompt_tokens = ?, completion_tokens = ?,
      total_tokens = ?, updated_at = ? WHERE call_id = ?`).run(
        result.finishReason, usage?.promptTokens ?? null,
        usage?.cachedPromptTokens ?? null, usage?.completionTokens ?? null,
        usage?.totalTokens ?? null, new Date().toISOString(), callId);
    if (usage && (usage.totalTokens >= 250_000 || usage.completionTokens >= 32_000))
      this.options.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(
        randomUUID(), this.options.nodeId, "api.usage.high",
        JSON.stringify({ callId, providerId: this.options.provider.providerId,
          modelId: this.currentModel()?.modelId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens, totalTokens: usage.totalTokens }),
        new Date().toISOString());
  }

  private saveHistory(messages: ChatMessage[]): void {
    this.options.db.prepare(`INSERT INTO api_session_history
      (session_id, messages_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET messages_json = excluded.messages_json,
        updated_at = excluded.updated_at`).run(this.options.sessionId,
          JSON.stringify([...this.history(), ...messages]), new Date().toISOString());
  }

  private systemPrompt(): string {
    const name = this.options.db.prepare("SELECT display_name FROM nodes WHERE node_id = ?")
      .get(this.options.nodeId) as { display_name: string } | undefined;
    const peers = this.options.db.prepare("SELECT node_id,display_name FROM nodes WHERE lifecycle='active' AND node_id!=?").all(this.options.nodeId);
    return `You are ${name?.display_name ?? "an Agent"}, an independent Sidera Node. Your nodeId is ${this.options.nodeId}. ` +
      `Your model and Host are replaceable; your identity, memory and state follow the Node. ` +
      `Sidera Core alone decides authority, exact routing and completion. ` +
      `The task_dispatch tool accepts a child task only; end your turn after it succeeds and ` +
      `wait for a new continuation message. You may delegate only when the current task needs it. ` +
      `Give complete answers without needless length. ` +
      `Public peer identities: ${JSON.stringify(peers)}. Core Authority decides which ` +
      `targets you may delegate to. Sovereign Memory is current Description + Explanation in the wake context. ` +
      `Stored exchanges and world archives are evidence, not automatic Memory.`;
  }

  private dispatchTool(): Record<string, unknown> {
    return { type: "function", function: { name: "task_dispatch",
      description: "Delegate one child task through Sidera Core, then end this turn. Acceptance is not completion.",
      parameters: { type: "object", properties: {
        parentRunId: { type: "string" },
        centerNodeId: { type: "string" },
        body: { type: "string" }, checkpoint: { type: "string" },
      }, required: ["parentRunId", "centerNodeId", "body", "checkpoint"] } } };
  }

  private emit(event: HostMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }
}

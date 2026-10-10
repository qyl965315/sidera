import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChiefBinding } from "../core/chief.ts";
import { hostManifest } from "./manifest.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";
import { providerAdmissionProfile, crossEffect } from "./effect-control.ts";

/** Official desktop MCP bridge; only executor-provided context, never cookie/profile extraction. */
export class ChatGptNativeRoute {
  readonly id = "chatgpt:codex-app-tools";
  readonly routeClass = "native" as const;
  readonly requirement = "executor-provided context and native send tool";
  requirementSatisfied() { return Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH && this.callerThreadId &&
    (!this.client || this.tools.has("send_message_to_thread"))); }
  effectProfile(){return providerAdmissionProfile("chatgpt-web","Executor-authenticated send_message_to_thread admission");}
  readonly manifest = hostManifest({ hytheId: this.id, hostKind: "chatgpt-desktop" }, {
    operations: ["conversation.open", "conversation.locate", "conversation.read", "conversation.observe", "conversation.send"],
    routeClass: "native", createsSession: false,
  });
  private client?: Client;
  private tools = new Set<string>();
  private serverPath: string;
  private callerThreadId: string;
  constructor(serverPath: string, callerThreadId: string) { this.serverPath = serverPath; this.callerThreadId = callerThreadId; }
  async connect() {
    if (this.client) return;
    if (!process.env.CODEX_APP_TOOLS_PIPE_PATH || !this.callerThreadId)
      throw new Error("Native route unavailable: executor-provided Codex app context absent");
    const client = new Client({ name: "sidera-human-boundary", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [this.serverPath],
        env: Object.fromEntries(Object.entries(process.env).filter((x): x is [string,string] => x[1] !== undefined)), stderr: "ignore" }));
      this.tools = new Set((await client.listTools()).tools.map(t => t.name));
      this.client = client;
    } catch (error) { await client.close(); throw error; }
  }
  async close() { await this.client?.close(); this.client = undefined; }
  private async call(name: string, args: Record<string, unknown>,boundary?:EffectBoundary,locator?:string) {
    await this.connect();
    if (!this.tools.has(name)) throw new Error(`Native tool not exposed: ${name}`);
    const send=()=>this.client!.callTool({ name, arguments: args,
      _meta: { "openai/threadId": this.callerThreadId } }, undefined, { timeout: 30_000 });
    const result = await (name==="send_message_to_thread" ? crossEffect(boundary,"chatgpt-web",locator!,"conversation.send",send) : send());
    const text = (result.content as {type:string;text?:string}[]).filter(c => c.type === "text").map(c => c.text).join("\n");
    if (result.isError) throw new Error(text);
    try { return JSON.parse(text) as Record<string,unknown>; } catch { throw new Error("Native tool returned non-JSON evidence"); }
  }
  async invoke(operation: string, binding: ChiefBinding, input: Record<string,unknown> = {},boundary?:EffectBoundary): Promise<Record<string,unknown>> {
    const match = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9-]+)$/.exec(binding.conversationRef);
    if (!match) return { status: "rejected", beforeEffect: true, reason: "Exact existing Conversation required" };
    const threadId = match[1]!;
    if (["conversation.locate","conversation.read","conversation.observe"].includes(operation)) {
      const data = await this.call("read_thread", { threadId, turnLimit: operation==="conversation.locate"?1:3, includeOutputs: false, maxOutputCharsPerItem: operation==="conversation.locate"?100:16000 });
      // Host response identity is checked, not inferred from a successful socket.
      const thread = data.thread as { id?:string; kind?:string } | undefined;
      if (thread?.id !== threadId || thread.kind !== "chatgpt") throw new Error("Native read returned another conversation or Host kind");
      return { status: "host_confirmed", data:operation==="conversation.locate"?{located:true,conversationRef:binding.conversationRef}:data };
    }
    if (operation === "conversation.send") {
      if(!boundary)return {status:"rejected",beforeEffect:true,reason:"Final Core Effect boundary required"};
      // Probe tool/context before the write. Errors after call start are uncertain.
      try { await this.connect(); } catch (error) { return { status: "rejected", beforeEffect: true, reason: String(error) }; }
      if (!this.tools.has("send_message_to_thread")) return { status: "rejected", beforeEffect: true, reason: "Native send tool absent" };
      const data = await this.call("send_message_to_thread", { threadId, prompt: String(input.body) },boundary,binding.conversationRef);
      return { status: "accepted", hostRef: String(data.turnId ?? data.threadId ?? threadId), data };
    }
    if (operation === "conversation.open") return { status: "accepted", data: await this.call("navigate_to_codex_page", { threadId }) };
    return { status: "rejected", beforeEffect: true, reason: "Runtime cannot create or replace a Human Chat" };
  }
}

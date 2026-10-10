import type { HostMessage, InvokeResult } from "./types.ts";

export type GptOperation = "locate" | "create" | "open" | "sendNewTurn" |
  "observe" | "receiveResult" | "interrupt" | "resume" | "status" | "inspect";
export interface GptDiscovery {
  backend: string;
  availability: "available" | "unavailable";
  operations: Record<GptOperation, boolean>;
  reason: string;
}

/** Capability contract; a frontend connection alone never implements sendNewTurn. */
export interface GptBackend {
  discover(): GptDiscovery;
  locate(locator: string): Promise<boolean>;
  inspect(locator: string): Promise<Record<string, unknown>>;
  sendNewTurn?(locator: string, envelope: unknown, requestId: string): Promise<InvokeResult>;
  receiveResult?(locator: string): AsyncIterable<HostMessage>;
  interrupt?(locator: string, hostRef: string): Promise<InvokeResult>;
  control?(locator: string, operation: string,
    input: Record<string, unknown>): Promise<Record<string, unknown>>;
  provideResult?(runId: string, messageId: string, body: string): Promise<void>;
  returnResult?(locator: string, envelope: unknown): Promise<InvokeResult>;
}

export class ChatGptMcpFrontend implements GptBackend {
  private locator: string;
  private channel: () => boolean;
  constructor(locator: string, channel: () => boolean) { this.locator = locator; this.channel = channel; }
  discover(): GptDiscovery {
    return { backend: "chatgpt-mcp-frontend", availability: "available",
      operations: { locate: true, create: false, open: false, sendNewTurn: false,
        observe: false, receiveResult: false, interrupt: false, resume: false,
        status: false, inspect: true },
      reason: "ChatGPT initiates MCP calls. This frontend cannot wake ChatGPT or start a turn." };
  }
  async locate(locator: string): Promise<boolean> { return locator === this.locator; }
  async inspect(locator: string): Promise<Record<string, unknown>> {
    return { ...this.discover(), locatorMatches: await this.locate(locator), liveReturnChannel: this.channel() };
  }
  async returnResult(locator: string, input: unknown): Promise<InvokeResult> {
    const message = input as { messageId?: string; kind?: string };
    if (locator !== this.locator || !message?.messageId || message.kind !== "result")
      return { status: "rejected", reason: "MCP frontend cannot start a GPT turn" };
    if (!this.channel()) return { status: "uncertain", reason: "No live GPT tool return channel; result is durable but not delivered" };
    return { status: "accepted", hostRef: `gpt-tool:${message.messageId}` };
  }
}

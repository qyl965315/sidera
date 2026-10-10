import { hostManifest, controlsFromManifest } from "./manifest.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";
import { ChatGptMcpFrontend, type GptBackend } from "./gpt-backend.ts";

/** One control contract, with backend-specific capability discovery. */
export class GptHythe implements Hythe {
  readonly hytheId: string;
  readonly hostKind: string;
  readonly backend: GptBackend;
  constructor(backend: GptBackend, hytheId = "gpt", hostKind = "gpt-mcp-tool") {
    this.backend = backend; this.hytheId = hytheId; this.hostKind = hostKind;
  }
  capabilities(): readonly string[] { return this.manifest().transportCapabilities; }
  manifest() {
    const operations = this.backend.discover().operations;
    const exposed = ["session.inspect"];
    if (operations.create) exposed.push("conversation.create");
    if (operations.open) exposed.push("conversation.open");
    if (operations.sendNewTurn) exposed.push("conversation.send");
    if (operations.observe) exposed.push("conversation.observe");
    if (operations.interrupt) exposed.push("conversation.interrupt");
    if (operations.resume) exposed.push("conversation.resume");
    if (operations.status) exposed.push("conversation.status");
    return hostManifest(this,{operations:exposed,createsSession:false,routeClass:"ui-fallback"});
  }
  controls(): readonly string[] { return controlsFromManifest(this.manifest()); }
  canStartTurn(): boolean {
    return this.backend.discover().operations.sendNewTurn && Boolean(this.backend.sendNewTurn);
  }
  async control(locator: string, operation: string,
    input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (operation === "session.inspect") return this.backend.inspect(locator);
    if (!this.controls().includes(operation) || !this.backend.control)
      throw new Error("unavailable: GPT operation is not implemented");
    return this.backend.control(locator, operation, input);
  }
  async locate(locator: string): Promise<boolean> { return this.backend.locate(locator); }
  async invoke(locator: string, capability: string, input: unknown, requestId: string): Promise<InvokeResult> {
    if (capability !== "message.receive" || !await this.locate(locator))
      return { status: "rejected", reason: "GPT Session or capability is unavailable" };
    if (this.backend.discover().operations.sendNewTurn && this.backend.sendNewTurn)
      return this.backend.sendNewTurn(locator, input, requestId);
    if (this.backend.returnResult) return this.backend.returnResult(locator, input);
    return { status: "rejected", reason: "GPT sendNewTurn backend is unavailable" };
  }
  async *receive(locator: string): AsyncIterable<HostMessage> {
    if (this.backend.receiveResult) yield* this.backend.receiveResult(locator);
  }
  async acceptResult(runId: string, messageId: string, body: string): Promise<void> {
    if (!this.backend.provideResult) throw new Error("GPT result callback is unavailable");
    await this.backend.provideResult(runId, messageId, body);
  }
}

/** Compatibility name for existing configuration; this is an ingress frontend. */
export class GptReturnHythe extends GptHythe {
  constructor(locator: string, hasChannel: () => boolean) {
    super(new ChatGptMcpFrontend(locator, hasChannel));
  }
}

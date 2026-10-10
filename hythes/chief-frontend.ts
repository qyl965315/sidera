import type { ChiefBinding, ChiefFrontend } from "../core/chief.ts";
import type { GptUiBackend } from "./gpt-ui.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";

/** Presentation only: an exact existing Human Chat, separate from the Chief Runtime Session. */
export class ChiefChatGptFrontend implements ChiefFrontend {
  private ui?: GptUiBackend;
  private ingressStatus: () => Record<string, unknown>;
  constructor(ui?: GptUiBackend, ingressStatus: () => Record<string, unknown> = () =>
    ({ state: "unverified", chatgptDispatchVerified: false })) { this.ui = ui; this.ingressStatus = ingressStatus; }
  ingress() { return this.ingressStatus(); }
  async close() { await this.ui?.close(); }
  async inspect(binding: ChiefBinding) {
    if (!this.ui || binding.frontendKind !== "chatgpt-web")
      return { ready: false, reason: "Chief frontend backend is unavailable" };
    if (this.ui.discover().availability !== "available")
      return { ready: false, reason: this.ui.discover().reason };
    const matches = await this.ui.locate(binding.conversationRef);
    return { ready: matches, reason: matches ? "Exact existing Chief Conversation located; no new Chat" : "Chief Conversation/login unavailable" };
  }
  async deliver(binding: ChiefBinding, message: { messageId: string; body: string },boundary?:EffectBoundary) {
    if (!this.ui) return { status: "rejected" as const, reason: "Chief frontend backend unavailable" };
    return this.ui.sendNewTurn(binding.conversationRef, {
      ...message, kind: "result", body: `SIDERA_CHIEF_RESULT\n${message.body}\n\n` +
        "这是 Sidera 返回本主 Conversation 的真实结果。请在这里报告，不调用其他工具，不要求 Human 搬运，不新建 Feedback/Report/Chat。",
    }, `chief-present:${message.messageId}`,boundary);
  }
}

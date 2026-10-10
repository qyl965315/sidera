import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OpenAICompatibleHythe } from "../hythes/openai-compatible.ts";

test("DeepSeek streaming completion retains provider token usage", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const hythe = new OpenAICompatibleHythe({ db, hostKind:"generic-api", provider:{providerId:"deepseek",baseUrl:"https://api.deepseek.com/",credentialRef:"test:deepseek",compatibility:{thinking:true,reasoningEffort:true,promptCacheHitTokens:true}},
      resolveCredential: ref => ref === "test:deepseek" ? "unused" : undefined,
      nodeId: "ds", sessionId: "session", locatorRef: "locator", astraNodeId: "astra",
      core: { port: 0, token: "unused" } });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":120,"prompt_cache_hit_tokens":20,' +
        '"completion_tokens":40,"total_tokens":160}}\n\n' +
        'data: [DONE]\n\n'));
      controller.close();
    } });
    const result = await (hythe as unknown as { readStream(body: ReadableStream<Uint8Array>):
      Promise<{ content: string; finishReason: string | null; usage: unknown }> }).readStream(stream);
    assert.equal(result.content, "Done");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { promptTokens: 120, cachedPromptTokens: 20,
      completionTokens: 40, totalTokens: 160 });
  } finally { db.close(); }
});

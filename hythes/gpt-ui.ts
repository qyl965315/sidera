import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { PeregrineRecord } from "../peregrine/local.ts";
import type { GptBackend, GptDiscovery } from "./gpt-backend.ts";
import type { HostMessage, InvokeResult } from "./types.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";
import { crossEffect } from "./effect-control.ts";

type UiState = "starting" | "ready" | "login_required" | "human_verification_required" | "conversation_unavailable" | "composer_unavailable" | "navigation_failed" | "unavailable";
type Envelope = { messageId: string; runId?: string; kind: string; body: string };
type Pending = { hostRef: string; locatorRef: string; messageId: string; runId?: string;
  kind: string; callback?: string; callbackAt?: number; wake?: () => void };

export interface GptUiOptions {
  domain: PeregrineRecord;
  executablePath: string;
  locatorRef: string;
  headless: boolean;
  /** Used only by a local DOM fixture test; production stays on chatgpt.com. */
  origin?: string;
  readinessTimeoutMs?:number;
}

/** Dedicated Chromium profile in a Peregrine domain. It never reads assistant text. */
export class GptUiBackend implements GptBackend {
  private readonly options: GptUiOptions;
  private readonly origin: string;
  private readonly profilePath: string;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: UiState = "starting";
  private readonly pending = new Map<string, Pending>();
  private readonly events: HostMessage[] = [];
  private readonly waiters: Array<(event: HostMessage) => void> = [];

  constructor(options: GptUiOptions) {
    this.options = options;
    this.origin = new URL(options.origin ?? "https://chatgpt.com").origin;
    this.profilePath = join(options.domain.homeRef, "chatgpt-browser-manual");
    for (const path of [this.profilePath, options.domain.workspaceRef,
      options.domain.tempRef, join(options.domain.homeRef, "AppData", "Roaming"),
      join(options.domain.homeRef, "AppData", "Local")]) mkdirSync(path, { recursive: true });
  }

  private exactUrl(locator: string): string {
    const url = new URL(locator);
    if (url.origin !== this.origin || !/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname))
      throw new Error("ChatGPT locator is not an exact conversation URL");
    return url.origin + url.pathname;
  }

  private async browserPage(): Promise<Page> {
    if (!this.context) {
      const home = this.options.domain.homeRef;
      const temp = this.options.domain.tempRef;
      this.context = await chromium.launchPersistentContext(this.profilePath, {
        executablePath: this.options.executablePath,
        headless: this.options.headless,
        chromiumSandbox: true,
        args: this.options.headless ? [] : ["--window-position=-32000,-32000",
          "--window-size=1280,900"],
        acceptDownloads: false,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
          HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
          APPDATA: join(home, "AppData", "Roaming"),
          LOCALAPPDATA: join(home, "AppData", "Local") },
      });
      this.context.once("close", () => { this.context = null; this.page = null;
        this.state = "unavailable"; });
      this.page = this.context.pages()[0] ?? await this.context.newPage();
    }
    return this.page!;
  }

  private composer(page: Page) {
    return page.locator('#prompt-textarea,[data-testid="composer"] [contenteditable="true"],'+
      '[role="textbox"][contenteditable="true"]').first();
  }

  private userMessages(page: Page) {
    return page.locator('[data-message-author-role="user"],'+
      '[data-chatgpt-search-unit-key$=":user"]');
  }

  private assistantMessages(page: Page) {
    return page.locator('[data-message-author-role="assistant"],'+
      '[data-chatgpt-search-unit-key$=":assistant"]');
  }

  private sendButton(page: Page) {
    return page.locator('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="发送"]').first();
  }

  private stopButton(page: Page) {
    return page.locator('button[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="停止生成"]').first();
  }

  private async readyAt(page: Page, locator: string): Promise<boolean> {
    const expected = this.exactUrl(locator);
    if (page.url().split("?")[0] === expected && await this.composer(page).isVisible()) {
      this.state = "ready";
      return true;
    }
    try {await page.goto(expected, { waitUntil: "domcontentloaded", timeout: 30_000 });}
    catch {this.state="navigation_failed";return false;}
    if (page.url().split("?")[0] !== expected) {
      this.state = await this.failureState(page,expected);
      return false;
    }
    try {
      await this.composer(page).waitFor({ state: "visible", timeout: this.options.readinessTimeoutMs??20_000 });
      this.state = "ready";
      return true;
    } catch {
      this.state = await this.failureState(page,expected);
      return false;
    }
  }

  private async failureState(page:Page,expected:string):Promise<UiState> {
    const url=new URL(page.url());
    const challenge=await page.locator('iframe[src*="challenges.cloudflare.com"],iframe[src*="turnstile"],#challenge-form').count()>0 ||
      /just a moment|请稍候|验证您是真人/i.test(await page.title());
    if(challenge)return "human_verification_required";
    if(/\/(auth|login|signin)(\/|$)/i.test(url.pathname) || /^auth\./.test(url.hostname) ||
      await page.locator('a[href*="/auth/login"],button[data-testid="login-button"]').first().isVisible())return "login_required";
    if(page.url().split("?")[0]!==expected)return "conversation_unavailable";
    return "composer_unavailable";
  }

  async initialize(): Promise<void> {
    try { await this.readyAt(await this.browserPage(), this.options.locatorRef); }
    catch { this.state = "unavailable"; }
    if (this.state !== "ready" && this.context) {
      const state = this.state;
      const context = this.context;
      this.context = null; this.page = null;
      await context.close();
      this.state = state;
    }
  }

  discover(): GptDiscovery {
    const ready = this.state === "ready";
    return { backend: "isolated-chatgpt-ui", availability: ready ? "available" : "unavailable",
      operations: { locate: ready, create: false, open: ready,
        sendNewTurn: ready, observe: ready, receiveResult: ready,
        interrupt: ready, resume: false, status: true, inspect: true },
      reason: ready ? "Dedicated Peregrine browser profile is ready" : this.state };
  }

  async locate(locator: string): Promise<boolean> {
    if (locator !== this.options.locatorRef) return false;
    if (this.pending.size) return this.page?.url().split("?")[0] === locator;
    return this.readyAt(await this.browserPage(), locator);
  }

  async inspect(locator: string): Promise<Record<string, unknown>> {
    return { ...this.discover(), locatorMatches: locator === this.options.locatorRef,
      profileRef: this.profilePath, pendingTurns: this.pending.size,
      generating: this.page ? await this.stopButton(this.page).isVisible() : false };
  }

  private prompt(envelope: Envelope): string {
    if (envelope.kind === "control")
      return `${envelope.body}\n\nSidera control metadata: messageId=${envelope.messageId}.`;
    if (envelope.kind !== "task" || !envelope.runId)
      return `${envelope.body}\n\nSidera message metadata: messageId=${envelope.messageId}.`;
    return `${envelope.body}\n\nSidera task metadata: runId=${envelope.runId}; messageId=${envelope.messageId}. ` +
      "When your work is complete, call the Sidera task_result tool with these exact IDs and your result. " +
      "Then finish this ChatGPT turn. Do not ask the Human to relay your answer.";
  }

  private async compose(page: Page, body: string, selectTools = true): Promise<void> {
    const composer = this.composer(page);
    if (this.origin !== "https://chatgpt.com" || !selectTools) {
      await composer.fill(body);
      return;
    }
    // ChatGPT exposes installed app tools to a turn through a real mention
    // chip. Plain text naming the app does not select it.
    await composer.fill("@");
    const app = page.getByRole("button", { name: /Sidera R1/ }).last();
    await app.waitFor({ state: "visible", timeout: 5_000 });
    await app.click();
    await composer.locator('[app-mention-name="sidera-r1"]').waitFor({ state: "attached" });
    await composer.press("End");
    await page.keyboard.insertText(body);
  }

  async sendNewTurn(locator: string, input: unknown, _requestId: string,boundary?:EffectBoundary): Promise<InvokeResult> {
    const envelope = input as Envelope;
    if (!envelope?.messageId || typeof envelope.body !== "string" ||
        !envelope.body.trim() || !envelope.kind)
      return { status: "rejected", reason: "Sidera message envelope is incomplete" };
    if (envelope.kind === "task" && !envelope.runId)
      return { status: "rejected", reason: "Managed GPT task has no Run ID" };
    if(envelope.kind==="result" && !boundary)return {status:"rejected",reason:"Final Core Effect boundary required"};
    if (this.pending.size) return { status: "rejected", reason: "GPT Session is busy" };
    let page: Page;
    try {
      page = await this.browserPage();
      if (!await this.readyAt(page, locator))
        return { status: "rejected", reason: "Isolated ChatGPT login or conversation is unavailable" };
      if (await this.stopButton(page).isVisible())
        return { status: "rejected", reason: "GPT Session is generating" };
      await this.compose(page, this.prompt(envelope), envelope.kind !== "result");
      await this.sendButton(page).waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      return { status: "rejected", reason: "ChatGPT composer preflight failed" };
    }
    const beforeUser = await this.userMessages(page).count();
    const beforeAssistant = await this.assistantMessages(page).count();
    await page.evaluate(() => {
      const answers = document.querySelectorAll('[data-message-author-role="assistant"],'+
        '[data-chatgpt-search-unit-key$=":assistant"]');
      const last = answers[answers.length - 1] as HTMLElement & {
        __sidera?: { changedAt: number; observer: MutationObserver };
      } | undefined;
      if (!last) return;
      if (!last.__sidera) {
        const state = { changedAt: 0, observer: null as unknown as MutationObserver };
        state.observer = new MutationObserver(() => { state.changedAt = Date.now(); });
        state.observer.observe(last, { subtree: true, childList: true, characterData: true });
        last.__sidera = state;
      } else last.__sidera.changedAt = 0;
    });
    const hostRef = `gpt-ui:${randomUUID()}`;
    const pending: Pending = { hostRef, locatorRef: this.exactUrl(locator),
      messageId: envelope.messageId,
      runId: envelope.runId, kind: envelope.kind };
    this.pending.set(hostRef, pending);
    let initiated=false;
    try {
      const click=()=>{initiated=true;return this.sendButton(page).click({ timeout: 5_000 });};
      await (envelope.kind==="result" ? crossEffect(boundary,"chatgpt-web",this.exactUrl(locator),"conversation.send",click) : click());
      await page.waitForFunction(({ before, messageId }) => {
        const users = [...document.querySelectorAll('[data-message-author-role="user"],'+
          '[data-chatgpt-search-unit-key$=":user"]')];
        return users.length > before || users.some(user =>
          user.textContent?.includes(`messageId=${messageId}`));
      }, { before: beforeUser, messageId: envelope.messageId },
      { timeout: 15_000 });
      void this.monitor(page, pending, beforeAssistant);
      return { status: "accepted", hostRef };
    } catch {
      // A click may have reached the Host. Leave the original ID unresolved.
      this.pending.delete(hostRef);
      if(!initiated)return {status:"rejected",reason:"Final Core Effect boundary rejected before send"};
      return { status: "uncertain", reason: "ChatGPT send outcome is unconfirmed; do not resend" };
    }
  }

  private async monitor(page: Page, turn: Pending, assistantBefore: number): Promise<void> {
    try {
      // ChatGPT can recycle message elements while a tool turn is running, so
      // assistant element count is not a reliable completion signal by itself.
      const deadline = Date.now() + 10 * 60_000;
      let idleSince = 0;
      for (;;) {
        if (Date.now() >= deadline) throw new Error("GPT turn completion timed out");
        const view = await page.evaluate(() => {
          const answers = document.querySelectorAll('[data-message-author-role="assistant"],'+
            '[data-chatgpt-search-unit-key$=":assistant"]');
          const last = answers[answers.length - 1] as HTMLElement & {
            __sidera?: { changedAt: number; observer: MutationObserver };
          } | undefined;
          if (last && !last.__sidera) {
            const state = { changedAt: Date.now(), observer: null as unknown as MutationObserver };
            state.observer = new MutationObserver(() => { state.changedAt = Date.now(); });
            state.observer.observe(last, { subtree: true, childList: true, characterData: true });
            last.__sidera = state;
          }
          const stop = document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="停止生成"]');
          const composer = document.querySelector('#prompt-textarea,[data-testid="composer"] [contenteditable="true"],'+
            '[role="textbox"][contenteditable="true"]');
          return { assistantCount: answers.length, changedAt: last?.__sidera?.changedAt ?? 0,
            idle: !stop && !!composer };
        });
        const now = Date.now();
        const evidence = view.assistantCount > assistantBefore || view.changedAt > 0 || !!turn.callback;
        if (evidence && view.idle && now - view.changedAt >= 1_200 &&
            now - (turn.callbackAt ?? 0) >= 1_200) {
          if (!idleSince) idleSince = now;
          if (now - idleSince >= 1_500) break;
        } else idleSince = 0;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (page.url().split("?")[0] !== turn.locatorRef)
        throw new Error("GPT conversation changed before turn completion");
      if (turn.kind === "task" && !turn.callback) {
        await Promise.race([
          new Promise<void>(resolve => { turn.wake = resolve; }),
          new Promise<void>(resolve => setTimeout(resolve, 10_000)),
        ]);
      }
      if (turn.kind !== "control") this.emit({ hostRef: turn.hostRef,
        observedMessageId: turn.messageId, body: turn.callback ?? "",
        outcome: turn.kind === "task" && !turn.callback ? "failed" : "completed" });
    } catch {
      if (turn.kind !== "control") this.emit({ hostRef: turn.hostRef,
        observedMessageId: turn.messageId, body: "", outcome: "failed" });
    } finally {
      this.pending.delete(turn.hostRef);
    }
  }

  async provideResult(runId: string, messageId: string, body: string): Promise<void> {
    const turn = [...this.pending.values()].find(item => item.runId === runId &&
      item.messageId === messageId && item.kind === "task");
    if (!turn || !body.trim()) throw new Error("GPT result does not match an active Run");
    if (turn.callback && turn.callback !== body) throw new Error("GPT Run already has another result");
    turn.callback = body;
    turn.callbackAt = Date.now();
    turn.wake?.();
  }

  async *receiveResult(locator: string): AsyncIterable<HostMessage> {
    if (locator !== this.options.locatorRef) return;
    for (;;) {
      const event = this.events.shift() ?? await new Promise<HostMessage>(resolve => this.waiters.push(resolve));
      yield event;
    }
  }

  private emit(event: HostMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }

  async interrupt(locator: string, _hostRef: string): Promise<InvokeResult> {
    if (locator !== this.options.locatorRef || !this.page)
      return { status: "rejected", reason: "GPT Session is unavailable" };
    if (!await this.stopButton(this.page).isVisible())
      return { status: "rejected", reason: "No active generation to interrupt" };
    try {
      await this.stopButton(this.page).click();
      return { status: "accepted", hostRef: `gpt-ui-interrupt:${randomUUID()}` };
    } catch {
      return { status: "uncertain", reason: "Interrupt outcome is unconfirmed" };
    }
  }

  async control(locator: string, operation: string,
    input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (operation === "conversation.status" || operation === "conversation.observe") {
      const messageId = typeof input.messageId === "string" ? input.messageId : null;
      const userTextFragment = typeof input.userTextFragment === "string" ? input.userTextFragment : null;
      const userMessagePresent = messageId && this.page ?
        await this.userMessages(this.page).filter({ hasText: `messageId=${messageId}` }).count() > 0 : null;
      const userTextPresent = userTextFragment && this.page ?
        await this.userMessages(this.page).filter({ hasText: userTextFragment }).count() > 0 : null;
      return { ...await this.inspect(locator), currentUrl: this.page?.url() ?? null,
        userMessagePresent, userTextPresent };
    }
    if (operation === "conversation.open") {
      if (!await this.locate(locator)) throw new Error("Exact GPT conversation is unavailable");
      return { opened: true, locatorRef: locator };
    }
    if (operation === "conversation.interrupt") {
      const result = await this.interrupt(locator, String(input.hostRef ?? ""));
      if (result.status !== "accepted") throw new Error(result.reason);
      return result;
    }
    if (operation === "conversation.send") {
      const result = await this.sendNewTurn(locator, {
        messageId: String(input.messageId ?? randomUUID()), kind: "control",
        body: String(input.body ?? ""),
      }, String(input.requestId ?? randomUUID()));
      if (result.status !== "accepted") throw new Error(result.reason);
      return result;
    }
    if (operation === "conversation.create") {
      throw new Error("Human must create new frontend Conversations; Runtime cannot create Feedback/Report Chats");
    }
    throw new Error("GPT UI operation is unavailable");
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close();
    this.state = "unavailable";
  }
}

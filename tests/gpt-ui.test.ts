import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { Continuations } from "./fixtures/execution.ts";
import { acceptGptResult } from "../core/gpt-result.ts";
import { getMessage } from "./fixtures/bus.ts";
import { GptUiBackend } from "../hythes/gpt-ui.ts";
import type { Hythe } from "../hythes/types.ts";

test("UI distinguishes DOM, exact-conversation, login and human-challenge failures",async()=>{
 let mode="composer";const server=createServer((req,res)=>{
  if(mode==="conversation" && req.url!=="/c/other"){res.writeHead(302,{location:"/c/other"});res.end();return;}
  res.setHeader("content-type","text/html");res.end(mode==="challenge"?'<title>Just a moment...</title><form id="challenge-form"></form>':
   mode==="login"?'<button data-testid="login-button">Log in</button>':'<title>Conversation</title><div>Host page without composer</div>');
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
 const origin=`http://127.0.0.1:${address.port}`;const root=mkdtempSync(join(tmpdir(),"sidera-ui-state-"));
 try{for(const [state,reason] of [["composer","composer_unavailable"],["conversation","conversation_unavailable"],["login","login_required"],["challenge","human_verification_required"]]){
  mode=state!;const ui=new GptUiBackend({domain:{peregrineId:state!,ownerNodeId:"fixture",backend:"local",state:"ready",workspaceRef:join(root,state!,"workspace"),homeRef:join(root,state!,"home"),tempRef:join(root,state!,"temp")},origin,locatorRef:`${origin}/c/exact`,headless:true,executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",readinessTimeoutMs:100});
  try{await ui.initialize();assert.equal(ui.discover().reason,reason);assert.equal(ui.discover().availability,"unavailable");}finally{await ui.close();}
 }}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("isolated browser uses exact conversation, UI completion, and MCP callback body", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><div id="messages"><div data-chatgpt-search-unit-key="prior:0:user">old</div>
      <div data-chatgpt-search-unit-key="prior:2:assistant">old answer</div></div>
      <div role="textbox" aria-label="询问 ChatGPT" contenteditable="true"></div>
      <button aria-label="发送">Send</button>
      <script>
      document.querySelector('button').onclick = () => {
        const user = document.createElement('div');
        user.dataset.chatgptSearchUnitKey = 'fixture-turn-1:0:user';
        user.textContent = document.querySelector('[role="textbox"]').textContent;
        document.querySelector('[data-chatgpt-search-unit-key$=":user"]').remove();
        document.querySelector('#messages').append(user);
        const stop = document.createElement('button');
        stop.dataset.testid = 'stop-button'; document.body.append(stop);
        const answer = document.createElement('div');
        answer.dataset.chatgptSearchUnitKey = 'fixture-turn-1:2:assistant';
        answer.textContent = 'THIS IS NOT THE CALLBACK BODY';
        document.querySelector('[data-chatgpt-search-unit-key$=":assistant"]').remove();
        document.querySelector('#messages').append(answer);
        setTimeout(() => stop.remove(), 100);
      };
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const root = mkdtempSync(join(tmpdir(), "sidera-gpt-ui-"));
  for (const name of ["workspace", "home", "temp"]) mkdirSync(join(root, name));
  const locator = `${origin}/c/exact-1`;
  const ui = new GptUiBackend({
    domain: { peregrineId: "fixture", ownerNodeId: "sol", backend: "local",
      state: "ready", workspaceRef: join(root, "workspace"), homeRef: join(root, "home"),
      tempRef: join(root, "temp") },
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true, origin, locatorRef: locator,
  });
  try {
    await ui.initialize();
    assert.equal(ui.discover().operations.sendNewTurn, true);
    assert.equal(ui.discover().operations.create, false);
    await assert.rejects(ui.control(locator, "conversation.create", { initialBody: "Report" }), /Human must create/);
    assert.equal(await ui.locate(`${origin}/c/other`), false);
    const delivery = await ui.sendNewTurn(locator,
      { messageId: "message-1", runId: "run-1", kind: "task", body: "Do work" }, "request-1");
    assert.equal(delivery.status, "accepted");
    const status = await ui.control(locator, "conversation.status", { messageId: "message-1" });
    assert.equal(status.userMessagePresent, true);
    await assert.rejects(ui.provideResult("wrong-run", "message-1", "wrong"));
    await ui.provideResult("run-1", "message-1", "MCP CALLBACK BODY");
    const received = ui.receiveResult(locator)[Symbol.asyncIterator]();
    const event = await Promise.race([received.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("UI completion timeout")), 8_000))]);
    assert.equal(event.value?.body, "MCP CALLBACK BODY");
    assert.equal(event.value?.outcome, "completed");
    assert.equal(event.value?.observedMessageId, "message-1");
    const resultDelivery = await ui.sendNewTurn(locator,
      { messageId: "result-1", kind: "result", body: "Final result for origin" }, "request-result",{cross:(target,send)=>{
        assert.equal(target.locator,locator);assert.equal(target.operation,"conversation.send");return send();
      }});
    assert.equal(resultDelivery.status, "accepted");
    const resultEvent = await Promise.race([received.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Result UI timeout")), 8_000))]);
    assert.equal(resultEvent.value?.observedMessageId, "result-1");
    assert.equal(resultEvent.value?.outcome, "completed");
    assert.equal(resultEvent.value?.body, "");
    const control = await ui.sendNewTurn(locator,
      { messageId: "control-1", kind: "control", body: "Open control path" }, "request-2");
    assert.equal(control.status, "accepted");
    const controlStatus = await ui.control(locator, "conversation.status", { messageId: "control-1" });
    assert.equal(controlStatus.userMessagePresent, true);
    const fragmentStatus = await ui.control(locator, "conversation.status",
      { userTextFragment: "Open control path" });
    assert.equal(fragmentStatus.userTextPresent, true);
  } finally {
    await ui.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("GPT result callback is exact, durable, idempotent, and not Agent completion", async () => {
  const db = openDatabase(":memory:");
  for (const id of ["sol", "astra"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', 'now')").run(id, id);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, 'active', 'now')")
      .run(`${id}-session`, id, id === "sol" ? "gpt-web" : "codex",
        id === "sol" ? "chatgpt-web" : "codex-app-server", `${id}-locator`);
  }
  issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "astra", capability: "task.dispatch", resourceScope: "node/sol",
  });
  issueGrant(db, { kind: "human", id: "owner" }, {
    subjectNodeId: "sol", capability: "message.send", resourceScope: "node/astra",
  });
  let callbacks = 0;
  const fake: Hythe = { hytheId: "gpt-web", hostKind: "chatgpt-web",
    capabilities: () => ["message.receive"], locate: async () => true,
    invoke: async () => ({ status: "accepted", hostRef: "exact-gpt-turn" }),
    async *receive() {},
    acceptResult: async () => { callbacks++; },
  };
  const codex: Hythe = { ...fake, hytheId: "codex", hostKind: "codex-app-server" };
  const hythes = new Map([["gpt-web", fake], ["codex", codex]]);
  const scheduler = new Continuations(db, hythes);
  try {
    const submitted = scheduler.submit({ requestId: "one", originNodeId: "astra",
      originSessionId: "astra-session", centerNodeId: "sol", workerNodeIds: [], body: "Need research" });
    await scheduler.pump();
    const input = { requestId: "callback-one", runId: submitted.run.run_id,
      messageId: submitted.run.message_id, body: "Research answer" };
    const caller = { nodeId: "sol", sessionId: "sol-session" };
    await assert.rejects(acceptGptResult(db, hythes,
      { nodeId: "astra", sessionId: "astra-session" }, input), { code: "denied" });
    const stored = await acceptGptResult(db, hythes, caller, input);
    assert.equal(stored.agentCompleted, false);
    assert.equal(scheduler.run(input.runId).state, "running");
    assert.equal((await acceptGptResult(db, hythes, caller, input)).duplicate, true);
    assert.equal(callbacks, 1);
    await assert.rejects(acceptGptResult(db, hythes, caller,
      { ...input, body: "different" }), { code: "conflict" });
    const persisted = db.prepare("SELECT body FROM gpt_result_callbacks WHERE run_id = ?")
      .get(input.runId) as { body: string };
    assert.equal(persisted.body, input.body);
    assert.equal(getMessage(db, input.messageId).state, "delivered");
    await scheduler.ingest("sol-session", { hostRef: "exact-gpt-turn",
      observedMessageId: input.messageId, body: persisted.body, outcome: "completed" });
    assert.equal(scheduler.run(input.runId).state, "completed");
  } finally { db.close(); }
});

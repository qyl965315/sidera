import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../core/db.ts";
import { recordFrontendPresence } from "../core/frontend-presence.ts";
import { recordFrontendRoute, latestFrontendRoute } from "../core/frontend-route.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { createWorld, recordWorld, scopeNewNode } from "../core/worlds.ts";
import { getMessage } from "../core/bus.ts";
import { callCore } from "../hythes/core-client.ts";
import { buildEdge, startGatewayHttp, type GatewayWorkspaceConfig } from "../hythes/mcp-gateway.ts";
import type { Hythe } from "../hythes/types.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { bindChiefConversation, ChiefDispatch, type ChiefFrontend } from "./fixtures/chief.ts";
import { CoreRuntime, mockProfile } from "./fixtures/execution.ts";

function text(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
}

/**
 * A deterministic local contract witness. It uses a real streamable-HTTP MCP
 * client and the actual Core RPC/Bus/Scheduler. "mock" only labels the two
 * local Hythe implementations: it is explicitly not evidence that ChatGPT
 * cloud accepted the connector or that a cloud conversation received a push.
 */
test("MOCK E2E: inbound ChatGPT MCP -> pinned Codex Run -> durable exact-Chief result read", async () => {
  const root=mkdtempSync(join(tmpdir(),"sidera-chatfirst-return-"));
  const db=openDatabase(join(root,"sidera.sqlite"));
  const at=new Date().toISOString();
  for(const nodeId of ["chief","codex","codex-uncertain"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(nodeId,nodeId,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock-hythe','mock',?,'active',?)")
      .run(`${nodeId}-session`,nodeId,`${nodeId}-locator`,at);
  }
  const binding=bindChiefConversation(db,{kind:"human",id:"fixture"},{
    projectSpaceId:"chatfirst-project",projectRef:"D:/chatfirst-project",chiefNodeId:"chief",
    frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/exact-current-chief",
  });
  const worldId=recordWorld(db,"nodes","chief");
  recordFrontendPresence(db,{worldId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
    evidenceClass:"ROUTE_VERIFIED",evidenceRef:"mock:exact-inbound",method:"mock",ttlMs:60_000});
  recordFrontendRoute(db,{worldId,bindingId:binding.bindingId,conversationRef:binding.conversationRef,
    candidate:{routeId:"mock-inbound-read",routeClass:"native",supportsSend:true,controlProfile:mockProfile},
    evidenceRef:"mock:prepared-route",method:"mock"});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/codex",projectRef:binding.projectRef});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"codex",capability:"message.send",resourceScope:"node/chief",projectRef:binding.projectRef});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/codex-uncertain",projectRef:binding.projectRef});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"codex-uncertain",capability:"message.send",resourceScope:"node/chief",projectRef:binding.projectRef});
  issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"self.frontend.receive",resourceScope:"node/chief/**",projectRef:binding.projectRef});

  const hostCalls: Array<Record<string,unknown>>=[];
  const hythe:Hythe={hytheId:"mock-hythe",hostKind:"mock",capabilities:()=>["message.receive"],canStartTurn:()=>true,
    locate:async()=>true,async *receive(){},invoke:async (_locator,_capability,input)=>{
      hostCalls.push(input as Record<string,unknown>);return {status:"accepted",hostRef:`mock-turn-${hostCalls.length}`};
    }};
  const frontend:ChiefFrontend={
    restore: bound=>latestFrontendRoute(db,{worldId:recordWorld(db,"nodes",bound.chiefNodeId),bindingId:bound.bindingId}),
    inspect:async()=>({ready:true,reason:"mock exact binding"}),
    // A local uncertain frontend effect is deliberately not retried. The
    // result remains readable through MCP, but this is not cloud delivery.
    deliver:async (_bound,_message,boundary)=>boundary!.cross({product:"chatgpt-web",locator:binding.conversationRef,
      operation:"conversation.send"},async()=>({status:"uncertain",reason:"mock frontend has no cloud push"})),
  };
  const hythes=new Map([[hythe.hytheId,hythe]]);
  const runtime=new CoreRuntime(db,hythes);
  const chief=new ChiefDispatch(db,hythes,frontend);
  runtime.continuations.presentRootResult=messageId=>chief.present(messageId);
  const rpc=new CoreRpcServer(db,runtime,hythes,{authenticate:token=>token==="chief-core-token"
    ? {kind:"node",nodeId:"chief",sessionId:"chief-session"}:null},undefined,root,chief);
  const corePort=await rpc.listen(0);
  const config:GatewayWorkspaceConfig={version:1,corePort,gatewayPort:0,host:"127.0.0.1",edges:[]};
  const edge=buildEdge(config,{id:"chatgpt",boundNodeId:"chief",coreToken:"chief-core-token",token:"mock-chatgpt-boundary",
    chiefConversationRef:binding.conversationRef});
  const gateway=await startGatewayHttp([edge],{port:0});
  const client=new Client({name:"mock-current-chatgpt",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`),
    {requestInit:{headers:{Authorization:"Bearer mock-chatgpt-boundary"}}}));
  try {
    const requestId=randomUUID();
    const call={name:"sidera_invoke",arguments:{operation:"task.dispatch",arguments:{requestId,centerNodeId:"codex",body:"Read only fixture action"}}};
    const first=text(await client.callTool(call));
    assert.equal(first.ok,true);assert.ok(first.task?.taskId);assert.equal(first.chiefBinding.bindingId,binding.bindingId);
    const duplicate=text(await client.callTool(call));
    assert.equal(duplicate.task.taskId,first.task.taskId,"exact request ID is idempotent");
    assert.equal(db.prepare("SELECT count(*) n FROM tasks").get()?.n,1,"duplicate created no replacement Task");

    await runtime.continuations.pump();
    const run=runtime.continuations.run(String(first.run.run_id));
    const taskMessage=getMessage(db,run.message_id);
    assert.equal(run.session_id,"codex-session","Core pinned the target Session");
    await runtime.ingest("codex-session",{hostRef:taskMessage.hostRef!,observedMessageId:taskMessage.messageId,
      body:"actual mock Codex receipt",outcome:"completed"});
    await runtime.continuations.pump();

    const read=text(await client.callTool({name:"sidera_read",arguments:{operation:"chief.result_get",arguments:{taskId:first.task.taskId}}}));
    assert.equal(read.ok,true);assert.equal(read.readMarksHumanObserved,false);assert.equal(read.readReplaysWork,false);
    const result=read.results[0];
    assert.equal(result.originalBindingId,binding.bindingId);assert.equal(result.originalConversationRef,binding.conversationRef);
    assert.equal(result.workerBody,"actual mock Codex receipt");assert.equal(result.task.task.taskId,first.task.taskId);
    assert.equal(result.task.runs[0].session_id,"codex-session");
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='HumanObserved'").get()?.n,0,
      "readback is not false Human observation");

    // The canonical MCP schema never accepts a caller-selected conversation;
    // its deployment-bound value wins. Core also rejects a malformed direct
    // principal request rather than using it to read another Chat's inbox.
    await assert.rejects(callCore({port:corePort,token:"chief-core-token"},"chief.result_get",
      {conversationRef:"https://chatgpt.com/c/wrong"}),/exact bound Conversation/);
    // This root Task has no invented Human approval/presentation event. Reading
    // the persisted result a second time must not create a replacement Host
    // turn, a replacement Task, or a Human-observation claim.
    const again=text(await client.callTool({name:"sidera_read",arguments:{operation:"chief.result_get",arguments:{taskId:first.task.taskId}}}));
    assert.equal(again.results[0].messageId,result.messageId);
    assert.equal(hostCalls.filter(call=>call.kind==="task").length,1,"readback never replays the Codex Host turn");

    const uncertainRequestId=randomUUID();
    const uncertainDispatch=text(await client.callTool({name:"sidera_invoke",arguments:{operation:"task.dispatch",arguments:{
      requestId:uncertainRequestId,centerNodeId:"codex-uncertain",body:"Produce no recoverable result"}}}));
    await runtime.continuations.pump();
    const uncertainRun=runtime.continuations.run(String(uncertainDispatch.run.run_id));
    const uncertainMessage=getMessage(db,uncertainRun.message_id);
    // This is the same no-replay recovery surface production uses when Core
    // cannot prove whether the exact Host survived. It is intentionally not a
    // fabricated Host completion event.
    runtime.resourceLost("codex-uncertain-session","mock Host lost after possible effect","mock-e2e");
    const uncertainRead=text(await client.callTool({name:"sidera_read",arguments:{operation:"chief.result_get",arguments:{taskId:uncertainDispatch.task.taskId}}}));
    assert.deepEqual(uncertainRead.results,[],"uncertain work has no fabricated result");
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id=?").get("codex-uncertain-session")?.state,"unknown",
      "lost Host state is retained as uncertain evidence, not rewritten as completion");
    assert.equal(db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id=?").get(uncertainRun.run_id)?.turn_open,1,
      "the original exact Run remains for reconciliation rather than being silently closed");
    assert.equal(hostCalls.filter(call=>call.kind==="task").length,2,"uncertain Host work was not replayed");

    const foreignWorld=createWorld(db,"foreign fixture World","test-only cross-World isolation");
    scopeNewNode(db,foreignWorld,"foreign-worker");
    db.prepare("INSERT INTO nodes VALUES (?,?, 'active',?)").run("foreign-worker","foreign-worker",new Date().toISOString());
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock-hythe','mock',?,'active',?)")
      .run("foreign-worker-session","foreign-worker","foreign-worker-locator",new Date().toISOString());
    issueGrant(db,{kind:"human",id:"fixture"},{subjectNodeId:"chief",capability:"task.dispatch",resourceScope:"node/foreign-worker",projectRef:binding.projectRef});
    const countBeforeForeign=Number(db.prepare("SELECT count(*) n FROM tasks").get()?.n);
    const foreign=text(await client.callTool({name:"sidera_invoke",arguments:{operation:"task.dispatch",arguments:{
      requestId:randomUUID(),centerNodeId:"foreign-worker",body:"must not cross Worlds"}}}));
    assert.equal(foreign.result.ok,false);assert.match(String(foreign.result.reason),/Cross-World/);
    assert.equal(db.prepare("SELECT count(*) n FROM tasks").get()?.n,countBeforeForeign,"cross-World request created no Task");
  } finally {
    await client.close().catch(()=>{});await gateway.close();runtime.close();chief.close();await rpc.close();db.close();
  }
});

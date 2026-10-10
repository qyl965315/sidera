import { protocolTestBoundary } from "./fixtures/execution.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { DshHythe } from "../hythes/dsh.ts";

test("DSH routes distinct Core Session and ACP locator and settles after acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "sidera-dsh-acp-"));
  const fixture = join(root, "agent.mjs");
  mkdirSync(join(root, "profiles", "desktop"), { recursive: true });
  writeFileSync(join(root, "profiles", "desktop", "cordis.patch.yml"),
    "- id: agent-default-model\n  config:\n    provider: account-fixture\n    model: available-fixture\n");
  writeFileSync(fixture, `
import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
const send=p=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...p})+'\\n');
for await(const line of lines){
 const p=JSON.parse(line);
 if(p.method==='initialize')send({id:p.id,result:{protocolVersion:1}});
 if(p.method==='session/new')send({id:p.id,result:{sessionId:'host-locator'}});
 if(p.method==='session/set_config_option')send({id:p.id,result:{configOptions:[{id:'model',currentValue:p.params.value}]}});
 if(p.method==='session/close')send({id:p.id,result:{}});
 if(p.method==='session/prompt'){
  send({method:'session/update',params:{sessionId:'host-locator',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'completed-result'}}}});
  setTimeout(()=>send({id:p.id,result:{stopReason:'end_turn'}}),50);
 }
}
`);
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO nodes VALUES ('node','DSH Fixture','active',?)").run(now);
  db.prepare("INSERT INTO sessions VALUES ('core-session','node','dsh-acp','dsh-harness-acp','host-locator','active',?)").run(now);
  const host = new DshHythe({ executable: process.execPath, cliEntry: fixture,
    dshHome: root, workspace: join(root, "workspace"), db, coreToken: "local-fixture",
    corePort: 8765, mcpEntry: join(root, "unused-mcp.ts") });
  try {
    const locator = await host.createSession();
    assert.deepEqual(host.modelBinding(locator), { provider: "account-fixture", modelId: "available-fixture" });
    const message = { messageId: "message", body: "small task", taskId: "task" };
    assert.equal((await host.invoke(locator, "message.receive", { ...message, targetSessionId: locator }, "wrong-session")).status, "rejected");
    const result = await host.invoke(locator, "message.receive", { ...message, targetSessionId: "core-session" }, "exact-session",protocolTestBoundary);
    assert.equal(result.status, "accepted");
    const completed = await host.receive(locator)[Symbol.asyncIterator]().next();
    assert.equal(completed.value?.observedMessageId, "message");
    assert.equal(completed.value?.outcome, "completed");
    assert.equal(completed.value?.body, "completed-result");
    assert.equal(completed.value?.hostRef, result.status === "accepted" ? result.hostRef : "");
  } finally { await host.close(); db.close(); }
});

test("DSH restart discovers persisted exact locators; discovery never silently resumes an Agent",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sidera-dsh-resume-")),fixture=join(root,"agent.mjs");
 writeFileSync(fixture,`import readline from 'node:readline';
 const send=p=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...p})+'\\n');
 for await(const line of readline.createInterface({input:process.stdin})){
  const p=JSON.parse(line);
  if(p.method==='initialize')send({id:p.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{},resume:{}}}}});
  if(p.method==='session/list')send({id:p.id,result:{sessions:[{sessionId:'persisted',cwd:p.params.cwd}]}});
  if(p.method==='session/resume')send({id:p.id,result:{configOptions:[{id:'model',currentValue:'["fixture","model"]'}]}});
  if(p.method==='session/close')send({id:p.id,result:{}});
 }`);
 const db=openDatabase(":memory:");
 const make=()=>new DshHythe({executable:process.execPath,cliEntry:fixture,dshHome:root,workspace:root,db,coreToken:"fixture",corePort:1,mcpEntry:fixture});
 const first=make();try{
  assert.deepEqual(await first.discoverSessions(),[{locatorRef:"persisted",active:false}]);
  assert.equal(await first.locate("persisted"),false);
  assert.equal(first.diagnostics().transportConnected,true);
  await assert.rejects(first.control("persisted","conversation.resume",{},undefined),/Final Core Effect boundary/);
  await first.close();
  const restarted=make();try{
   assert.equal((await restarted.discoverSessions())[0]?.active,false);
   const result=await restarted.control("persisted","conversation.resume",{},protocolTestBoundary);
   assert.equal(result.locatorRef,"persisted");assert.equal(await restarted.locate("persisted"),true);
   assert.equal(await restarted.locate("another"),false);
  }finally{await restarted.close();}
 }finally{await first.close();db.close();}
});

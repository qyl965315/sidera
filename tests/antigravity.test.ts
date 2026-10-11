import { protocolTestBoundary } from "./fixtures/execution.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AntigravityHythe } from "../hythes/antigravity.ts";

test('automatic Gemini configuration uses owning default and refuses model work without an attested identity',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sidera-agy-auto-')),fixture=join(root,'auto.mjs');
 writeFileSync(fixture,`import readline from 'node:readline';if(process.argv.includes('--model'))throw Error('Default must not be guessed');process.stdout.write(JSON.stringify({event:'init',conversation_id:'auto-session',init:{tools:[]}})+'\\n');for await(const line of readline.createInterface({input:process.stdin}))throw Error('No model work permitted');`);
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events (id TEXT,node_id TEXT,type TEXT,body TEXT,at TEXT)');const h=new AntigravityHythe({executable:process.execPath,launchArgs:[fixture],workspace:root,settingsPath:join(root,'settings.json'),provider:'unverified',modelId:'auto',effort:'medium',db,coreToken:randomUUID(),corePort:8765,mcpEntry:fixture});
 try{const locator=await h.createSession();assert.equal(h.modelBinding(locator),null);assert.equal(h.canStartTurn(),false);assert.equal((await h.invoke(locator,'message.receive',{messageId:randomUUID(),body:'must not send'},randomUUID(),protocolTestBoundary)).status,'rejected');}finally{await h.close();db.close();}
});

test("Antigravity native turns keep exact conversation and never complete uncertain work", async () => {
  const root = mkdtempSync(join(tmpdir(), "sidera-agy-"));
  const fixture = join(root, "host.mjs");
  writeFileSync(fixture, `
import readline from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
send({event:'init',conversation_id:'exact-agy',init:{model:{provider:'fixture-provider',modelId:'fixture-flash-medium'},tools:['session_active'],permission_mode:'request-review'}});
let count=0;
for await (const line of readline.createInterface({input:process.stdin})) {
  count++;
  send({event:'step_update',step_update:{conversation_id:'exact-agy',step_type:'user_input'}});
  setTimeout(() => {
    send({event:'result',result:{conversation_id:count===4?'another-conversation':'exact-agy',status:count===3?'ERROR':'SUCCESS',error:count===3?'FAILED_PRECONDITION: unsupported location':undefined,response:count===2?'':'done',usage:{total_tokens:10}}});
    if(count===4) send({event:'result',result:{conversation_id:'exact-agy',status:'SUCCESS',response:'late result'}});
  },25);
}
`);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (id TEXT,node_id TEXT,type TEXT,body TEXT,at TEXT)");
  const h = new AntigravityHythe({ executable: process.execPath, launchArgs:[fixture], workspace:root,
    settingsPath:join(root,"settings.json"),provider:"fixture-provider",modelId:"fixture-flash-medium",effort:"medium",db,
    coreToken:randomUUID(),corePort:8765,mcpEntry:fixture });
  const inspection = new AntigravityHythe({ executable:process.execPath,launchArgs:[fixture],workspace:root,
    settingsPath:join(root,"settings.json"),provider:"fixture-provider",modelId:"fixture-flash-medium",effort:"medium",db,
    coreToken:randomUUID(),corePort:8765,mcpEntry:fixture });
  try {
    await inspection.control("exact-agy","session.inspect");
    assert.equal(existsSync(join(root,"settings.json")),false);
    assert.equal(existsSync(join(root,".agents","mcp_config.json")),false);
  } finally { await inspection.close(); }
  try {
    const locator=await h.createSession(); assert.equal(locator,"exact-agy");
    const mcp=JSON.parse(readFileSync(join(root,".agents","mcp_config.json"),"utf8"));
    const args=mcp.mcpServers.sidera.args as string[];
    assert.equal(args.length,2,"Node MCP entry receives its required private connection file");
    assert.equal(args[0],fixture);assert.equal(isAbsolute(args[0]),true);
    const binding=JSON.parse(readFileSync(args[1]!,"utf8"));
    assert.equal(binding.port,8765);assert.equal(typeof binding.token,"string");assert.ok(binding.token.length>20);
    assert.equal(await h.locate("another-conversation"),false);
    const it=h.receive(locator)[Symbol.asyncIterator]();
    assert.deepEqual((await h.control(locator,"session.inspect")).tools,['session_active']);
    for(const [index,outcome] of ["completed","completed","failed","failed"].entries()) {
      const messageId=randomUUID(), received=it.next();
      const accepted=await h.invoke(locator,"message.receive",{messageId,body:"task"},randomUUID(),protocolTestBoundary);
      assert.equal(accepted.status,"accepted");
      const result=(await received).value!;
      assert.equal(result.observedMessageId,messageId); assert.equal(result.outcome,outcome);
      if(index===1) assert.equal(result.body,''); // Closed Host turn, not Agent completion.
      if(index===2) assert.match(result.body,/FAILED_PRECONDITION/);
    }
    assert.equal((await h.invoke(locator,"message.receive",{messageId:randomUUID(),body:"no replay"},randomUUID())).status,"rejected");
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='host.usage'").get()!.n,3);
  } finally { await h.close(); db.close(); }
});

test("native string Model identity unlocks auto selection and Human Conversation never invents Task/Run",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sidera-agy-conversation-"));
 const executableFixture=join(root,"stream.mjs");
 writeFileSync(executableFixture,`import readline from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
send({event:'init',conversation_id:'owner-stream-conversation',init:{model:'gemini-3.8-flash-low',tools:[]}});
for await (const line of readline.createInterface({input:process.stdin})){
 const event=JSON.parse(line);
 if(event.event!=='user')continue;
 send({event:'step_update',step_update:{conversation_id:'owner-stream-conversation',step_type:'user_input'}});
 send({event:'result',result:{conversation_id:'owner-stream-conversation',status:'SUCCESS',response:event.message.content}});
}`);
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE events (id TEXT,node_id TEXT,type TEXT,body TEXT,at TEXT)");
 const h=new AntigravityHythe({executable:process.execPath,launchArgs:[executableFixture],
  workspace:root,settingsPath:join(root,"settings.json"),provider:"unverified",modelId:"auto",
  effort:"low",db,coreToken:randomUUID(),corePort:47621,mcpEntry:executableFixture});
 try{
  const locator=await h.createSession();
  assert.equal(locator,"owner-stream-conversation");
  assert.deepEqual(h.modelBinding(locator),{provider:"antigravity-cli",modelId:"gemini-3.8-flash-low"});
  assert.equal(h.canStartTurn(),true);
  const invalid=await h.invoke(locator,"message.receive",{messageId:randomUUID(),kind:"conversation",
   taskId:"forged-task",body:"user text"},randomUUID(),protocolTestBoundary);
  assert.equal(invalid.status,"rejected","Conversation cannot borrow Task authority");
  const messageId=randomUUID(),resultP=h.receive(locator)[Symbol.asyncIterator]().next();
  const accepted=await h.invoke(locator,"message.receive",{messageId,kind:"conversation",
   body:"Human literal body"},randomUUID(),protocolTestBoundary);
  assert.equal(accepted.status,"accepted");
  const event=(await resultP).value!;
  assert.equal(event.observedMessageId,messageId);
  assert.equal(event.hostRef,accepted.hostRef);
  assert.equal(event.outcome,"completed");
  assert.match(event.body,/Sidera Human Conversation/);
  assert.match(event.body,/Human literal body/);
  assert.doesNotMatch(event.body,/Task undefined|Run undefined|task_dispatch|workspace_write_text/);
 }finally{await h.close();db.close();}
});

test("Antigravity refuses an absent Node MCP entry before launching the owning Host",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sidera-agy-missing-entry-")),fixture=join(root,"host.mjs");
 writeFileSync(fixture,"process.stdout.write(JSON.stringify({event:'init',conversation_id:'must-not-start'})+'\\n')");
 const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE events (id TEXT,node_id TEXT,type TEXT,body TEXT,at TEXT)");
 const h=new AntigravityHythe({executable:process.execPath,launchArgs:[fixture],workspace:root,settingsPath:join(root,"settings.json"),provider:"fixture",modelId:"fixture-model",effort:"low",db,coreToken:randomUUID(),corePort:8765,mcpEntry:join(root,"missing-node-entry.ts")});
 try{await assert.rejects(h.createSession(),/Exact Node MCP entry is unavailable/);assert.equal(existsSync(join(root,".agents","mcp_config.json")),false);}finally{await h.close();db.close();}
});

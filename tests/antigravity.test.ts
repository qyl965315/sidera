import { protocolTestBoundary } from "./fixtures/execution.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
send({event:'init',conversation_id:'exact-agy',init:{tools:['session_active'],permission_mode:'request-review'}});
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

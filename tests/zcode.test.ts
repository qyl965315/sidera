import { protocolTestBoundary } from "./fixtures/execution.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ZcodeHythe } from "../hythes/zcode.ts";
test("ZCode SDK exact resume separates native acceptance and terminal completion; foreign results never replay", async () => {
  const root=mkdtempSync(join(tmpdir(),"sidera-zcode-")), fixture=join(root,"sdk.mjs");
  writeFileSync(fixture, `
const model={providerId:'account:bigmodel-start-plan',modelId:'fixture-flash'};
const snapshot={sessionId:'sess_exact',config:{modelSelection:model,thought:'high'}};
export async function connectViaWebSocket(){let listener,events=[],current;
const emit=payload=>listener?.({kind:'complete',topic:'conversation/sess_exact',frame:{payload}});
return {modelSelectionService:{getView:async()=>({providers:[{providerId:model.providerId,config:{access:{entitled:true}},models:[{modelId:model.modelId,config:{enabled:true}}]}]})},zcodeAgentService:{
helloConversationV4:async()=>({clientMode:'web-remote-replayable',protocolVersion:3}),initializeConversationV4:async()=>{},
subscribeConversationV4:async({sessionId})=>{if(sessionId!=='sess_exact')throw new Error('not found');emit({kind:'snapshot',snapshot});return{ack:{subscriptionId:'sub_exact'}}},
onDynamicConversationFrame:()=>f=>{listener=f;return{dispose:()=>{listener=null}}},
conversationRowsRangeV4:async()=>({rows:[{kind:'turnHeader',sourceCommandId:current.commandId,turnId:'native',state:current.payload.text.includes('FOREIGN')?'running':'completedSuccess'},
 {kind:'userInput',sourceCommandId:current.commandId,turnId:'native',text:current.payload.text},{kind:'assistantText',turnId:'native',state:'complete',text:'done'}]}),
sendConversationCommandV4:async({envelope:e})=>{
 if(e.type==='createSession')return{commandId:e.commandId,status:'accepted',result:{type:'createSession',sessionId:'sess_exact'}};
 current=e;
 events=[{type:'turn.started',sessionId:'sess_exact',turnId:e.commandId,payload:{input:e.payload.text}}];
 emit({kind:'deltas',deltas:[{op:'state.updated',patch:{control:{phase:'running'}}}]});
 setTimeout(()=>{events.push({type:'turn.completed',sessionId:e.payload.text.includes('FOREIGN')?'sess_foreign':'sess_exact',turnId:e.commandId,payload:{response:'done',tokenCount:12}});
 emit({kind:'deltas',deltas:[{op:'state.updated',patch:{control:{phase:'completedSuccess'}}}]});
 if(e.payload.text.includes('FOREIGN'))setTimeout(()=>emit({kind:'deltas',deltas:[{op:'state.updated',patch:{control:{phase:'completedSuccess'}}}]}),5)},30);
 return{commandId:e.commandId,status:'accepted'};
}}};}
`);
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE events(id TEXT,node_id TEXT,type TEXT,body TEXT,at TEXT)");
  const h=new ZcodeHythe({serviceUrl:"ws://127.0.0.1:19389/ws",sdkPath:fixture,workspace:root,mcpConnectionPath:join(root,"private.json"),mcpEntry:fixture,db});
  try { const locator=await h.createSession();assert.equal(locator,"sess_exact");
    assert.equal(await h.locate("sess_foreign"),false);assert.equal(h.modelBinding()?.provider,"account:bigmodel-start-plan");
    const it=h.receive(locator)[Symbol.asyncIterator]();
    for(const body of ["native task","FOREIGN"]){const messageId=randomUUID(),received=it.next();
      const accepted=await h.invoke(locator,"message.receive",{messageId,body},randomUUID(),protocolTestBoundary);assert.equal(accepted.status,"accepted");
      assert.equal(h.canStartTurn(),false);const result=(await received).value!;assert.equal(result.observedMessageId,messageId);
      assert.equal(result.outcome,body==="FOREIGN"?"failed":"completed");}
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.canStartTurn(),false);
    assert.equal((await h.invoke(locator,"message.receive",{messageId:randomUUID(),body:"no replay"},randomUUID())).status,"rejected");
    assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n,2);
  } finally {await h.close();db.close();}
});

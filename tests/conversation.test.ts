import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { dispatchConversation, conversationView } from "../core/conversation.ts";
import { openHumanIngress } from "../core/human-admission.ts";
import { bindChiefConversation } from "./fixtures/chief.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { recordFixtureHostAvailable } from "./fixtures/host-condition.ts";
import type { Hythe } from "../hythes/types.ts";
import { mockProfile } from "./fixtures/execution.ts";
import { recordWorld } from "../core/worlds.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { callCore } from "../hythes/core-client.ts";

function fixture() {
  const db=openDatabase(":memory:"),at=new Date().toISOString();
  db.prepare("INSERT INTO nodes VALUES ('chief','Chief','active',?)").run(at);
  db.prepare("INSERT INTO sessions VALUES ('chief-session','chief','fixture','test','fixture://chief','active',?)").run(at);
  recordFixtureHostAvailable(db,"chief-session");
  const binding=bindChiefConversation(db,{kind:"human",id:"human"},{projectSpaceId:"project",projectRef:"sidera://project/p",
    chiefNodeId:"chief",frontendKind:"fixture",conversationRef:"fixture://conversation/exact"});
  issueGrant(db,{kind:"human",id:"human"},{subjectNodeId:"chief",capability:"message.send",resourceScope:"node/chief"});
  issueGrant(db,{kind:"human",id:"human"},{subjectNodeId:"chief",capability:"self.host.execute",resourceScope:"node/chief/session/chief-session"});
  const source=openHumanIngress(db,{worldId:recordWorld(db,"nodes","chief"),humanId:"human",presenceRef:"local-human-desktop:conversation",sourceRef:"fixture:local-desktop"});
  return {db,binding,source};
}

test("Human Conversation persists a nonce before one gated Host dispatch and records only a correlated reply",async()=>{
  const {db,binding,source}=fixture();let calls=0;
  const hythe:Hythe={hytheId:"fixture",hostKind:"test",capabilities:()=>["message.receive"],effectProfile:()=>mockProfile,
    locate:async()=>true,async *receive(){},invoke:async(_l,_c,_i,_r,boundary)=>{
      calls++;return boundary!.cross({product:"test",locator:"fixture://chief",operation:"message.receive"},()=>({status:"accepted",hostRef:"host-turn-1"}));}};
  try {
    const utteranceId=source.capture("nonce-000000000001","literal Human text");
    const receipt=dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:"nonce-000000000001",utteranceId,body:"literal Human text"});
    assert.equal(receipt.fresh,true);
    const runtime=new CoreRuntime(db,new Map([["fixture",hythe]]));
    const {deliverMessage}=await import("../core/bus.ts");
    const delivered=await deliverMessage(db,receipt.messageId,new Map([["fixture",hythe]]));
    assert.equal(delivered.state,"delivered");assert.equal(calls,1);
    await runtime.ingest("chief-session",{hostRef:"host-turn-1",observedMessageId:receipt.messageId,body:"verified Host result",outcome:"completed"});
    const view=conversationView(db,{humanId:"human",bindingId:binding.bindingId});
    assert.deepEqual((view.entries as any[]).map(e=>[e.direction,e.body,e.transport_state]),[
      ["human_to_communicator","literal Human text","observed"],["communicator_to_human","verified Host result","observed"]]);
    const duplicate=dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:"nonce-000000000001",utteranceId,body:"literal Human text"});
    assert.equal(duplicate.fresh,false);assert.equal(calls,1,"duplicate nonce never crosses Host again");
    assert.throws(()=>dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:"nonce-000000000001",utteranceId,body:"altered"}),{code:"denied"});
    await runtime.ingest("chief-session",{hostRef:"host-turn-1",observedMessageId:receipt.messageId,body:"verified Host result",outcome:"completed"});
    assert.equal((conversationView(db,{humanId:"human",bindingId:binding.bindingId}).entries as any[]).length,2,"late duplicate result is correlated, not synthesized");
  } finally { db.close(); }
});

test("Conversation rejects foreign Human ingress and leaves no outbound message",()=>{
  const {db,binding,source}=fixture();try {
    const utteranceId=source.capture("nonce-000000000002","private text");
    assert.throws(()=>dispatchConversation(db,{humanId:"other-human",bindingId:binding.bindingId,clientNonce:"nonce-000000000002",utteranceId,body:"private text"}),{code:"denied"});
    assert.equal(db.prepare("SELECT count(*) n FROM messages").get()!.n,0);
  } finally { db.close(); }
});

test("the only Human RPC is the local typed Conversation route, not a generic Node surface",async()=>{
  const {db,binding,source}=fixture();
  const hythe:Hythe={hytheId:"fixture",hostKind:"test",capabilities:()=>["message.receive"],effectProfile:()=>mockProfile,locate:async()=>true,async *receive(){},
    invoke:async(_l,_c,_i,_r,boundary)=>boundary!.cross({product:"test",locator:"fixture://chief",operation:"message.receive"},()=>({status:"accepted",hostRef:"rpc-host-turn"}))};
  const runtime=new CoreRuntime(db,new Map([["fixture",hythe]]));
  const rpc=new CoreRpcServer(db,runtime,new Map([["fixture",hythe]]),{authenticate:token=>token==="local-owner"?{kind:"human",id:"local-desktop-ingress"}:null});
  const port=await rpc.listen();
  try {
    const utteranceId=source.capture("nonce-000000000003","typed local message");
    const result=await callCore({port,token:"local-owner"},"human.conversation.send",{humanId:"human",bindingId:binding.bindingId,clientNonce:"nonce-000000000003",utteranceId,body:"typed local message"}) as {state:string;messageId:string};
    assert.equal(result.state,"delivered");
    await runtime.ingest("chief-session",{hostRef:"rpc-host-turn",observedMessageId:result.messageId,body:"typed correlated reply",outcome:"completed"});
    assert.equal((conversationView(db,{humanId:"human",bindingId:binding.bindingId}).entries as any[]).at(-1)?.body,"typed correlated reply");
    await assert.rejects(callCore({port,token:"not-local-owner"},"human.conversation.view",{humanId:"human",bindingId:binding.bindingId}));
    await assert.rejects(callCore({port,token:"local-owner"},"message.send",{}));
  } finally { await rpc.close();db.close(); }
});

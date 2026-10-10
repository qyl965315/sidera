import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { dispatchConversation, conversationView, recordConversationReply, requireUniqueLocalConversationHuman } from "../core/conversation.ts";
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

test("a second Human in the same World cannot read an unrelated private Conversation",()=>{
  const {db,binding,source}=fixture();try {
    const utteranceId=source.capture("nonce-000000000004","first Human private text");
    const receipt=dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:"nonce-000000000004",utteranceId,body:"first Human private text"});
    recordConversationReply(db,{messageId:receipt.messageId,hostRef:"private-host-turn",body:"private correlated reply"});
    const worldId=recordWorld(db,"nodes","chief"),at=new Date().toISOString();
    db.prepare("INSERT INTO human_principals VALUES ('other-human','Other Human','fixture secondary Human',?)").run(at);
    db.prepare("INSERT INTO world_humans VALUES (?,?,'same fixture World membership')").run(worldId,"other-human");
    assert.deepEqual((conversationView(db,{humanId:"other-human",bindingId:binding.bindingId}).entries as any[]).map(e=>e.body),[]);
  } finally { db.close(); }
});

test("each same-World Human sees only their own Conversation bodies and correlated replies",()=>{
  const {db,binding,source}=fixture();try {
    const ownUtterance=source.capture("nonce-000000000005","first Human text");
    const own=dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:"nonce-000000000005",utteranceId:ownUtterance,body:"first Human text"});
    recordConversationReply(db,{messageId:own.messageId,hostRef:"first-host-turn",body:"first reply"});
    const worldId=recordWorld(db,"nodes","chief"),at=new Date().toISOString();
    db.prepare("INSERT INTO human_principals VALUES ('other-human','Other Human','fixture secondary Human',?)").run(at);
    db.prepare("INSERT INTO world_humans VALUES (?,?,'same fixture World membership')").run(worldId,"other-human");
    issueGrant(db,{kind:"human",id:"other-human"},{subjectNodeId:"chief",capability:"message.send",resourceScope:"node/chief"});
    const otherSource=openHumanIngress(db,{worldId,humanId:"other-human",presenceRef:"local-human-desktop:conversation",sourceRef:"fixture:other-local-desktop"});
    const otherUtterance=otherSource.capture("nonce-000000000006","second Human text");
    const other=dispatchConversation(db,{humanId:"other-human",bindingId:binding.bindingId,clientNonce:"nonce-000000000006",utteranceId:otherUtterance,body:"second Human text"});
    recordConversationReply(db,{messageId:other.messageId,hostRef:"second-host-turn",body:"second reply"});
    assert.deepEqual((conversationView(db,{humanId:"human",bindingId:binding.bindingId}).entries as any[]).map(e=>e.body),["first Human text","first reply"]);
    assert.deepEqual((conversationView(db,{humanId:"other-human",bindingId:binding.bindingId}).entries as any[]).map(e=>e.body),["second Human text","second reply"]);
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


test("an explicitly retried queued nonce resumes exactly once; uncertain messages cannot replay",async()=>{
  const {db,binding,source}=fixture();let hostCalls=0;
  const hythe:Hythe={hytheId:"fixture",hostKind:"test",capabilities:()=>["message.receive"],
    effectProfile:()=>mockProfile,locate:async()=>true,async *receive(){},
    invoke:async(_l,_c,_i,_r,boundary)=>{
      hostCalls++;
      return boundary!.cross({product:"test",locator:"fixture://chief",operation:"message.receive"},
        ()=>({status:"accepted",hostRef:"queued-resume-turn"}));
    }};
  const runtime=new CoreRuntime(db,new Map([["fixture",hythe]]));
  const rpc=new CoreRpcServer(db,runtime,new Map([["fixture",hythe]]),{
    authenticate:token=>token==="local-owner"?{kind:"human",id:"local-desktop-ingress"}:null});
  const port=await rpc.listen();
  try{
    const nonce="nonce-queued-safe-0001",body="Persisted before outbound handoff";
    const utteranceId=source.capture(nonce,body);
    const before=dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:nonce,utteranceId,body});
    assert.equal(db.prepare("SELECT state FROM messages WHERE message_id=?").get(before.messageId)?.state,"queued");
    const params={humanId:"human",bindingId:binding.bindingId,clientNonce:nonce,utteranceId,body};
    // Core restarted after a durable queue transaction but before any Host send.
    const resumed=await callCore({port,token:"local-owner"},"human.conversation.send",params) as {state:string;messageId:string};
    assert.equal(resumed.messageId,before.messageId);
    assert.equal(resumed.state,"delivered");assert.equal(hostCalls,1);
    const same=await callCore({port,token:"local-owner"},"human.conversation.send",params) as {state:string;messageId:string};
    assert.equal(same.messageId,before.messageId);assert.equal(hostCalls,1,"accepted Host request cannot replay");
    await runtime.ingest("chief-session",{hostRef:"queued-resume-turn",observedMessageId:before.messageId,
      body:"Confirmed after original queue continuation",outcome:"completed"});
    const seen=conversationView(db,{humanId:"human",bindingId:binding.bindingId});
    assert.equal((seen.entries as any[]).at(-1)?.body,"Confirmed after original queue continuation");
    const uncertainNonce="nonce-unknown-no-replay",uncertainBody="Possibly effected";
    const uncertainUtterance=source.capture(uncertainNonce,uncertainBody);
    const uncertain=dispatchConversation(db,{humanId:"human",bindingId:binding.bindingId,clientNonce:uncertainNonce,
      utteranceId:uncertainUtterance,body:uncertainBody});
    db.prepare("UPDATE messages SET state='uncertain' WHERE message_id=?").run(uncertain.messageId);
    const held=await callCore({port,token:"local-owner"},"human.conversation.send",
      {humanId:"human",bindingId:binding.bindingId,clientNonce:uncertainNonce,
        utteranceId:uncertainUtterance,body:uncertainBody}) as {state:string;messageId:string};
    assert.equal(held.messageId,uncertain.messageId);assert.equal(held.state,"uncertain");
    assert.equal(hostCalls,1,"uncertain state must never be replayed");
  }finally{await rpc.close();runtime.close();db.close();}
});

test("local Desktop bearer cannot impersonate either enrolled Human when a World has multiple Humans",async()=>{
  const {db,binding,source}=fixture();
  const worldId=recordWorld(db,"nodes","chief"),at=new Date().toISOString();
  db.prepare("INSERT INTO human_principals VALUES ('other-human','Other Human','second enrolled Human',?)").run(at);
  db.prepare("INSERT INTO world_humans VALUES (?,?,'second local actor lacks individual login')").run(worldId,"other-human");
  // A second local-device ingress would create an ambiguous local actor; deny both.
  openHumanIngress(db,{worldId,humanId:"other-human",presenceRef:"local-human-desktop:conversation",sourceRef:"fixture:second-local-device"});
  const hythe:Hythe={hytheId:"fixture",hostKind:"test",capabilities:()=>["message.receive"],
    effectProfile:()=>mockProfile,locate:async()=>true,async *receive(){},
    invoke:async()=>{assert.fail("Ambiguous local Human must never invoke Host");return {status:"rejected",reason:"not invoked"};}};
  const runtime=new CoreRuntime(db,new Map([["fixture",hythe]]));
  const rpc=new CoreRpcServer(db,runtime,new Map([["fixture",hythe]]),{
    authenticate:token=>token==="local-owner"?{kind:"human",id:"local-desktop-ingress"}:null
  });
  const port=await rpc.listen();
  try{
    const nonce="nonce-multi-human-denied",body="private text";
    const utteranceId=source.capture(nonce,body);
    for(const humanId of ["human","other-human"]){
      await assert.rejects(
        callCore({port,token:"local-owner"},"human.conversation.view",{humanId,bindingId:binding.bindingId}),
        /Sidera denied/);
      await assert.rejects(
        callCore({port,token:"local-owner"},"human.conversation.send",{humanId,bindingId:binding.bindingId,
          clientNonce:nonce,utteranceId,body}),
        /Sidera denied/);
    }
    assert.equal(db.prepare("SELECT count(*) n FROM messages").get()!.n,0,
      "No outbound message may be created by unauthenticated local Human selection");
    assert.equal(db.prepare("SELECT count(*) n FROM conversation_transcript_entries").get()!.n,0);
  }finally{await rpc.close();runtime.close();db.close();}
});

test("legacy one-Human Desktop may enter Chat before its first local Conversation source, but not a multi-Human World",()=>{
  const db=openDatabase(":memory:"),at=new Date().toISOString();
  try{
    db.prepare("INSERT INTO nodes VALUES ('single-chief','Chief','active',?)").run(at);
    db.prepare("INSERT INTO sessions VALUES ('single-session','single-chief','fixture','test','fixture://single','active',?)").run(at);
    const b=bindChiefConversation(db,{kind:"human",id:"only-human"},
      {projectSpaceId:"project",projectRef:"sidera://project/only",chiefNodeId:"single-chief",
       frontendKind:"fixture",conversationRef:"fixture://one-human/exact"});
    const world=recordWorld(db,"nodes","single-chief");
    assert.equal(db.prepare("SELECT count(*) n FROM human_frontend_sources WHERE world_id=? AND presence_ref='local-human-desktop:conversation'")
      .get(world)!.n,0,"Before first use, no native Conversation ingress exists");
    assert.doesNotThrow(()=>requireUniqueLocalConversationHuman(db,{humanId:"only-human",bindingId:b.bindingId}));
    db.prepare("INSERT INTO human_principals VALUES ('different','Different','additional participant',?)").run(at);
    db.prepare("INSERT INTO world_humans VALUES (?,?,'additional participant')").run(world,"different");
    assert.throws(()=>requireUniqueLocalConversationHuman(db,{humanId:"only-human",bindingId:b.bindingId}),{code:"denied"});
    assert.throws(()=>requireUniqueLocalConversationHuman(db,{humanId:"different",bindingId:b.bindingId}),{code:"denied"});
  }finally{db.close();}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../core/db.ts";
import { createWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import { bindChiefConversation } from "./fixtures/chief.ts";
import { enrollmentPlan,applyEnrollment } from "../scripts/runtime-enroll.ts";
test("Operator review creates no Authority and pins account admission to the reviewed Sessions/Chat",()=>{
 const db=openDatabase(":memory:");try{
  const world=createWorld(db,"review fixture","test only"),store=new SemanticStore(db,world);
  const human=store.createHuman("Human","fixture"),chief=store.registerNode("Chief"),target=store.registerNode("Codex");
  for(const id of [chief,target])db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active','now')").run(id+'-session',id,'fixture:'+id);
  bindChiefConversation(db,{kind:"human",id:human},{projectSpaceId:"fixture",projectRef:"fixture",chiefNodeId:chief,frontendKind:"chatgpt-web",conversationRef:"https://chatgpt.com/c/exact"});
  const plan=enrollmentPlan(db,chief,target);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM external_identities").get()!.n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM intents").get()!.n,0);
  assert.throws(()=>applyEnrollment(db,plan,"yes"),/review not confirmed/);
  const applied=applyEnrollment(db,plan,"ADMIT");
  assert.equal(store.currentIntent(applied.intentId).state,"CURRENT");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM grants").get()!.n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks").get()!.n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM presence_accounts").get()!.n,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM frontend_accounts").get()!.n,1);
  const second=enrollmentPlan(db,chief,target);
  db.prepare("UPDATE chief_conversations SET state='retired'").run();
  assert.throws(()=>applyEnrollment(db,second,"ADMIT"),/changed since Human review/);
 }finally{db.close();}
});

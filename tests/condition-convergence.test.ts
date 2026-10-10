import {test} from "node:test";
import assert from "node:assert/strict";
import {openDatabase} from "../core/db.ts";
import {projectCondition, type ConditionEvidence, type ConditionSubject} from "../core/condition.ts";
import {probeHostHealth} from "../core/host-health.ts";
import {ExternalMcpClientHythe} from "../hythes/external-mcp-client.ts";
import type {Hythe} from "../hythes/types.ts";

const edge:ConditionSubject={kind:"edge",ref:"chatgpt",generation:"gateway-7"};
const conversation:ConditionSubject={kind:"conversation",ref:"chatgpt://exact-chat",generation:"binding-4"};
const host:ConditionSubject={kind:"host",ref:"worker-session",generation:"owner-3"};
function observation(subject:ConditionSubject, evidenceClass:ConditionEvidence["evidenceClass"],
 outcome:ConditionEvidence["outcome"], extra:Partial<ConditionEvidence>={}):ConditionEvidence {
 return {subject,evidenceClass,outcome,observedAt:"2026-10-09T10:00:00.000Z",
  validUntil:"2026-10-09T10:01:00.000Z",source:"fixture:probe",
  evidenceRef:"fixture:observation-1",...extra};
}
const current=Date.parse("2026-10-09T10:00:15.000Z");

test("G1 condition projection never promotes configuration, edge ingress or wrong generation to exact Chat Presence",()=>{
 assert.equal(projectCondition(edge,observation(edge,"CONFIGURED_BINDING","AVAILABLE"),current).state,"UNKNOWN");
 assert.equal(projectCondition(edge,observation(edge,"AUTHENTICATED_INGRESS","AVAILABLE"),current).state,"AVAILABLE");
 assert.equal(projectCondition(conversation,observation(edge,"AUTHENTICATED_INGRESS","AVAILABLE"),current).state,"UNKNOWN");
 assert.equal(projectCondition(conversation,observation(conversation,"EXACT_CONVERSATION","AVAILABLE"),current).state,"AVAILABLE");
 assert.equal(projectCondition(conversation,observation({...conversation,generation:"old"},"EXACT_CONVERSATION","AVAILABLE"),current).state,"UNKNOWN");
 assert.equal(projectCondition(edge,observation(edge,"AUTHENTICATED_INGRESS","AVAILABLE"),current+60000).state,"STALE");
 assert.equal(projectCondition(host,undefined,current).state,"UNKNOWN");
});
test("G1 timeout and negative observation never establish irreversible resource loss",()=>{
 for(const outcome of ["NEGATIVE","TIMEOUT","ERROR","TERMINATED"] as const)
  assert.equal(projectCondition(host,observation(host,outcome==="TERMINATED"?"OWNER_TERMINATION":"HOST_LOCATOR",outcome),current).state,"UNKNOWN");
 const proved=observation(host,"OWNER_TERMINATION","TERMINATED",{
  ownerTermination:{ownerId:"pid-owner",sessionRef:"worker-session",generation:"owner-3",witnessRef:"owner-exit:exact"},
 });
 assert.equal(projectCondition(host,proved,current).state,"CONFIRMED_LOST");
 assert.equal(projectCondition(host,{...proved,ownerTermination:{...proved.ownerTermination!,generation:"wrong"}},current).state,"UNKNOWN");
 assert.equal(projectCondition(host,{...proved,observedAt:"2026-10-09T11:00:00.000Z"},current).state,"UNKNOWN");
});
test("G1 a false Host probe after previously available health leaves Task and Effect untouched",async()=>{
 const db=openDatabase(":memory:"),at=new Date().toISOString();
 try {
  for(const id of ["owner","worker"]){
   db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(id,id,at);
   db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run(id+"-session",id,id+"-locator",at);
  }
  db.prepare("INSERT INTO tasks VALUES ('work','request','owner','worker','[]','running',NULL,?)").run(at);
  db.prepare("INSERT INTO messages VALUES ('message','request-message','work','owner','worker','worker-session',1,'task','body','sending',NULL,NULL,?)").run(at);
  db.prepare("INSERT INTO task_runs VALUES ('run','work','worker-session','message','running',1,'',?)").run(at);
  db.prepare("INSERT INTO session_health VALUES ('worker-session','available','old',?)").run(at);
  let calls=0;
  const hythe:Hythe={hytheId:"mock",hostKind:"mock",capabilities:()=>["message.receive"],
   canStartTurn:()=>true,locate:async()=>{calls++;return false;},
   async *receive(){},invoke:async()=>({status:"rejected",reason:"not used"})};
  const before=db.prepare("SELECT count(*) n FROM runtime_reconciliations").get()?.n;
  const result=await probeHostHealth(db,new Map([["mock",hythe]]),"worker-session","G1-regression",20);
  assert.equal(calls,1);
  assert.equal(result.state,"unknown");
  assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"unknown");
  assert.deepEqual({...db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id='run'").get()}, {state:"running",turn_open:1});
  assert.equal(db.prepare("SELECT count(*) n FROM runtime_reconciliations").get()?.n,before);
  assert.equal(db.prepare("SELECT count(*) n FROM effect_audit").get()?.n,0);
  const event=db.prepare("SELECT kind,payload FROM events ORDER BY rowid DESC LIMIT 1").get() as {kind:string;payload:string};
  assert.equal(event.kind,"host.health.observed");
  assert.equal(JSON.parse(event.payload).replay,false);
 }finally{db.close();}
});
test("G1 external inbound MCP configuration is not exact conversation Presence",async()=>{
 const external=new ExternalMcpClientHythe("chatgpt",{edgeId:"chatgpt",locatorRef:"gateway-edge://chatgpt"});
 assert.equal(external.canStartTurn(),false);
 assert.equal(await external.locate("gateway-edge://chatgpt"),false);
 assert.equal(await external.locate("foreign"),false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSessionIncarnation, openDatabase, rotateSessionIncarnation, sessionGeneration } from "../core/db.ts";
import { Continuations } from "../core/continuations.ts";
import { inspectHostHealth, probeHostHealth, recoverHost } from "../core/host-health.ts";
import { observeResourceUncertainty, reconcileResourceLoss, recordConfirmedResourceLoss } from "../core/reconciliation.ts";
import { CoreRuntime } from "../core/runtime.ts";
import { compatibilityWorld } from "../core/worlds.ts";
import { SemanticStore } from "../core/semantics.ts";
import type { Hythe } from "../hythes/types.ts";
import { HostLifecycle, type PhysicalHostExit } from "../hythes/lifecycle.ts";
import { readSessionHostCondition } from "../core/condition.ts";
import { EdgeOAuthProvider, type OAuthConfig } from "../hythes/mcp-oauth.ts";

function fixture(withRun=true) {
  const db=openDatabase(":memory:"),at=new Date().toISOString();
  for(const node of ["owner","worker"]) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
    db.prepare("INSERT INTO sessions VALUES (?,?,'mock','mock',?,'active',?)").run(`${node}-session`,node,`mock://${node}`,at);
  }
  if(withRun) {
    db.prepare("INSERT INTO tasks VALUES ('task','request','owner','worker','[]','running',NULL,?)").run(at);
    db.prepare("INSERT INTO messages VALUES ('message','request-message','task','owner','worker','worker-session',1,'task','body','sending','turn-1',NULL,?)").run(at);
    db.prepare("INSERT INTO task_runs VALUES ('run','task','worker-session','message','running',1,'',?)").run(at);
  }
  db.prepare("INSERT INTO session_health VALUES ('worker-session','available','seed',?)").run(at);
  return db;
}

async function witnessedChildExit():Promise<PhysicalHostExit> {
  const lifecycle=new HostLifecycle();let physicalExit:PhysicalHostExit|undefined;
  lifecycle.subscribe(event=>{physicalExit=event.physicalExit;});
  const child=spawn(process.execPath,["-e","process.exit(23)"],{windowsHide:true});
  lifecycle.watchChildExit(child,"fixture child process exited");
  await once(child,"exit");
  if(!physicalExit)throw Error("physical child exit was not witnessed");
  return physicalExit;
}

async function lossProof(db:ReturnType<typeof openDatabase>) {
  return recordConfirmedResourceLoss(db,{sessionId:"worker-session",physicalExit:await witnessedChildExit()});
}

function host(extra:Partial<Hythe>={}) {
  return {hytheId:"mock",hostKind:"mock",capabilities:()=>["message.receive"],canStartTurn:()=>true,
    locate:async()=>{throw Error("Probe must never call locate");},async *receive(){},
    invoke:async()=>({status:"rejected" as const,reason:"unused"}),...extra} as Hythe;
}

test("G2-F1 Host timeout records UNKNOWN and does not call a hidden-start locator",async()=>{
  const db=fixture();try {
    let located=0;
    const h=host({locate:async()=>{located++;return true;}}) as Hythe & {inspectExactHost:(locator:string)=>Promise<boolean>};
    h.inspectExactHost=async()=>await new Promise<boolean>(()=>{});
    const result=await probeHostHealth(db,new Map([["mock",h]]),"worker-session","g2-timeout",5);
    assert.equal(result.state,"unknown");assert.equal(located,0);
    const run=db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id='run'").get() as {state:string;turn_open:number};
    assert.equal(run.state,"running");assert.equal(run.turn_open,1);
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_reconciliations").get()?.n,0);
  } finally {db.close();}
});

test("G2-F2 TCP jitter is a non-terminal Probe observation, not a resource-loss fence",async()=>{
  const db=fixture();try {
    const h=host() as Hythe & {inspectExactHost:(locator:string)=>Promise<boolean>};h.inspectExactHost=async()=>false;
    const result=await probeHostHealth(db,new Map([["mock",h]]),"worker-session","g2-tcp-jitter");
    assert.equal(result.state,"unknown");assert.equal(inspectHostHealth(db,"worker-session").state,"unknown");
    assert.equal(db.prepare("SELECT state FROM task_runs WHERE run_id='run'").get()?.state,"running");
  } finally {db.close();}
});

test("G2-F3 receive stream close remains uncertain and cannot irreversibly fence a turn",async()=>{
  const db=fixture(false),h=host({receive:async function*(){ /* closed stream */ }});
  const runtime=new CoreRuntime(db,new Map([["mock",h]]),undefined,{observationOnly:true});
  try {
    const at=new Date().toISOString();
    db.prepare("INSERT INTO tasks VALUES ('task','request','owner','worker','[]','running',NULL,?)").run(at);
    db.prepare("INSERT INTO messages VALUES ('message','request-message','task','owner','worker','worker-session',1,'task','body','sending','turn-1',NULL,?)").run(at);
    db.prepare("INSERT INTO task_runs VALUES ('run','task','worker-session','message','running',1,'',?)").run(at);
    await runtime.receive("worker-session");
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"unknown");
    assert.equal(db.prepare("SELECT state FROM task_runs WHERE run_id='run'").get()?.state,"running");
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_reconciliations").get()?.n,0);
  } finally {runtime.close();db.close();}
});

test("G2-F4 only a canonical owner/session/incarnation receipt fences a confirmed Host exit",async()=>{
  const db=fixture();try {
    const proof=await lossProof(db);
    assert.throws(()=>reconcileResourceLoss(db,{eventId:"wrong-generation",sessionId:"worker-session",reason:"exit",source:"fixture",
      proof:{...proof,generation:"mock:stale"}}),/generation/);
    assert.throws(()=>reconcileResourceLoss(db,{eventId:"wrong-owner",sessionId:"worker-session",reason:"exit",source:"fixture",
      proof:{...proof,ownerId:"fabricated-owner"}}),/generation/);
    assert.throws(()=>recordConfirmedResourceLoss(db,{sessionId:"worker-session",physicalExit:{receiptId:"forged",pid:1,code:0,signal:null,observedAt:new Date().toISOString()} as PhysicalHostExit}),/witnessed ChildProcess exit/);
    reconcileResourceLoss(db,{eventId:"confirmed-exit",sessionId:"worker-session",reason:"exit",source:"fixture",proof});
    const run=db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id='run'").get() as {state:string;turn_open:number};
    assert.equal(run.state,"uncertain");assert.equal(run.turn_open,0);
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"unavailable");
    assert.equal(readSessionHostCondition(db,"worker-session").state,"CONFIRMED_LOST");
  } finally {db.close();}
});

test("G2 incarnation rejects a stale receipt after same-locator recovery and consumes each receipt once",async()=>{
  const db=fixture();try {
    const old=await lossProof(db),oldGeneration=old.generation;
    rotateSessionIncarnation(db,"worker-session");
    assert.notEqual(sessionGeneration(db,"worker-session"),oldGeneration);
    assert.throws(()=>reconcileResourceLoss(db,{eventId:"cross-era",sessionId:"worker-session",reason:"old exit",source:"fixture",proof:old}),/generation/);
    const current=await lossProof(db);
    reconcileResourceLoss(db,{eventId:"current-exit",sessionId:"worker-session",reason:"current exit",source:"fixture",proof:current});
    assert.throws(()=>reconcileResourceLoss(db,{eventId:"receipt-reuse",sessionId:"worker-session",reason:"duplicate",source:"fixture",proof:current}),/already consumed/);
  } finally {db.close();}
});

test("G2 a watched local child exit is the sole live producer and fences the exact canonical Session",async()=>{
  const db=fixture(),lifecycle=new HostLifecycle();
  const runtime=new CoreRuntime(db,new Map([["mock",host({onLifecycle:listener=>lifecycle.subscribe(listener)})]]),undefined,{observationOnly:true});
  try {
    const child=spawn(process.execPath,["-e","process.exit(24)"],{windowsHide:true});
    lifecycle.watchChildExit(child,"fixture host child exited");
    await once(child,"exit");
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"unavailable");
    assert.equal(db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id='run'").get()?.state,"uncertain");
    assert.equal(db.prepare("SELECT count(*) n FROM trusted_resource_loss_receipts WHERE owner_node_id='worker'").get()?.n,1);
    assert.equal(readSessionHostCondition(db,"worker-session").state,"CONFIRMED_LOST");
  } finally {runtime.close();db.close();}
});

test("G2 stale uncertainty cannot overwrite health from a newer incarnation",()=>{
  const db=fixture(false);try {
    const oldGeneration=currentSessionIncarnation(db,"worker-session")!.incarnation;
    rotateSessionIncarnation(db,"worker-session");
    const now=new Date().toISOString();
    db.prepare("INSERT INTO events VALUES ('new-health','worker','host.health.changed',?,?)").run(JSON.stringify({sessionId:"worker-session",state:"available",source:"fixture",attemptId:"x"}),now);
    db.prepare("UPDATE session_health SET state='available',event_id='new-health',updated_at=? WHERE session_id='worker-session'").run(now);
    const result=observeResourceUncertainty(db,{eventId:"late-stream-close",sessionId:"worker-session",source:"fixture",reason:"late close",incarnation:oldGeneration});
    assert.equal(result.stale,true);
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"available");
  } finally {db.close();}
});

test("G2 late duplicate completion after recovery cannot settle an uncertain Effect",async()=>{
  const db=fixture();try {
    const store=new SemanticStore(db,compatibilityWorld(db));
    const action=store.logicalAction("owner","worker","message.receive","late duplicate fixture");
    db.prepare("INSERT INTO message_actions VALUES ('message',?,?)").run(compatibilityWorld(db),action);
    const attempt=store.attempt(action,"worker-session","message");
    db.prepare("UPDATE effect_attempt_state SET state='uncertain',eligible=0 WHERE attempt_id=?").run(attempt);
    const continuations=new Continuations(db,new Map());
    await assert.rejects(continuations.ingest("worker-session",{observedMessageId:"message",hostRef:"turn-1",outcome:"completed",body:"late duplicate"}),/exact terminal reconciliation/);
    assert.equal(db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id='run'").get()?.state,"running");
    assert.equal(db.prepare("SELECT state FROM effect_attempt_state WHERE attempt_id=?").get(attempt)?.state,"uncertain");
  } finally {db.close();}
});

test("G2-F5 response loss has no late synthetic completion and no replay marker",()=>{
  const db=fixture();try {
    observeResourceUncertainty(db,{eventId:"response-lost",sessionId:"worker-session",source:"g2-response-loss",reason:"response missing"});
    assert.equal(db.prepare("SELECT state FROM task_runs WHERE run_id='run'").get()?.state,"running");
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind LIKE '%completed%'").get()?.n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='runtime.resource_uncertain'").get()?.n,1);
  } finally {db.close();}
});

test("G2-F6 power-loss snapshot recovery preserves an open turn as unknown without fencing or replay",()=>{
  const db=fixture();try {
    new Continuations(db,new Map()).recover();
    assert.equal(db.prepare("SELECT state FROM task_runs WHERE run_id='run'").get()?.state,"running");
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"unknown");
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_reconciliations").get()?.n,0);
  } finally {db.close();}
});

test("G2-F7 duplicate loss notification is idempotent and never manufactures a second message or effect",()=>{
  const db=fixture();try {
    const observation={eventId:"duplicate-notice",sessionId:"worker-session",source:"g2-duplicate",reason:"duplicate transport notice"};
    assert.deepEqual(observeResourceUncertainty(db,observation),observeResourceUncertainty(db,observation));
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE event_id='duplicate-notice'").get()?.n,1);
    assert.equal(db.prepare("SELECT count(*) n FROM messages").get()?.n,1);
  } finally {db.close();}
});

const oauthConfig:OAuthConfig={baseUrl:"http://127.0.0.1:49321",clients:[{edgeId:"fixture-edge",boundNodeId:"fixture-node",clientId:"fixture-client",clientSecret:"fixture-secret",redirectUris:["http://127.0.0.1/callback"]}]};

test("G2-F8 old credential state is not migrated into a valid connector identity",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"sidera-g2-oauth-")),state=join(directory,"oauth.json");
  writeFileSync(state,JSON.stringify({version:0,codes:[],tokens:[{token:"old",clientId:"fixture-client"}]}));
  const provider=new EdgeOAuthProvider(oauthConfig,state);
  await assert.rejects(provider.verifyAccessToken("old"),/Unknown access token/);
});

test("G2-F9 refresh-token reuse revokes the family instead of minting another credential",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"sidera-g2-oauth-")),provider=new EdgeOAuthProvider(oauthConfig,join(directory,"oauth.json"));
  const mint=(provider as unknown as {mintPair:(grant:Record<string,unknown>)=>{access_token:string;refresh_token:string}}).mintPair.bind(provider);
  const pair=mint({clientId:"fixture-client",edgeId:"fixture-edge",boundNodeId:"fixture-node",resource:"http://127.0.0.1:49321/mcp",scopes:["sidera.mcp"],familyId:"fixture-family",expiresAt:Date.now()+60_000});
  const client={client_id:"fixture-client",client_secret:"fixture-secret"} as any;
  await provider.exchangeRefreshToken(client,pair.refresh_token,undefined,new URL("http://127.0.0.1:49321/mcp"));
  await assert.rejects(provider.exchangeRefreshToken(client,pair.refresh_token,undefined,new URL("http://127.0.0.1:49321/mcp")),/already rotated/);
  await assert.rejects(provider.verifyAccessToken(pair.access_token),/revoked/);
});

test("G2 Inspect and Probe cannot start a Host; only an authorized explicit Recover callback can",async()=>{
  const db=fixture();let starts=0;
  try {
    assert.equal(inspectHostHealth(db,"worker-session").sessionId,"worker-session");
    await assert.rejects(recoverHost({authorized:false,sessionId:"worker-session",recover:async()=>++starts}),/Authorized Recover/);
    assert.equal(starts,0);assert.equal(await recoverHost({authorized:true,sessionId:"worker-session",recover:async()=>++starts}),1);
  } finally {db.close();}
});

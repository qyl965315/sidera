import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { Continuations } from "../core/continuations.ts";
import { inspectHostHealth, probeHostHealth, recoverHost } from "../core/host-health.ts";
import { observeResourceUncertainty, reconcileResourceLoss, recordConfirmedResourceLoss } from "../core/reconciliation.ts";
import { CoreRuntime } from "../core/runtime.ts";
import type { Hythe } from "../hythes/types.ts";
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

function lossProof(db:ReturnType<typeof openDatabase>,receiptId:string) {
  return recordConfirmedResourceLoss(db,{receiptId,ownerId:"fixture-host-owner",sessionId:"worker-session",
    generation:"mock:mock://worker",source:"fixture.confirmed_physical_exit",reason:"fixture physical Host exit"});
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

test("G2-F4 only an owner/session/generation/trusted-receipt proof fences a confirmed Host exit",()=>{
  const db=fixture();try {
    const proof=lossProof(db,"g2-confirmed-exit");
    assert.throws(()=>reconcileResourceLoss(db,{eventId:"wrong-generation",sessionId:"worker-session",reason:"exit",source:"fixture",
      proof:{...proof,generation:"mock:stale"}}),/generation/);
    reconcileResourceLoss(db,{eventId:"confirmed-exit",sessionId:"worker-session",reason:"exit",source:"fixture",proof});
    const run=db.prepare("SELECT state,turn_open FROM task_runs WHERE run_id='run'").get() as {state:string;turn_open:number};
    assert.equal(run.state,"uncertain");assert.equal(run.turn_open,0);
    assert.equal(db.prepare("SELECT state FROM session_health WHERE session_id='worker-session'").get()?.state,"unavailable");
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

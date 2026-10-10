import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,readFileSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { CoreRuntime } from "./fixtures/execution.ts";
import { grantSelf } from "./fixtures/authority.ts";
import { reconcileSpecs } from "../core/onboarding.ts";
import type { Hythe } from "../hythes/types.ts";
import { buildEdge, startGatewayHttp, type GatewayWorkspaceConfig } from "../hythes/mcp-gateway.ts";
import { EdgeOAuthProvider } from "../hythes/mcp-oauth.ts";
import { ExternalMcpClientHythe } from "../hythes/external-mcp-client.ts";

const CHAT_NODE = "b4806f5b-71bd-4894-b4a7-22d93d2c17c2";
const SPARK_NODE = "7747ef76-1e9f-4d04-8832-b6d6f0a6c7ef";
const CHAT_SESSION = "oauth-chat-session";
const SPARK_SESSION = "oauth-spark-session";
const CHAT_TOKEN = "oauth-chat-core-token";
const SPARK_TOKEN = "oauth-spark-core-token";
const REDIRECT = "https://gemini.example/oauth/callback";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function externalSpec(nodeId: string, sessionId: string, edgeId: string) {
  return { nodeId, displayName: edgeId, sessionId, locatorRef: `gateway-edge://${edgeId}`,
    hostKind: "external-mcp-client", hytheId: `external-${edgeId}`, coreToken: nodeId === CHAT_NODE ? CHAT_TOKEN : SPARK_TOKEN,
    options: { edgeId, gatewayEndpoint: "https://gateway.example/mcp" } };
}

function fixture() {
  const project = mkdtempSync(join(tmpdir(), "sidera-oauth-"));
  const db = openDatabase(join(project, "sidera.sqlite"));
  for (const [nodeId, name, sessionId] of [[CHAT_NODE, "Gemini Chat", CHAT_SESSION], [SPARK_NODE, "Gemini Spark", SPARK_SESSION]] as const) {
    db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(nodeId, name, new Date().toISOString());
    grantSelf(db, nodeId);
  }
  recordWorld(db, "nodes", CHAT_NODE);
  const hythe: Hythe = { hytheId: "fixture", hostKind: "fixture", capabilities: () => ["message.receive"],
    locate: async () => true, invoke: async () => ({ status: "accepted", hostRef: "fixture" }), async *receive() {} };
  const runtime = new CoreRuntime(db, new Map([["fixture", hythe]]), undefined, { observationOnly: true });
  const rpc = new CoreRpcServer(db, runtime, new Map([["fixture", hythe]]),
    { authenticate: token => {
      if (token === CHAT_TOKEN) return { kind: "node", nodeId: CHAT_NODE, sessionId: CHAT_SESSION };
      if (token === SPARK_TOKEN) return { kind: "node", nodeId: SPARK_NODE, sessionId: SPARK_SESSION };
      return null;
    } }, undefined, project);
  const chatHost = new ExternalMcpClientHythe("external-gemini-chat",
    { edgeId: "gemini-chat", locatorRef: "gateway-edge://gemini-chat" });
  const sparkHost = new ExternalMcpClientHythe("external-gemini-spark",
    { edgeId: "gemini-spark", locatorRef: "gateway-edge://gemini-spark" });
  reconcileSpecs(db, [externalSpec(CHAT_NODE, CHAT_SESSION, "gemini-chat") as never,
    externalSpec(SPARK_NODE, SPARK_SESSION, "gemini-spark") as never],
    new Map([["external-gemini-chat", chatHost], ["external-gemini-spark", sparkHost]]));
  return { project, db, rpc, close: async () => { runtime.close(); await rpc.close(); db.close(); } };
}

interface Harness {
  oauth: EdgeOAuthProvider;
  listener: { port: number | null; close(): Promise<void> };
  chatClient: { clientId: string; clientSecret: string };
  sparkClient: { clientId: string; clientSecret: string };
  base: string;
  resource: string;
}

async function harness(options: { accessTokenTtlSeconds?: number; publicClient?:boolean; publicOwnerApproval?:boolean; now?:()=>number } = {}): Promise<Harness> {
  const f = fixture();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const chatClient = { clientId: "sidera-gemini-chat-test", clientSecret: options.publicClient ? "" : randomBytes(24).toString("base64url") };
  const sparkClient = { clientId: "sidera-gemini-spark-test", clientSecret: options.publicClient ? "" : randomBytes(24).toString("base64url") };
  const oauth = new EdgeOAuthProvider({ baseUrl: base, accessTokenTtlSeconds: options.accessTokenTtlSeconds,
    clients: [
      { edgeId: "gemini-chat", boundNodeId: CHAT_NODE, clientId: chatClient.clientId,
        clientSecret: chatClient.clientSecret, publicPkceOwnerApproval:options.publicOwnerApproval, redirectUris: [REDIRECT] },
      { edgeId: "gemini-spark", boundNodeId: SPARK_NODE, clientId: sparkClient.clientId,
        clientSecret: sparkClient.clientSecret, publicPkceOwnerApproval:options.publicOwnerApproval, redirectUris: [REDIRECT] },
    ] }, join(f.project, "oauth-state.json"), { now: options.now });
  const corePort = await f.rpc.listen();
  const config: GatewayWorkspaceConfig = { version: 1, corePort, gatewayPort: port, host: "127.0.0.1",
    publicBaseUrl: base, edges: [] };
  const chatEdge = buildEdge(config, { id: "gemini-chat", boundNodeId: CHAT_NODE, coreToken: CHAT_TOKEN,
    authMode: "oauth", oauth: { clientId: chatClient.clientId, clientSecret: chatClient.clientSecret,
      publicPkceOwnerApproval:options.publicOwnerApproval, redirectUris: [REDIRECT] } });
  const sparkEdge = buildEdge(config, { id: "gemini-spark", boundNodeId: SPARK_NODE, coreToken: SPARK_TOKEN,
    authMode: "oauth", oauth: { clientId: sparkClient.clientId, clientSecret: sparkClient.clientSecret,
      publicPkceOwnerApproval:options.publicOwnerApproval, redirectUris: [REDIRECT] } });
  const listener = await startGatewayHttp([chatEdge, sparkEdge], { port, host: "127.0.0.1", oauth,
    localOwnerApprovalPort:options.publicOwnerApproval?0:undefined });
  const close = async () => { await listener.close(); await f.close(); };
  return { oauth, listener: { ...listener, close }, chatClient, sparkClient,
    base, resource: `${base}/mcp`, };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function authorize(harness: Harness, clientId: string, challenge: string,
  options: { redirectUri?: string; resource?: string } = {}) {
  const url = new URL(`${harness.base}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", options.redirectUri ?? REDIRECT);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "state-123");
  url.searchParams.set("resource", options.resource ?? harness.resource);
  return fetch(url, { redirect: "manual" });
}

async function tokenRequest(harness: Harness, body: Record<string, string>) {
  return fetch(`${harness.base}/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString() });
}

async function mint(harness: Harness, client: { clientId: string; clientSecret: string }) {
  const { verifier, challenge } = pkce();
  const authorized = await authorize(harness, client.clientId, challenge);
  assert.equal(authorized.status, 302);
  const location = new URL(authorized.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  const response = await tokenRequest(harness, { grant_type: "authorization_code", code,
    code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.clientId, client_secret: client.clientSecret });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body) as { access_token: string;refresh_token:string; token_type: string; expires_in: number };
}

async function mcpCall(resource: string, accessToken: string) {
  const client = new Client({ name: "gemini-oauth-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  try {
    const result = await client.callTool({ name: "sidera_invoke",
      arguments: { operation: "session.active", arguments: {} } });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as
      { nodeId?: string; sessionId?: string; result?: { nodeId?: string; sessionId?: string } };
    return { nodeId: payload.nodeId ?? payload.result?.nodeId,
      sessionId: payload.sessionId ?? payload.result?.sessionId };
  } finally { await client.close(); }
}

test("O-T01 protected-resource and authorization-server metadata are discoverable", async () => {
  const h = await harness();
  try {
    const prm = await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(prm.status, 200);
    const resource = await prm.json() as { resource: string; authorization_servers: string[] };
    assert.equal(resource.resource, h.resource, "the protected resource is this Gateway's MCP endpoint");
    const normalize = (value: string) => value.replace(/\/$/, "");
    assert.deepEqual(resource.authorization_servers.map(normalize), [h.base]);
    const asm = await fetch(`${h.base}/.well-known/oauth-authorization-server`);
    assert.equal(asm.status, 200);
    const metadata = await asm.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string;
      code_challenge_methods_supported: string[]; response_types_supported: string[] };
    assert.equal(normalize(metadata.issuer), h.base);
    assert.equal(normalize(metadata.authorization_endpoint), `${h.base}/authorize`.replace(/\/$/, ""));
    assert.equal(metadata.token_endpoint, `${h.base}/token`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.response_types_supported, ["code"]);
    const unauthorized = await fetch(h.resource, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /resource_metadata=/,
      "a 401 must point the client at the protected-resource metadata");
  } finally { await h.listener.close(); }
});

test("O-T02 Gemini Chat and Gemini Spark have independent client credentials", async () => {
  const h = await harness();
  try {
    assert.notEqual(h.chatClient.clientId, h.sparkClient.clientId);
    assert.notEqual(h.chatClient.clientSecret, h.sparkClient.clientSecret);
    const summary = h.oauth.summary() as { clients: Array<{ edgeId: string; boundNodeId: string; clientId: string }> };
    const chat = summary.clients.find(client => client.edgeId === "gemini-chat")!;
    const spark = summary.clients.find(client => client.edgeId === "gemini-spark")!;
    assert.equal(chat.boundNodeId, CHAT_NODE);
    assert.equal(spark.boundNodeId, SPARK_NODE);
    assert.notEqual(chat.clientId, spark.clientId);
    assert.ok(!JSON.stringify(h.oauth.summary()).includes(CHAT_TOKEN), "no Core credential may appear in OAuth state");
  } finally { await h.listener.close(); }
});

test("O-T03 an unregistered redirect URI is refused", async () => {
  const h = await harness();
  try {
    const { challenge } = pkce();
    const response = await authorize(h, h.chatClient.clientId, challenge,
      { redirectUri: "https://attacker.example/callback" });
    assert.equal(response.status, 400, "pre-redirect validation must not redirect to an unregistered URI");
  } finally { await h.listener.close(); }
});

test("O-T04 a wrong client secret is refused and no token is issued", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = pkce();
    const authorized = await authorize(h, h.chatClient.clientId, challenge);
    const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
    const response = await tokenRequest(h, { grant_type: "authorization_code", code,
      code_verifier: verifier, redirect_uri: REDIRECT, client_id: h.chatClient.clientId,
      client_secret: "wrong-secret" });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /client_secret|Invalid/i);
  } finally { await h.listener.close(); }
});

test("O-T05 PKCE S256 is required and a mismatched verifier is refused", async () => {
  const h = await harness();
  try {
    // Only S256 is accepted; a plain challenge method must be refused.
    const { challenge } = pkce();
    const plainMethod = await fetch(`${h.base}/authorize?response_type=code&client_id=${h.chatClient.clientId}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}`
      + `&code_challenge_method=plain&state=s`, { redirect: "manual" });
    assert.equal(plainMethod.status, 302, "a post-redirect error must be reported to the registered URI");
    const plainError = new URL(plainMethod.headers.get("location")!);
    assert.equal(plainError.origin + plainError.pathname, REDIRECT);
    assert.equal(plainError.searchParams.get("error"), "invalid_request");
    assert.match(plainError.searchParams.get("error_description") ?? "", /code_challenge_method|S256/i);
    const { challenge: goodChallenge } = pkce();
    const authorized = await authorize(h, h.chatClient.clientId, goodChallenge);
    const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
    const wrongVerifier = randomBytes(32).toString("base64url");
    const response = await tokenRequest(h, { grant_type: "authorization_code", code,
      code_verifier: wrongVerifier, redirect_uri: REDIRECT, client_id: h.chatClient.clientId,
      client_secret: h.chatClient.clientSecret });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /verifier|challenge/i);
  } finally { await h.listener.close(); }
});

test("O-T06 an OAuth access token expires", async () => {
  let now = Date.now();
  const h = await harness({ accessTokenTtlSeconds: 1, now: () => now });
  try {
    const minted = await mint(h, h.chatClient);
    assert.equal(minted.expires_in, 1);
    const valid = await h.oauth.verifyAccessToken(minted.access_token);
    assert.equal(valid.clientId, h.chatClient.clientId);
    now += 1200;
    await assert.rejects(() => h.oauth.verifyAccessToken(minted.access_token), /expired/i,
      "an expired token must not authenticate");
    const response=await fetch(h.base+"/mcp",{method:"POST",headers:{Authorization:"Bearer "+minted.access_token,"Content-Type":"application/json"},body:"{}"});
    assert.equal(response.status,401,"expired OAuth must not become HTTP 500");
    assert.match(response.headers.get("www-authenticate")??"",/Bearer.*resource_metadata/);
  } finally { await h.listener.close(); }
});

test("O-T07 each access token resolves to its own exact Node", async () => {
  const h = await harness();
  try {
    const chat = await mint(h, h.chatClient);
    const spark = await mint(h, h.sparkClient);
    assert.equal((await mcpCall(h.resource, chat.access_token)).nodeId, CHAT_NODE);
    assert.equal((await mcpCall(h.resource, spark.access_token)).nodeId, SPARK_NODE);
    const chatSession = await mcpCall(h.resource, chat.access_token);
    const sparkSession = await mcpCall(h.resource, spark.access_token);
    assert.notEqual(chatSession.sessionId, sparkSession.sessionId);
  } finally { await h.listener.close(); }
});

test("O-T08 a token cannot swap Node identity, and unknown tokens are refused before Core", async () => {
  const h = await harness();
  try {
    const chat = await mint(h, h.chatClient);
    const spark = await mint(h, h.sparkClient);
    // The tokens are distinct and each maps to one edge only.
    assert.notEqual(chat.access_token, spark.access_token);
    assert.equal(h.oauth.clientForToken(chat.access_token)!.edgeId, "gemini-chat");
    assert.equal(h.oauth.clientForToken(spark.access_token)!.edgeId, "gemini-spark");
    // A forged token is not a known token, so it never reaches Core.
    const forged = await fetch(h.resource, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${randomBytes(24).toString("base64url")}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(forged.status, 401);
    // A token minted by the Chat client cannot authenticate as the Spark client.
    const crossUse = h.oauth.clientForToken(chat.access_token)!;
    assert.equal(crossUse.edgeId, "gemini-chat");
    assert.notEqual(crossUse.boundNodeId, SPARK_NODE);
  } finally { await h.listener.close(); }
});

test("O-T09 the Gateway exposes no Core credential to the product side", async () => {
  const h = await harness();
  try {
    const minted = await mint(h, h.chatClient);
    const serialized = JSON.stringify(minted);
    assert.ok(!serialized.includes(CHAT_TOKEN), "token response must not carry a Core credential");
    assert.ok(!serialized.includes(SPARK_TOKEN));
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = await (await fetch(`${h.base}${path}`)).text();
      assert.ok(!body.includes(CHAT_TOKEN) && !body.includes(SPARK_TOKEN), `${path} must not expose Core credentials`);
    }
    const summary = JSON.stringify(h.oauth.summary());
    assert.ok(!summary.includes(CHAT_TOKEN) && !summary.includes(SPARK_TOKEN));
    assert.ok(!summary.includes(h.chatClient.clientSecret), "the status summary must not print the client secret");
  } finally { await h.listener.close(); }
});

test("O-T10 one OAuth client may register multiple exact redirect URIs", () => {
  const state = join(mkdtempSync(join(tmpdir(), "sidera-oauth-multi-redirect-")), "oauth-state.json");
  const second = "https://gemini.example/oauth/callback-v2";
  const oauth = new EdgeOAuthProvider({ baseUrl: "https://gateway.example",
    clients: [{ edgeId: "gemini-chat", boundNodeId: CHAT_NODE,
      clientId: "sidera-gemini-chat-multi-redirect", clientSecret: randomBytes(24).toString("base64url"),
      redirectUris: [REDIRECT, second] }] }, state);
  const summary = oauth.summary() as { clients: Array<{ redirectUris: string[] }> };
  assert.deepEqual(summary.clients[0]!.redirectUris, [REDIRECT, second]);
});

test("O-T11 duplicate OAuth client_id across distinct edges is refused", () => {
  const state = join(mkdtempSync(join(tmpdir(), "sidera-oauth-duplicate-client-")), "oauth-state.json");
  const clientId = "sidera-duplicate-client";
  assert.throws(() => new EdgeOAuthProvider({ baseUrl: "https://gateway.example",
    clients: [
      { edgeId: "gemini-chat", boundNodeId: CHAT_NODE, clientId,
        clientSecret: randomBytes(24).toString("base64url"), redirectUris: [REDIRECT] },
      { edgeId: "gemini-spark", boundNodeId: SPARK_NODE, clientId,
        clientSecret: randomBytes(24).toString("base64url"),
        redirectUris: ["https://gemini.example/oauth/spark"] },
    ] }, state), /Duplicate OAuth client_id/);
});

test('O-T12 confidential PKCE metadata, bound rotating refresh, exact redirects and durable reconnect',async()=>{
 const h=await harness();try{
 const metadata=await fetch(h.base+'/.well-known/oauth-authorization-server').then(r=>r.json());
 assert.deepEqual(metadata.grant_types_supported,['authorization_code','refresh_token']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['client_secret_post']);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
 const minted=await mint(h,h.chatClient);assert.ok(minted.refresh_token);assert.equal((await mcpCall(h.resource,minted.access_token)).nodeId,CHAT_NODE);
 const refresh=await tokenRequest(h,{grant_type:'refresh_token',refresh_token:'not-issued',client_id:h.chatClient.clientId,client_secret:h.chatClient.clientSecret});assert.equal(refresh.status,400);
 const invalid=await fetch(h.base+'/authorize?'+new URLSearchParams({client_id:h.chatClient.clientId,response_type:'code',redirect_uri:'https://unregistered.example/callback',code_challenge:pkce().challenge,code_challenge_method:'S256'}),{redirect:'manual'});assert.equal(invalid.headers.get('location'),null);assert.equal(invalid.status,400);
 const restarted=new EdgeOAuthProvider(h.oauth.config,(h.oauth as unknown as {statePath:string}).statePath);assert.equal((await restarted.verifyAccessToken(minted.access_token)).clientId,h.chatClient.clientId);
 }finally{await h.listener.close();}
});


test("O-T13 HTTP refresh survives access expiry, retains exact Node identity and rejects scope/client changes and replay",async()=>{
 let now=Date.now()+60_000;const h=await harness({accessTokenTtlSeconds:1,now:()=>now});
 try{
  const minted=await mint(h,h.chatClient);assert.ok(minted.refresh_token);now+=1200;
  const body={grant_type:"refresh_token",refresh_token:minted.refresh_token,client_id:h.chatClient.clientId,client_secret:h.chatClient.clientSecret,resource:h.resource};
  assert.equal((await tokenRequest(h,{...body,scope:"sidera.mcp forbidden"})).status,400);
  assert.equal((await tokenRequest(h,{...body,client_id:h.sparkClient.clientId,client_secret:h.sparkClient.clientSecret})).status,400);
  const rotated=await tokenRequest(h,body);assert.equal(rotated.status,200);
  const pair=await rotated.json() as {access_token:string;refresh_token:string};assert.ok(pair.refresh_token!==minted.refresh_token);
  assert.equal((await mcpCall(h.resource,pair.access_token)).nodeId,CHAT_NODE);
  const statePath=(h.oauth as unknown as {statePath:string}).statePath;
  const restarted=new EdgeOAuthProvider(h.oauth.config,statePath,{now:()=>now});
  assert.equal((await restarted.verifyAccessToken(pair.access_token)).clientId,h.chatClient.clientId);
  const raw=readFileSync(statePath,"utf8");assert.ok(!raw.includes(minted.refresh_token)&&!raw.includes(pair.refresh_token),"refresh secrets are stored only as digests");
  assert.equal((await tokenRequest(h,body)).status,400,"a rotated refresh token cannot be replayed");
  await assert.rejects(h.oauth.verifyAccessToken(pair.access_token),/revoked/);
 }finally{await h.listener.close();}
});

test("O-T14 persisted credentials cannot follow a rebound Node and legacy token receipts are retained without guessing their Node",async()=>{
 const h=await harness();try{
  const minted=await mint(h,h.chatClient),statePath=(h.oauth as unknown as {statePath:string}).statePath;
  const rebound=new EdgeOAuthProvider({...h.oauth.config,clients:h.oauth.config.clients.map(c=>c.clientId===h.chatClient.clientId?{...c,boundNodeId:SPARK_NODE}:c)},statePath);
  await assert.rejects(rebound.verifyAccessToken(minted.access_token),/binding changed/);
  const client=(await rebound.clientsStore.getClient(h.chatClient.clientId))!;
  await assert.rejects(rebound.exchangeRefreshToken(client,minted.refresh_token),/binding/);
  const persisted=JSON.parse(readFileSync(statePath,"utf8"));
  persisted.tokens.push({token:"legacy-token",clientId:h.chatClient.clientId,edgeId:"gemini-chat",resource:h.resource,scopes:["sidera.mcp"],expiresAt:Date.now()+60000});
  writeFileSync(statePath,JSON.stringify(persisted));
  const legacy=new EdgeOAuthProvider(h.oauth.config,statePath);
  await assert.rejects(legacy.verifyAccessToken("legacy-token"),/not recorded/);
  assert.ok(readFileSync(statePath,"utf8").includes("legacy-token"));
 }finally{await h.listener.close();}
});

test("O-T15 public PKCE cannot mint Node credentials in a flow without resource-owner authentication",async()=>{
 const h=await harness({publicClient:true});try{
  const response=await authorize(h,h.chatClient.clientId,pkce().challenge);
  assert.equal(response.status,400);assert.equal(response.headers.get("location"),null);
  assert.match(JSON.stringify(await response.json()),/resource-owner authentication/);
  assert.equal(h.oauth.summary().activeAccessTokens,0);
 }finally{await h.listener.close();}
});

test("O-T17 existing public PKCE client requires exact on-device consent before token issuance",async()=>{
 const h=await harness({publicOwnerApproval:true});try{
  const discovery=await (await fetch(h.base+"/.well-known/oauth-authorization-server")).json() as {token_endpoint_auth_methods_supported:string[]};
  assert.ok(discovery.token_endpoint_auth_methods_supported.includes("none"));
  const {verifier,challenge}=pkce();
  const start=await authorize(h,h.chatClient.clientId,challenge);
  assert.equal(start.status,200);assert.equal(start.headers.get("location"),null,"no automatic authorization code");
  const html=await start.text();const match=html.match(/href="(http:\/\/127\.0\.0\.1:\d+\/\?request=[a-f0-9]+)"/);
  assert.ok(match,"browser provides a local-only approval address");
  const ownerUrl=new URL(match![1]!);
  const id=ownerUrl.searchParams.get("request")!;
  const early=await fetch(h.base+"/oauth/owner-complete?request="+id,{redirect:"manual"});
  assert.equal(early.status,409,"public request cannot finish without Human approval");
  const local=await fetch(ownerUrl);
  assert.equal(local.status,200);
  const consent=await local.text();
  const csrf=consent.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const postBody=new URLSearchParams({request:id,csrf:csrf!});
  const target=new URL("/approve",ownerUrl);
  const fake=await fetch(target,{method:"POST",headers:{origin:"https://attacker.example",
    "content-type":"application/x-www-form-urlencoded"},body:postBody});
  assert.equal(fake.status,403,"remote-site CSRF cannot approve local authorization");
  const approve=await fetch(target,{method:"POST",headers:{origin:ownerUrl.origin,
    "content-type":"application/x-www-form-urlencoded"},body:postBody});
  assert.equal(approve.status,200);
  const redirected=await fetch(h.base+"/oauth/owner-complete?request="+id,{redirect:"manual"});
  assert.equal(redirected.status,302);
  const callback=new URL(redirected.headers.get("location")!);
  assert.equal(callback.origin+callback.pathname,REDIRECT);
  assert.equal(callback.searchParams.get("state"),"state-123");
  const code=callback.searchParams.get("code")!;
  const minted=await tokenRequest(h,{grant_type:"authorization_code",client_id:h.chatClient.clientId,
    code,code_verifier:verifier,redirect_uri:REDIRECT});
  const text=await minted.text();assert.equal(minted.status,200,text);
  const tokens=JSON.parse(text) as {access_token:string;refresh_token:string};
  assert.equal((await mcpCall(h.resource,tokens.access_token)).nodeId,CHAT_NODE);
  assert.ok(tokens.refresh_token);
  const replay=await fetch(h.base+"/oauth/owner-complete?request="+id,{redirect:"manual"});
  assert.equal(replay.status,409,"owner approval cannot be replayed");
  assert.equal((h.oauth.summary() as {activeAccessTokens:number}).activeAccessTokens,1);
 }finally{await h.listener.close();}
});

test("O-T16 a refresh narrowed to no MCP scope cannot enter the Gateway",async()=>{
 const h=await harness();try{
  const minted=await mint(h,h.chatClient);
  assert.equal((await mcpCall(h.resource,minted.access_token)).nodeId,CHAT_NODE);
  const registered=(await h.oauth.clientsStore.getClient(h.chatClient.clientId))!;
  const narrowed=await h.oauth.exchangeRefreshToken(registered,minted.refresh_token,[]);
  assert.deepEqual((await h.oauth.verifyAccessToken(narrowed.access_token)).scopes,[]);
  const response=await fetch(h.resource,{method:"POST",
   headers:{"content-type":"application/json",authorization:"Bearer "+narrowed.access_token},
   body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
  assert.equal(response.status,403);
  assert.match(response.headers.get("www-authenticate")??"",/insufficient_scope/);
  assert.match(response.headers.get("www-authenticate")??"",/scope="sidera.mcp"/);
  assert.equal((await response.json() as {error:string}).error,"insufficient_scope");
 }finally{await h.listener.close();}
});

test("O-T18 browser consent sets a safe referrer policy and rejects forged or null Origin", async()=>{
 const h=await harness({publicOwnerApproval:true});
 try {
  for(const scenario of [
    {name:"browser-null-origin",headers:{origin:"null","sec-fetch-site":"same-origin"},allow:false},
    {name:"browser-omitted-origin",headers:{"sec-fetch-site":"same-origin"},allow:false},
    {name:"explicit-foreign-origin",headers:{origin:"https://attacker.example","sec-fetch-site":"same-origin"},allow:false},
    {name:"cross-site-fetch",headers:{origin:"null","sec-fetch-site":"cross-site"},allow:false},
  ] as Array<{name:string;headers:Record<string,string>;allow:boolean}>){
    const start=await authorize(h,h.chatClient.clientId,pkce().challenge);
    assert.equal(start.status,200,scenario.name);
    const html=await start.text();
    const match=html.match(/href="(http:\/\/127\.0\.0\.1:\d+\/\?request=[a-f0-9]+)"/);
    assert.ok(match,scenario.name);
    const ownerUrl=new URL(match![1]!);
    const ownerPage=await fetch(ownerUrl);
    assert.equal(ownerPage.headers.get("referrer-policy"),"same-origin",scenario.name);
    const consent=await ownerPage.text();
    const csrf=consent.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf,scenario.name);
    const body=new URLSearchParams({request:ownerUrl.searchParams.get("request")!,csrf:csrf!});
    const response=await fetch(new URL("/approve",ownerUrl),{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",...scenario.headers},body});
    assert.equal(response.status,scenario.allow?200:403,scenario.name);
    const id=ownerUrl.searchParams.get("request")!;
    const state=await (await fetch(h.base+"/oauth/owner-status?request="+id)).json() as {status:string};
    assert.equal(state.status,scenario.allow?"APPROVED":"PENDING",scenario.name);
    if(!scenario.allow){
      const retry=await fetch(new URL("/approve",ownerUrl),{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",
          origin:ownerUrl.origin,"sec-fetch-site":"same-origin"},body});
      assert.equal(retry.status,200,scenario.name+" same-origin retry");
    }
    const completed=await fetch(h.base+"/oauth/owner-complete?request="+id,{redirect:"manual"});
    assert.equal(completed.status,302,scenario.name+" grants a code only after approval");
  }
 }finally{await h.listener.close();}
});

test("O-T19 persisted authorization codes and owner requests retain their exact resource audience", async()=>{
 const h=await harness();
 try {
  const started=await authorize(h,h.chatClient.clientId,pkce().challenge);
  assert.equal(started.status,302);
  const code=new URL(started.headers.get("location")!).searchParams.get("code")!;
  const statePath=(h.oauth as unknown as {statePath:string}).statePath;
  const moved=new EdgeOAuthProvider({...h.oauth.config,baseUrl:"https://another-gateway.example"},statePath);
  const client=(await moved.clientsStore.getClient(h.chatClient.clientId))!;
  await assert.rejects(moved.challengeForAuthorizationCode(client,code),/audience/);
  await assert.rejects(moved.exchangeAuthorizationCode(client,code,undefined,REDIRECT),/audience/);
  assert.equal(moved.summary().activeAccessTokens,0);
 } finally {await h.listener.close();}

 const pub=await harness({publicOwnerApproval:true});
 try {
  for(const approved of [false,true]){
   const started=await authorize(pub,pub.chatClient.clientId,pkce().challenge);
   const owner=(await started.text()).match(/href="(http:\/\/127\.0\.0\.1:\d+\/\?request=[a-f0-9]+)"/);
   assert.ok(owner);
   const id=new URL(owner[1]!).searchParams.get("request")!;
   // Synthetic approval in an isolated fixture, never a live Human decision.
   if(approved)assert.equal(pub.oauth.approveOwnerRequest(id),true);
   const statePath=(pub.oauth as unknown as {statePath:string}).statePath;
   const same=new EdgeOAuthProvider(pub.oauth.config,statePath);
   assert.equal(same.ownerApprovalStatus(id),approved?"APPROVED":"PENDING");
   const changed=new EdgeOAuthProvider({...pub.oauth.config,baseUrl:"https://another-gateway.example"},statePath);
   assert.equal(changed.ownerApprovalStatus(id),"MISSING");
   assert.equal(changed.pendingOwnerRequest(id),null);
   assert.equal(changed.approveOwnerRequest(id),false);
   assert.equal(changed.completeOwnerRequest(id),null);
   if(approved){
    const completed=same.completeOwnerRequest(id)!;
    assert.ok(completed);
    const restarted=new EdgeOAuthProvider(pub.oauth.config,statePath);
    const client=(await restarted.clientsStore.getClient(pub.chatClient.clientId))!;
    assert.ok(await restarted.challengeForAuthorizationCode(client,completed.code));
    const pair=await restarted.exchangeAuthorizationCode(client,completed.code,undefined,REDIRECT);
    assert.equal((await restarted.verifyAccessToken(pair.access_token)).clientId,pub.chatClient.clientId);
   }
  }
 } finally {await pub.listener.close();}
});

test("O-T20 enabling public PKCE cannot redeem a confidential code without owner approval", async()=>{
 const h=await harness();
 try {
  const {verifier,challenge}=pkce();
  const started=await authorize(h,h.chatClient.clientId,challenge);
  assert.equal(started.status,302);
  const code=new URL(started.headers.get("location")!).searchParams.get("code")!;
  const client=h.oauth.config.clients.find(c=>c.clientId===h.chatClient.clientId)!;
  client.publicPkceOwnerApproval=true;
  const response=await tokenRequest(h,{grant_type:"authorization_code",client_id:client.clientId,
   code,code_verifier:verifier,redirect_uri:REDIRECT});
  const body=await response.text();
  assert.equal(response.status,400,"a confidential code must not become a public credential");
  assert.match(body,/owner approval/);
  assert.equal(h.oauth.summary().activeAccessTokens,0);
 } finally {await h.listener.close();}
});

test("O-T21 a confidential code cannot be redeemed after its client secret is removed without owner approval", async()=>{
 // The sibling of O-T20: the client leaves confidential mode without ever
 // entering the explicit owner-approval mode, so no local Human confirmation
 // provenance can exist. The code must stop being redeemable, not silently
 // become an unauthenticated public credential.
 const h=await harness();
 try{
  const {verifier,challenge}=pkce();
  const started=await authorize(h,h.chatClient.clientId,challenge);
  assert.equal(started.status,302);
  const code=new URL(started.headers.get("location")!).searchParams.get("code")!;
  const client=h.oauth.config.clients.find(c=>c.clientId===h.chatClient.clientId)!;
  client.clientSecret=undefined;
  const response=await tokenRequest(h,{grant_type:"authorization_code",client_id:client.clientId,
   code,code_verifier:verifier,redirect_uri:REDIRECT});
  const body=await response.text();
  assert.equal(response.status,400,"a confidential code must not be redeemed without any client authentication");
  assert.equal(h.oauth.summary().activeAccessTokens,0);
  } finally {await h.listener.close();}
});

test("O-T22 outstanding confidential and owner-approved codes cannot redeem a withdrawn registered redirect", async()=>{
  for(const publicOwnerApproval of [false,true]){
    const h=await harness({publicOwnerApproval});
    try{
      const {verifier,challenge}=pkce();
      const started=await authorize(h,h.chatClient.clientId,challenge);
      let code:string;
      if(publicOwnerApproval){
        assert.equal(started.status,200);
        const owner=(await started.text()).match(/href="(http:\/\/127\.0\.0\.1:\d+\/\?request=[a-f0-9]+)"/);
        assert.ok(owner);
        const id=new URL(owner[1]!).searchParams.get("request")!;
        // Synthetic approval only in this temp fixture, not a live Human act.
        assert.equal(h.oauth.approveOwnerRequest(id),true);
        code=h.oauth.completeOwnerRequest(id)!.code;
      }else{
        assert.equal(started.status,302);
        code=new URL(started.headers.get("location")!).searchParams.get("code")!;
      }
      const client=h.oauth.config.clients.find(c=>c.clientId===h.chatClient.clientId)!;
      client.redirectUris=[REDIRECT+"-replacement"];
      const registered=(await h.oauth.clientsStore.getClient(client.clientId))!;
      await assert.rejects(h.oauth.challengeForAuthorizationCode(registered,code),/redirect.*registered/);
      for(const includeRedirect of [true,false]){
        const response=await tokenRequest(h,{grant_type:"authorization_code",client_id:client.clientId,
          ...(publicOwnerApproval?{}:{client_secret:h.chatClient.clientSecret}),code,code_verifier:verifier,
          ...(includeRedirect?{redirect_uri:REDIRECT}:{})});
        assert.equal(response.status,400,"a withdrawn redirect cannot redeem its old code, including when redirect_uri is omitted");
        assert.match(await response.text(),/redirect.*registered/);
      }
      await assert.rejects(h.oauth.exchangeAuthorizationCode(registered,code,undefined,REDIRECT),/redirect.*registered/);
      assert.equal(h.oauth.summary().activeAccessTokens,0);
      assert.equal(h.oauth.summary().activeRefreshTokens,0);
    }finally{await h.listener.close();}
  }
});

test("O-T23 a confidential refresh token cannot rotate after its client secret is removed without owner approval",async()=>{
  // The refresh sibling of O-T21. A refresh grant mints new Node credentials, so
  // the client must still be able to authorize at all: either it stays
  // confidential, or it explicitly enters public owner-approval mode. Losing the
  // secret alone must not turn an outstanding confidential receipt into an
  // unauthenticated, owner-approval-free Node credential.
  const h=await harness();
  try{
    const minted=await mint(h,h.chatClient);
    const client=h.oauth.config.clients.find(c=>c.clientId===h.chatClient.clientId)!;
    const control=await tokenRequest(h,{grant_type:"refresh_token",refresh_token:minted.refresh_token,
      client_id:h.chatClient.clientId,client_secret:h.chatClient.clientSecret});
    assert.equal(control.status,200,"a confidential client still rotates with its own secret");
    const rotated=await control.json() as {access_token:string;refresh_token:string};
    const active=(h.oauth.summary() as {activeAccessTokens:number}).activeAccessTokens;
    client.clientSecret=undefined;
    const anonymous=await tokenRequest(h,{grant_type:"refresh_token",refresh_token:rotated.refresh_token,
      client_id:client.clientId});
    assert.equal(anonymous.status,400,"a removed secret must not leave the refresh grant unauthenticated");
    assert.match(await anonymous.text(),/no longer confidential/);
    assert.equal((h.oauth.summary() as {activeAccessTokens:number}).activeAccessTokens,active,
      "a refused refresh must not mint any credential");
    // The refusal must not consume the receipt: the explicit owner-approval public
    // mode is still a supported durable reconnect for the same connector.
    client.publicPkceOwnerApproval=true;
    const approved=await tokenRequest(h,{grant_type:"refresh_token",refresh_token:rotated.refresh_token,
      client_id:client.clientId});
    assert.equal(approved.status,200,"public owner-approval mode remains a supported reconnect");
    assert.equal((h.oauth.summary() as {activeAccessTokens:number}).activeAccessTokens,active+1);
  }finally{await h.listener.close();}
});

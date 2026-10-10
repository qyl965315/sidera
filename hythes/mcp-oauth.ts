import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

/**
 * Standard OAuth 2.1 Authorization Code + PKCE (S256) for remote HTTP MCP edges.
 *
 * This layer answers exactly one question: is this registered external client
 * allowed to authenticate as this edge? It does not answer what the Node may do.
 * Sidera Authority still owns that, unchanged, and no Sidera Grant is minted,
 * widened or consulted here.
 *
 * Binding is deterministic and one-way:
 *
 *   OAuth client -> configured edge -> boundNodeId -> exact Core principal
 *
 * An OAuth user, model, product name or tunnel hostname never infers a Node.
 * Each client belongs to exactly one edge, so a Gemini Chat token can never
 * authenticate as Gemini Spark and the reverse is equally impossible.
 *
 * The public base URL is explicit runtime configuration. A Cloudflare Quick
 * Tunnel hostname is reachability only and is never identity.
 */

export interface OAuthEdgeClient {
  edgeId: string;
  boundNodeId: string;
  clientId: string;
  /** Optional in provisioning; R1 issuance requires a confidential client until resource-owner authentication exists. */
  clientSecret?: string;
  /** Explicit opt-in: keep the historical client ID but require on-device Human
   * confirmation for public PKCE, rather than unauthenticated code issuance. */
  publicPkceOwnerApproval?: boolean;
  clientName?: string;
  /** Exact redirect URIs registered for this client. An unregistered value is refused. */
  redirectUris: string[];
}

export interface OAuthConfig {
  /** External base URL, for example the public tunnel origin. Explicit, never inferred. */
  baseUrl: string;
  clients: OAuthEdgeClient[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
  /** Path the MCP endpoint is served on. */
  mcpPath?: string;
}

interface CodeRecord {
  code: string;
  clientId: string;
  edgeId: string;
  boundNodeId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  /** Only the separate on-device confirmation path can supply this evidence. */
  ownerApprovedAt?: number;
}

interface TokenRecord {
  token: string;
  clientId: string;
  edgeId: string;
  boundNodeId?: string;
  familyId?: string;
  revokedAt?: number;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

/** Durable boundary-auth state. Tokens and codes survive a Gateway restart so a
 * product import is not silently invalidated by process lifecycle. */
interface RefreshRecord { digest:string;clientId:string;edgeId:string;boundNodeId:string;resource:string;scopes:string[];familyId:string;expiresAt:number;usedAt?:number;revokedAt?:number }
interface PendingOwnerRequest {
  id:string; clientId:string; edgeId:string; boundNodeId:string;
  redirectUri:string; codeChallenge:string; resource:string; state?:string;
  scopes:string[]; expiresAt:number; approvedAt?:number;
}
interface AuthState { version: 1; codes: CodeRecord[]; tokens: TokenRecord[];refresh:RefreshRecord[]; pendingOwner:PendingOwnerRequest[] }

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class EdgeOAuthProvider implements OAuthServerProvider {
  readonly config: OAuthConfig;
  private readonly statePath: string;
  private state: AuthState;
  private readonly accessTokenTtl: number;
  private readonly codeTtl: number;
  private readonly refreshTtl: number;
  private readonly now: () => number;
  private ownerApprovalOrigin: string | null = null;

  constructor(config: OAuthConfig, statePath: string, options: { now?: () => number } = {}) {
    if (!config.baseUrl) throw new Error("OAuth requires an explicit external base URL");
    const base = new URL(config.baseUrl);
    if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1")
      throw new Error(`OAuth base URL must be HTTPS or loopback, got ${base.protocol}//${base.hostname}`);
    const seenClients = new Set<string>();
    for (const client of config.clients) {
      if (!client.clientId) throw new Error(`OAuth client for edge ${client.edgeId} needs a client_id`);
      if (seenClients.has(client.clientId)) throw new Error(`Duplicate OAuth client_id ${client.clientId}`);
      seenClients.add(client.clientId);
      // A client may exist before its redirect URI is known: the Human has to
      // copy the value out of the product UI first. An empty set fails closed at
      // authorization time (the SDK refuses every redirect_uri), so discovery and
      // status stay usable while the import is in progress.
      for (const uri of client.redirectUris) {
        const parsed = new URL(uri);
        if (parsed.hash) throw new Error(`Redirect URI must not contain a fragment: ${uri}`);
      }
    }
    const edges = new Set(config.clients.map(client => client.edgeId));
    if (edges.size !== config.clients.length) throw new Error("Each OAuth client must belong to exactly one distinct edge");
    this.config = { ...config, mcpPath: config.mcpPath ?? "/mcp" };
    this.accessTokenTtl = config.accessTokenTtlSeconds ?? 3600;
    this.codeTtl = config.authorizationCodeTtlSeconds ?? 300;
    this.refreshTtl=config.refreshTokenTtlSeconds??30*24*3600;
    this.now = options.now ?? Date.now;
    this.statePath = statePath;
    this.state = this.load();
  }

  private load(): AuthState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as AuthState;
      if (parsed?.version === 1 && Array.isArray(parsed.codes) && Array.isArray(parsed.tokens)) return {...parsed,refresh:Array.isArray(parsed.refresh)?parsed.refresh:[],pendingOwner:Array.isArray(parsed.pendingOwner)?parsed.pendingOwner:[]};
    } catch { /* absent or unreadable state starts empty; it is not identity */ }
    return { version: 1, codes: [], tokens: [],refresh:[], pendingOwner:[] };
  }

  private persist(): void {
    const now = this.now();
    this.state.codes = this.state.codes.filter(code => code.expiresAt > now);
    this.state.pendingOwner = this.state.pendingOwner.filter(request => request.expiresAt > now);
    // Token receipts are retained; expiry/revocation is evaluated at use time.
    mkdirSync(join(this.statePath, ".."), { recursive: true });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.statePath);
  }

  /** The public resource identifier this authorization server protects. */
  get resourceUrl(): string {
    return new URL(this.config.mcpPath!, new URL(this.config.baseUrl)).href;
  }

  get issuerUrl(): URL {
    return new URL(this.config.baseUrl);
  }

  clientFor(clientId: string): OAuthEdgeClient | undefined {
    return this.config.clients.find(client => safeEqual(client.clientId, clientId));
  }

  clientForToken(token: string): OAuthEdgeClient | undefined {
    const record = this.tokenRecord(token);
    return record ? this.clientFor(record.clientId) : undefined;
  }

  tokenRecord(token: string): TokenRecord | undefined {
    return this.state.tokens.find(entry => safeEqual(entry.token, token));
  }

  get needsLocalOwnerApproval(): boolean {
    return this.config.clients.some(client => client.publicPkceOwnerApproval === true);
  }

  setLocalOwnerApprovalOrigin(origin: string | null): void {
    if (origin) {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
        throw new Error("OAuth owner approval must use a dedicated loopback-only HTTP listener");
    }
    this.ownerApprovalOrigin = origin;
  }

  private ownerRequestClient(request:PendingOwnerRequest):OAuthEdgeClient|undefined {
    const client=this.clientFor(request.clientId);
    if(request.expiresAt<=this.now()||request.resource!==this.resourceUrl||
      !client||client.publicPkceOwnerApproval!==true||client.boundNodeId!==request.boundNodeId||
      client.edgeId!==request.edgeId||!client.redirectUris.some(uri=>safeEqual(uri,request.redirectUri)))return undefined;
    return client;
  }

  pendingOwnerRequest(id:string): {clientName:string;boundNodeId:string;redirectUri:string;displayCode:string}|null {
    const request=this.state.pendingOwner.find(p=>p.id===id && p.expiresAt>this.now() && p.approvedAt===undefined);
    const client=request?this.ownerRequestClient(request):undefined;
    if(!request||!client)return null;
    return {clientName:client.clientName??client.clientId,boundNodeId:request.boundNodeId,
      redirectUri:request.redirectUri,displayCode:request.id.slice(0,8).toUpperCase()};
  }

  ownerApprovalStatus(id:string): "MISSING" | "PENDING" | "APPROVED" {
    const request=this.state.pendingOwner.find(p=>p.id===id && p.expiresAt>this.now());
    if(!request||!this.ownerRequestClient(request))return "MISSING";
    return request.approvedAt===undefined?"PENDING":"APPROVED";
  }

  approveOwnerRequest(id:string):boolean {
    if(!this.pendingOwnerRequest(id))return false;
    const record=this.state.pendingOwner.find(p=>p.id===id)!;
    record.approvedAt=this.now();
    this.persist();return true;
  }

  /** A public OAuth code can only be issued after a fresh, explicit approval
   * on a separate local-only listener. The code redirects to the pinned URI. */
  completeOwnerRequest(id:string):{redirectUri:string;code:string;state?:string}|null {
    const index=this.state.pendingOwner.findIndex(p=>p.id===id);
    if(index<0)return null;
    const request=this.state.pendingOwner[index]!;
    if(request.approvedAt===undefined||!this.ownerRequestClient(request))return null;
    this.state.pendingOwner.splice(index,1);
    const code=randomBytes(32).toString("base64url");
    this.state.codes.push({code,clientId:request.clientId,edgeId:request.edgeId,
      boundNodeId:request.boundNodeId,redirectUri:request.redirectUri,
      codeChallenge:request.codeChallenge,resource:request.resource,
      scopes:[...request.scopes],expiresAt:this.now()+this.codeTtl*1000,ownerApprovedAt:request.approvedAt});
    this.persist();
    return {redirectUri:request.redirectUri,code,...(request.state?{state:request.state}:{})};
  }

  private renderOwnerApproval(request:PendingOwnerRequest,res:Response):void {
    const nonce=randomBytes(16).toString("base64");
    const rid=encodeURIComponent(request.id);
    const ownerUrl=this.ownerApprovalOrigin+"/?request="+rid;
    const script="const statusPath='/oauth/owner-status?request="+rid+"';"
      +"const donePath='/oauth/owner-complete?request="+rid+"';"
      +"setInterval(async()=>{try{const r=await fetch(statusPath,{cache:'no-store'});"
      +"if(!r.ok)return;const s=await r.json();if(s.status==='APPROVED')location.replace(donePath);"
      +"}catch{}},1200);";
    const esc=(value:string)=>value.replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",
      '"':"&quot;","'":"&#39;"}[ch]!));
    res.set("Cache-Control","no-store");res.set("Referrer-Policy","no-referrer");
    res.set("X-Frame-Options","DENY");res.set("X-Content-Type-Options","nosniff");
    res.set("Content-Security-Policy","default-src 'none'; connect-src 'self'; script-src 'nonce-"+nonce
      +"'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.status(200).type("html").send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
      +'<meta name="viewport" content="width=device-width, initial-scale=1">'
      +'<title>Sidera 连接确认</title>'
      +'<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:8vh auto;'
      +'padding:0 22px;line-height:1.8}a{display:inline-block;background:#1769d1;color:white;'
      +'padding:10px 18px;border-radius:8px;text-decoration:none}code{font-weight:bold}</style>'
      +'</head><body><h2>在本机确认连接 Sidera</h2><p>这是公开客户端 PKCE 授权。'
      +'为保护你的 Sidera Node，必须在这台电脑上明确确认一次。</p>'
      +'<p><strong>核对码：</strong><code>'+esc(request.id.slice(0,8).toUpperCase())+'</code></p>'
      +'<p><a href="'+esc(ownerUrl)+'" target="_blank" rel="noopener noreferrer">打开本机确认页面</a></p>'
      +'<p>核对并点击批准后，此页将自动返回 ChatGPT。</p>'
      +'<p><small>若不是你发起的请求，请关闭此页。不会自动签发 Node 凭据。</small></p>'
      +'<script nonce="'+nonce+'">'+script+'</script></body></html>');
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      // Pre-registered clients only. Dynamic Client Registration is intentionally
      // absent so the Human-entered OAuth credentials are the whole client set.
      getClient: async (clientId: string): Promise<OAuthClientInformationFull | undefined> => {
        const client = this.clientFor(clientId);
        if (!client) return undefined;
        return { client_id: client.clientId, ...(client.clientSecret && !client.publicPkceOwnerApproval ? { client_secret: client.clientSecret } : {}),
          client_name: client.clientName ?? `Sidera edge ${client.edgeId}`,
          redirect_uris: [...client.redirectUris],
          token_endpoint_auth_method: client.clientSecret && !client.publicPkceOwnerApproval ? "client_secret_post" : "none",
          grant_types: ["authorization_code","refresh_token"], response_types: ["code"],
          scope: "sidera.mcp" };
      },
    };
  }

  /** Pre-registered, machine-to-machine client: the product itself started the
   * flow for its own configured connector, so the authorization step is a
   * redirect with a code rather than an interactive consent screen. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const edgeClient = this.clientFor(client.client_id);
    if (!edgeClient) { this.redirectError(params.redirectUri, "unauthorized_client", "Unknown client", params.state, res); return; }
    // Public client_id + PKCE authenticates no resource owner in this R1 M2M flow.
    if(!edgeClient.clientSecret && !edgeClient.publicPkceOwnerApproval){
      res.status(400).json({error:"unauthorized_client",error_description:"Public OAuth requires resource-owner authentication"});return;
    }
    if (!edgeClient.redirectUris.some(uri => safeEqual(uri, params.redirectUri))) {
      res.status(400).json({error:"invalid_request",error_description:"Unregistered redirect_uri"}); return;
    }
    if (params.resource && params.resource.href !== this.resourceUrl) {
      this.redirectError(params.redirectUri, "invalid_target", "Unsupported resource", params.state, res); return;
    }
    if (!params.codeChallenge) {
      this.redirectError(params.redirectUri, "invalid_request", "PKCE code_challenge is required", params.state, res); return;
    }
    if(edgeClient.publicPkceOwnerApproval){
      if(!this.ownerApprovalOrigin){
        res.status(503).json({error:"temporarily_unavailable",error_description:"Local Human approval listener is unavailable"});return;
      }
      if(this.state.pendingOwner.filter(p=>p.expiresAt>this.now()).length>=32){
        res.status(429).json({error:"temporarily_unavailable",error_description:"Too many pending Human approvals"});return;
      }
      const request:PendingOwnerRequest={id:randomBytes(32).toString("hex"),clientId:edgeClient.clientId,
        edgeId:edgeClient.edgeId,boundNodeId:edgeClient.boundNodeId,redirectUri:params.redirectUri,
        codeChallenge:params.codeChallenge,resource:this.resourceUrl,scopes:["sidera.mcp"],
        ...(params.state?{state:params.state}:{}),expiresAt:this.now()+this.codeTtl*1000};
      this.state.pendingOwner.push(request);this.persist();
      this.renderOwnerApproval(request,res);return;
    }
    const code: CodeRecord = { code: randomBytes(32).toString("base64url"), clientId: edgeClient.clientId,
      edgeId: edgeClient.edgeId,boundNodeId:edgeClient.boundNodeId, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge,
      resource: this.resourceUrl, scopes: ["sidera.mcp"], expiresAt: this.now() + this.codeTtl * 1000 };
    this.state.codes.push(code);
    this.persist();
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code.code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  }

  private redirectError(uri: string, error: string, description: string, state: string | undefined, res: Response): void {
    try {
      const redirect = new URL(uri);
      redirect.searchParams.set("error", error);
      redirect.searchParams.set("error_description", description);
      if (state) redirect.searchParams.set("state", state);
      res.redirect(302, redirect.href);
    } catch { res.status(400).json({ error, error_description: description }); }
  }

  private validateCodeBinding(client:OAuthClientInformationFull,record:CodeRecord):void {
    if(record.clientId!==client.client_id)throw new InvalidGrantError("Authorization code was issued to another client");
    if(record.resource!==this.resourceUrl)throw new InvalidGrantError("Authorization code audience changed; re-authorize this connector");
    const bound=this.clientFor(client.client_id);
    if(!bound||bound.edgeId!==record.edgeId||bound.boundNodeId!==record.boundNodeId)
      throw new InvalidGrantError("Authorization binding changed; re-authorize this connector");
    if(!bound.redirectUris.some(uri=>safeEqual(uri,record.redirectUri)))
      throw new InvalidGrantError("Authorization redirect is no longer registered; re-authorize this connector");
    if(bound.publicPkceOwnerApproval===true){
      if(!Number.isFinite(record.ownerApprovedAt))
        throw new InvalidGrantError("Public OAuth code requires on-device owner approval; re-authorize this connector");
    } else {
      if(record.ownerApprovedAt!==undefined)
        throw new InvalidGrantError("Authorization client mode changed; re-authorize this connector");
      // A code minted for a confidential client is only redeemable while that
      // client is still confidential. Removing the secret without the explicit
      // owner-approval opt-in would otherwise let the same outstanding code be
      // exchanged with no client authentication and no Human approval evidence.
      if(!bound.clientSecret)
        throw new InvalidGrantError("Authorization client is no longer confidential; re-authorize this connector");
    }
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.state.codes.find(entry => entry.code === authorizationCode);
    if (!record || record.expiresAt <= this.now()) throw new InvalidGrantError("Authorization code is unknown or expired");
    this.validateCodeBinding(client,record);
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string,
    _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const index = this.state.codes.findIndex(entry => entry.code === authorizationCode);
    if (index < 0) throw new InvalidGrantError("Authorization code is unknown or already used");
    const record = this.state.codes[index]!;
    this.state.codes.splice(index, 1);
    try {
      if (record.expiresAt <= this.now()) throw new InvalidGrantError("Authorization code has expired");
      this.validateCodeBinding(client,record);
      if (redirectUri !== undefined && !safeEqual(record.redirectUri, redirectUri))
        throw new InvalidGrantError("redirect_uri does not match the authorization request");
      if (resource && resource.href !== this.resourceUrl) throw new InvalidGrantError("Unsupported resource");
      return this.mintPair({clientId:client.client_id,edgeId:record.edgeId,boundNodeId:record.boundNodeId,
        resource:record.resource,scopes:record.scopes,familyId:randomUUID(),expiresAt:this.now()+this.refreshTtl*1000});
    } finally { this.persist(); }
  }

  private mintPair(grant:Omit<RefreshRecord,"digest"|"usedAt"|"revokedAt">):OAuthTokens {
    const access=randomBytes(32).toString("base64url"),refresh=randomBytes(48).toString("base64url");
    this.state.tokens.push({token:access,clientId:grant.clientId,edgeId:grant.edgeId,boundNodeId:grant.boundNodeId,
      familyId:grant.familyId,resource:grant.resource,scopes:[...grant.scopes],expiresAt:this.now()+this.accessTokenTtl*1000});
    this.state.refresh.push({...grant,scopes:[...grant.scopes],digest:createHash("sha256").update(refresh).digest("hex")});
    return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:this.accessTokenTtl,scope:grant.scopes.join(" ")};
  }
  private revokeFamily(familyId:string):void {
    for(const token of this.state.tokens)if(token.familyId===familyId)token.revokedAt=this.now();
    for(const token of this.state.refresh)if(token.familyId===familyId)token.revokedAt=this.now();
  }
  async exchangeRefreshToken(client:OAuthClientInformationFull,refreshToken:string,scopes?:string[],resource?:URL):Promise<OAuthTokens> {
    const digest=createHash("sha256").update(refreshToken).digest("hex"),record=this.state.refresh.find(r=>safeEqual(r.digest,digest)),bound=this.clientFor(client.client_id);
    if(!record||record.clientId!==client.client_id||!bound||record.edgeId!==bound.edgeId||record.boundNodeId!==bound.boundNodeId||
      record.resource!==this.resourceUrl||resource&&resource.href!==record.resource)
      throw new InvalidGrantError("Unknown refresh token or changed exact connector binding");
    if(record.usedAt!==undefined){this.revokeFamily(record.familyId);this.persist();throw new InvalidGrantError("Refresh token was already rotated; re-authorize this connector");}
    if(record.revokedAt!==undefined||record.expiresAt<=this.now())throw new InvalidGrantError("Refresh authorization is revoked or expired");
    if(scopes?.some(scope=>!record.scopes.includes(scope)))throw new InvalidGrantError("Refresh cannot widen scopes");
    // A refresh grant mints a fresh Node credential, so the client must still be in
    // a mode that may authorize at all: a confidential client keeps its secret, and
    // a public client needs the explicit on-device owner-approval opt-in. Removing
    // the secret without that opt-in must not leave an outstanding confidential
    // refresh rotating with no client authentication and no Human approval evidence.
    if(!bound.clientSecret&&bound.publicPkceOwnerApproval!==true)
      throw new InvalidGrantError("Authorization client is no longer confidential; re-authorize this connector");
    record.usedAt=this.now();
    const pair=this.mintPair({clientId:record.clientId,edgeId:record.edgeId,boundNodeId:record.boundNodeId,resource:record.resource,
      scopes:scopes??record.scopes,familyId:record.familyId,expiresAt:record.expiresAt});
    this.persist();return pair;
  }

  /** Verifies expiry, audience and binding, then returns the exact edge identity.
   * A refused token must be a protocol-level 401 invalid_token challenge, never a
   * 500 server_error: an expired connector token is exactly what tells a product
   * to re-authorize, and a server error hides that recovery path. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.tokenRecord(token);
    if (!record) throw new InvalidTokenError("Unknown access token");
    if(record.revokedAt!==undefined||record.expiresAt <= this.now())throw new InvalidTokenError("Access token is revoked or expired; refresh or re-authorize this connector");
    const bound=this.clientFor(record.clientId);
    if(!bound||bound.edgeId!==record.edgeId||bound.boundNodeId!==record.boundNodeId)throw new InvalidTokenError("Exact connector Node binding changed or was not recorded; re-authorize this connector");
    if (record.resource !== this.resourceUrl) throw new InvalidTokenError("Access token audience does not match this MCP Gateway");
    return { token, clientId: record.clientId, scopes: [...record.scopes],
      expiresAt: Math.floor(record.expiresAt / 1000), resource: new URL(record.resource),
      extra: { edgeId: record.edgeId } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const access=this.state.tokens.find(t=>safeEqual(t.token,request.token)&&t.clientId===client.client_id);
    const digest=createHash("sha256").update(request.token).digest("hex"),refresh=this.state.refresh.find(t=>safeEqual(t.digest,digest)&&t.clientId===client.client_id);
    const family=access?.familyId??refresh?.familyId;if(family)this.revokeFamily(family);else if(access)access.revokedAt=this.now();
    this.persist();
  }

  /** Operator diagnostics: never exposes a token value. */
  summary(): Record<string, unknown> {
    const active = this.state.tokens.filter(token => token.revokedAt===undefined&&token.expiresAt > this.now());
    return { baseUrl: this.config.baseUrl, resource: this.resourceUrl,
      issuer: this.issuerUrl.href, accessTokenTtlSeconds: this.accessTokenTtl,
      pendingAuthorizationCodes: this.state.codes.filter(code => code.expiresAt > this.now()).length,
      pendingOwnerApprovals:this.state.pendingOwner.filter(p=>p.expiresAt>this.now()&&p.approvedAt===undefined).length,
      activeAccessTokens: active.length,
      refreshTokenRotation:true,refreshTokenTtlSeconds:this.refreshTtl,
      activeRefreshTokens:this.state.refresh.filter(t=>t.usedAt===undefined&&t.revokedAt===undefined&&t.expiresAt>this.now()).length,
      clients: this.config.clients.map(client => ({ edgeId: client.edgeId, boundNodeId: client.boundNodeId,
        clientId: client.clientId, redirectUris: [...client.redirectUris],
        secretFingerprint: client.clientSecret
          ? createHash("sha256").update(client.clientSecret).digest("hex").slice(0, 12)
          : "public-pkce",ownerApprovalRequired:client.publicPkceOwnerApproval===true })) };
  }
}

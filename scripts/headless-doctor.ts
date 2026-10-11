/** Bounded, credential-free infrastructure observations. Never imports a runtime launcher. */
import { readFileSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { readSessionHostCondition } from '../core/condition.ts';

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const port = (value: unknown): number | null => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null;
const LIMIT = 65_536;
function contained(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../');
}
function config(root: string, name: string) {
  const path = join(root, '.sidera-dev', 'sol', 'data', name);
  try {
    if (!contained(root, path) || !statSync(path).isFile() || statSync(path).size > 1_048_576) throw 0;
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return { state: 'configured', value: object(value) };
  } catch { return { state: existsSync(path) ? 'invalid' : 'missing', value: {} as ObjectValue }; }
}

type Wire = { state: 'available' | 'blocked' | 'unknown'; observation: string; listening: boolean | null;
  httpStatus?: number; bearerChallenge?: boolean; eventStream?: boolean; body?: ObjectValue };
function tcpProbe(target: number, timeout: number, invalidToken?: string): Promise<Wire> {
  return new Promise(done => {
    let listening = false, settled = false, buffer = '';
    const socket = createConnection({ host: '127.0.0.1', port: target });
    const finish = (state: Wire['state'], observation: string) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      done({ state, observation, listening: listening || (observation === 'connection_refused' ? false : null) });
    };
    const timer = setTimeout(() => finish('unknown', 'deadline_exceeded'), timeout);
    socket.on('error', error => finish('blocked', (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'connection_refused' : 'connection_error'));
    socket.once('connect', () => {
      listening = true;
      if (!invalidToken) return finish('available', 'tcp_listener_only');
      // Deliberately invalid, non-secret credential. Never authenticate as a real Node.
      socket.write(JSON.stringify({ id: 'sidera-doctor', token: invalidToken, method: 'runtime.status', params: {} }) + '\n');
    });
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > LIMIT) return finish('unknown', 'response_too_large');
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer.split('\n')[0]);
        finish(response.id === 'sidera-doctor' && response.error?.code === 'denied' ? 'available' : 'blocked',
          response.id === 'sidera-doctor' && response.error?.code === 'denied' ? 'jsonl_auth_denied' : 'different_or_unrecognized_protocol');
      } catch { finish('blocked', 'different_or_unrecognized_protocol'); }
    });
    socket.once('close', () => finish('unknown', 'closed_without_response'));
  });
}

/** Single request, absolute deadline including body, cap, no redirects/retries/cookies/credentials. */
function httpProbe(base: URL, path: string, timeout: number, method = 'GET', headersOnly = false): Promise<Wire> {
  return new Promise(done => {
    let settled = false, listening = false;
    const finish = (result: Wire) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); done(result); };
    const url = new URL(path, base);
    const body = method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) : undefined;
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, agent: false, headers: { Accept: 'application/json, text/event-stream',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, response => {
      listening = true;
      const result: Wire = { state: 'available', observation: 'http_response', listening: true,
        httpStatus: response.statusCode, bearerChallenge: /^Bearer(?:\s|$)/i.test(response.headers['www-authenticate'] ?? ''),
        eventStream: /^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] ?? '') };
      if (headersOnly) { response.destroy(); finish(result); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LIMIT) { response.destroy(); finish({ ...result, state: 'unknown', observation: 'response_too_large' }); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { result.body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* No raw body escapes. */ }
        finish(result);
      });
      response.on('error', () => finish({ ...result, state: 'unknown', observation: 'incomplete_body' }));
    });
    const timer = setTimeout(() => finish({ state: 'unknown', observation: 'deadline_exceeded', listening: listening || null }), timeout);
    req.on('socket', socket => socket.once('connect', () => { listening = true; }));
    req.on('error', error => finish({ state: 'blocked', observation: (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'connection_refused' : 'connection_error',
      listening: listening || ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? false : null) }));
    req.end(body);
  });
}
const publicWire = ({ body: _body, ...wire }: Wire) => wire;
function storedHostCondition(db: DatabaseSync, nodeId: string) {
  try {
    // The canonical reader has a compatibility incarnation fallback that writes.
    // Require its existing join first, in this same read transaction, so that
    // fallback can never run. Missing evidence stays UNKNOWN; no Host is probed.
    const row = db.prepare(`SELECT s.session_id FROM sessions s JOIN session_incarnations i USING(session_id)
      WHERE s.node_id=? AND s.state='active' AND i.owner_node_id=s.node_id`).get(nodeId);
    if (!row) return 'UNKNOWN';
    const condition = readSessionHostCondition(db, String(row.session_id));
    return ['AVAILABLE', 'UNKNOWN', 'STALE', 'CONFIRMED_LOST'].includes(condition.state) ? condition.state : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}
function profileMatch(value: unknown, expected: string): 'matches_selected_profile' | 'different_profile' | 'unknown' {
  if (typeof value !== 'string' || !isAbsolute(value)) return 'unknown';
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(value) === normalize(expected) ? 'matches_selected_profile' : 'different_profile';
}
async function httpSurface(base: URL, timeout: number, expectedDb: string, observeInstance: (value: unknown) => void = () => {}) {
  const [health, ready, mcp, sse] = await Promise.all([
    httpProbe(base, '/healthz', timeout), httpProbe(base, '/readyz', timeout),
    httpProbe(base, '/mcp', timeout, 'POST'), httpProbe(base, '/sse', timeout, 'GET', true),
  ]);
  const advertised = health.httpStatus === 200 && health.body?.healthy === true && health.body?.transport === 'streamable-http-stateless';
  const challenge = mcp.httpStatus === 401 || mcp.httpStatus === 403;
  const ping = mcp.httpStatus === 200 && mcp.body?.jsonrpc === '2.0' && mcp.body?.id === 1 && mcp.body?.result && !mcp.body?.error;
  const identity = profileMatch(ready.body?.buildIdentity?.dbPath ?? ready.body?.runtime?.buildIdentity?.dbPath, expectedDb);
  observeInstance(health.body?.instanceId);
  return {
    state: identity === 'different_profile' ? 'blocked' : advertised && (challenge || ping) ? 'available' : health.listening === false ? 'blocked' : 'unknown',
    stateScope: 'transport_only',
    serviceReadiness: identity === 'different_profile' || ready.body?.ready === false ? 'blocked' : ready.httpStatus === 200 && ready.body?.ready === true ? 'available' : 'unknown',
    health: publicWire(health), readiness: { ...publicWire(ready), reportedReady: typeof ready.body?.ready === 'boolean' ? ready.body.ready : null,
      profileIdentity: identity, identityBasis: 'unauthenticated_downstream_report_not_owner_proof' },
    transport: { advertised: advertised ? 'streamable-http-stateless' : 'unknown',
      postMcp: publicWire(mcp), supported: ping ? 'streamable_http_ping_observed' : advertised && challenge ? 'advertised_auth_gated_not_negotiated' : 'unknown',
      legacySse: { ...publicWire(sse), supported: sse.httpStatus === 200 && sse.eventStream ? 'event_stream_observed_not_mcp_session' : [404, 405, 410].includes(sse.httpStatus ?? 0) ? 'absent' : 'unknown' } },
    authentication: challenge ? 'unauthenticated_request_rejected' : ping ? 'anonymous_ping_only' : 'unknown',
  };
}

/** Metadata only. No application DB initializer, migrations, Host adapters or observation writes. */
function metadata(root: string, spec: ObjectValue) {
  const path = join(root, '.sidera-dev', 'sol', 'data', 'sidera.sqlite');
  let db: DatabaseSync | undefined;
  const unknown = (reason: string) => ({ state: 'unknown', reason, chief: { state: 'unknown' }, workers: [] });
  try {
    if (!contained(root, path)) return unknown('database_outside_selected_root');
    if (statSync(path).size > 64 * 1024 * 1024) return unknown('database_exceeds_64_mib_metadata_budget');
    // A read-only SQLite connection can still create/change WAL shared memory. Refuse
    // WAL/hot-journal databases instead of recovering, copying or changing their mode.
    const fdHeader = readHeader(path);
    if (fdHeader[18] === 2 || fdHeader[19] === 2 || ['-wal', '-shm', '-journal'].some(suffix => existsSync(path + suffix)))
      return unknown('live_or_wal_database_requires_owner_provided_quiescent_snapshot');
    db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const chief = db.prepare(`SELECT COUNT(*) AS count, SUM(CASE WHEN frontend_kind='chatgpt-web' THEN 1 ELSE 0 END) AS chatgpt,
      SUM(CASE WHEN length(trim(conversation_ref))>0 AND length(trim(project_ref))>0 THEN 1 ELSE 0 END) AS exact
      FROM chief_conversations WHERE chief_node_id=? AND state='active'`).get(typeof spec.chiefNodeId === 'string' ? spec.chiefNodeId : '')!;
    const nodes = Array.isArray(spec.nodes) ? spec.nodes.slice(0, 32) : [];
    const registrations = nodes.filter(node => object(node).nodeId !== spec.chiefNodeId).map((value, index) => {
      const node = object(value), nodeId = typeof node.nodeId === 'string' ? node.nodeId : '';
      try {
        const kind = db!.prepare('SELECT kind FROM node_ontology WHERE node_ref=?').get(nodeId)?.kind;
        if (kind !== 'Operator') return { index, state: 'configured', nodeKind: kind === 'Communicator' ? 'Communicator' : 'unknown',
          reason: 'not_a_registered_operator' };
        const models = db!.prepare('SELECT COUNT(*) AS count FROM model_bindings WHERE node_id=? AND valid_until IS NULL').get(nodeId)!;
        const sessions = db!.prepare("SELECT COUNT(*) AS count FROM sessions WHERE node_id=? AND state='active'").get(nodeId)!;
        return { index, nodeKind: 'Operator', state: Number(models.count) === 1 && Number(sessions.count) === 1 ? 'configured' : 'blocked',
          currentModelBinding: Number(models.count) === 1, activeSessionRegistered: Number(sessions.count) === 1,
          hostCondition: storedHostCondition(db!, nodeId), hostConditionBasis: 'persisted_canonical_evidence_no_live_probe',
          dispatchAuthority: 'unknown', reason: 'registration_is_not_live_host_or_authority' };
      } catch { return { index, state: 'unknown', reason: 'worker_schema_unavailable' }; }
    });
    return { state: 'available', basis: 'selected_profile_database_metadata_only',
      chief: { state: Number(chief.count) > 0 ? 'configured' : 'blocked', activeBindings: Number(chief.count),
        exactReferenceRegistered: Number(chief.count) > 0 && Number(chief.exact) === Number(chief.count),
        chatgptWebBindings: Number(chief.chatgpt ?? 0), currentConversationMatch: 'unknown' },
      workers: registrations.filter(node => 'nodeKind' in node && node.nodeKind === 'Operator'),
      otherRegistrations: registrations.filter(node => !('nodeKind' in node) || node.nodeKind !== 'Operator') };
  } catch { return unknown('database_missing_busy_or_schema_unavailable'); }
  finally { db?.close(); }
}
function readHeader(path: string) {
  const fd = openSync(path, 'r');
  try { const header = Buffer.alloc(100); readSync(fd, header, 0, 100, 0); return header; }
  finally { closeSync(fd); }
}

export function compareGatewayInstances(local: unknown, remote: unknown) {
  if (typeof local !== 'string' || !local || local.length > 128 || typeof remote !== 'string' || !remote || remote.length > 128) return 'unknown';
  return local === remote ? 'same_reported_instance' : 'different_reported_instance';
}

export async function diagnoseHeadless(options: { root: string; publicProbe?: boolean; timeoutMs?: number }) {
  const root = resolve(options.root), timeout = options.timeoutMs ?? 1500;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) throw new Error('Doctor timeout must be 100..5000 ms');
  const runtime = config(root, 'runtime-spec.json'), gateway = config(root, 'gateway.json');
  const spec = runtime.value, edge = gateway.value;
  const validRuntime = runtime.state === 'configured' && spec.version === 1 && Array.isArray(spec.nodes) && spec.nodes.length <= 32;
  const validGateway = gateway.state === 'configured' && edge.version === 1;
  const corePort = validRuntime ? port(spec.corePort) : null, gatewayPort = validGateway ? port(edge.gatewayPort) : null;
  const consentPort = validGateway ? port(edge.localOwnerApprovalPort ?? 8791) : null;
  const frontendValues = validRuntime ? (Array.isArray(spec.frontends) ? spec.frontends : [{ port: spec.mcpPort }]) : [];
  const mcpPorts = [...new Set(frontendValues.slice(0, 16).map((entry: unknown) => port(object(entry).port)))];
  const expectedDb = join(root, '.sidera-dev', 'sol', 'data', 'sidera.sqlite');
  const absent: Wire = { state: 'unknown', observation: 'not_configured_or_invalid', listening: null };
  let invalidToken: string;
  do { invalidToken = `doctor-unconfigured-${randomUUID()}`; }
  while (Array.isArray(spec.nodes) && spec.nodes.some((node: unknown) => object(node).coreToken === invalidToken));
  let localInstance: unknown, publicInstance: unknown;
  const local = (value: number) => new URL(`http://127.0.0.1:${value}`);
  const [core, mcp, gatewaySurface, consent] = await Promise.all([
    corePort ? tcpProbe(corePort, timeout, invalidToken) : absent,
    Promise.all(mcpPorts.map(async value => ({ port: value, ...(value ? await httpSurface(local(value), timeout, expectedDb) : absent) }))),
    gatewayPort ? httpSurface(local(gatewayPort), timeout, expectedDb, value => { localInstance = value; }) : absent,
    consentPort ? tcpProbe(consentPort, timeout) : absent,
  ]);
  let publicObservation: ObjectValue = { state: 'unknown', observation: 'not_requested', configured: typeof edge.publicBaseUrl === 'string' };
  if (options.publicProbe) {
    try {
      const url = new URL(edge.publicBaseUrl);
      // This bounded recovery doctor supports the existing DevTunnel only. Avoid
      // arbitrary destinations, URL credentials, redirect hops and path/query secrets.
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.devtunnels.ms') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw 0;
      publicObservation = { configured: true, ...(await httpSurface(url, timeout, expectedDb, value => { publicInstance = value; })) };
    } catch { publicObservation = { state: 'blocked', observation: 'public_url_missing_or_not_safe_devtunnel_origin' }; }
  }
  const binding = validRuntime ? metadata(root, spec) : { state: 'unknown', reason: 'runtime_spec_invalid' };
  return {
    schema: 'sidera-headless-doctor/1', observedAt: new Date().toISOString(), status: 'HOLD', exitCode: 2, readOnly: true,
    bounds: { timeoutMsPerRequest: timeout, timeoutScope: 'network_requests_only', maxResponseBytes: LIMIT, maxDatabaseBytes: 64 * 1024 * 1024,
      retries: 0, redirects: 0, maximumMcpPorts: 16 },
    configuration: { runtime: validRuntime ? 'configured' : runtime.state === 'configured' ? 'invalid' : runtime.state,
      gateway: validGateway ? 'configured' : gateway.state === 'configured' ? 'invalid' : gateway.state,
      corePort, mcpPorts, gatewayPort, consentPort, gatewayCorePortMatchesRuntime: corePort && validGateway ? port(edge.corePort) === corePort : null,
      frontendListTruncated: frontendValues.length > 16,
      humanOAuthApprovalRequired: Array.isArray(edge.edges) && edge.edges.some((item: unknown) => object(object(item).oauth).publicPkceOwnerApproval === true) },
    core: { ...core, identity: 'unknown', authenticatedReadiness: 'unknown', basis: 'credential_free_protocol_observation_only' },
    mcp, gateway: gatewaySurface, localConsent: consent, publicTunnel: { ...publicObservation,
      localGatewayCorrelation: compareGatewayInstances(localInstance, publicInstance), correlationBasis: 'unauthenticated_report_not_owner_proof' }, metadata: binding,
    liveConnector: { state: 'HOLD', authenticatedChiefIngress: 'unknown', exactConversationPresence: 'unknown',
      workerExecution: 'unknown', dispatchAuthority: 'unknown', returnRoutePrepared: 'unknown', resultDelivery: 'unknown',
      reason: 'No authenticated external Chief call, authorized worker receipt or exact-origin result was exercised.' },
    effects: { serviceStarted: false, configurationWritten: false, authenticatedCallMade: false, taskDispatched: false, retryAttempted: false },
  };
}

export async function runHeadlessDoctor(args: string[], defaultRoot: string, output: (value: unknown) => void): Promise<number> {
  let root = defaultRoot, publicProbe = false, timeoutMs = 1500;
  const seen = new Set<string>();
  try {
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (seen.has(key)) throw 0; seen.add(key);
      if (key === '--public') publicProbe = true;
      else if (key === '--root' || key === '--timeout-ms') {
        const value = args[++index]; if (!value || value.startsWith('--')) throw 0;
        if (key === '--root') root = value; else timeoutMs = Number(value);
      } else throw 0;
    }
    output(await diagnoseHeadless({ root, publicProbe, timeoutMs })); return 2;
  } catch {
    output({ schema: 'sidera-headless-doctor/1', status: 'ERROR', exitCode: 1,
      reason: 'Invalid doctor options or diagnostic unavailable; no retry. Use --root PATH [--public] [--timeout-ms 100..5000].' }); return 1;
  }
}

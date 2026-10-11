import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer as tcpServer, type Server as TcpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { diagnoseHeadless, runHeadlessDoctor, compareGatewayInstances } from '../scripts/headless-doctor.ts';
import { runOperator } from '../scripts/sidera.ts';

async function listen(server: TcpServer) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: TcpServer) { await new Promise<void>(resolve => server.close(() => resolve())); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sidera-doctor-'));
  const data = join(root, '.sidera-dev', 'sol', 'data'); mkdirSync(data, { recursive: true });
  const path = join(data, 'sidera.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE chief_conversations (chief_node_id TEXT, frontend_kind TEXT, conversation_ref TEXT, project_ref TEXT, state TEXT);
    CREATE TABLE model_bindings (node_id TEXT, valid_until TEXT);
    CREATE TABLE sessions (node_id TEXT, state TEXT);
    CREATE TABLE node_ontology (node_ref TEXT, kind TEXT);
    INSERT INTO node_ontology VALUES ('worker','Operator');
    INSERT INTO chief_conversations VALUES ('chief', 'chatgpt-web', 'https://chatgpt.com/c/private-conversation', 'private-project', 'active');
    INSERT INTO model_bindings VALUES ('worker',NULL);
    INSERT INTO sessions VALUES ('worker','active');`);
  db.close();
  const write = (corePort: number, mcpPort: number, extra: Record<string, unknown> = {}) => {
    writeFileSync(join(data, 'runtime-spec.json'), JSON.stringify({ version: 1, corePort, mcpPort, chiefNodeId: 'chief',
      httpToken: 'private-http-token', nodes: [{ nodeId: 'chief', coreToken: 'private-core-token' }, { nodeId: 'worker' }], ...extra }));
    writeFileSync(join(data, 'gateway.json'), JSON.stringify({ version: 1, corePort, gatewayPort: mcpPort,
      localOwnerApprovalPort: corePort, publicBaseUrl: 'https://example.devtunnels.ms',
      edges: [{ authMode: 'oauth', oauth: { clientId: 'private-client-id', publicPkceOwnerApproval: true }, token: 'private-gateway-token' }], email: 'private@example.com' }));
  };
  const snapshot = () => readdirSync(data).sort().map(name => [name, createHash('sha256').update(readFileSync(join(data, name))).digest('hex')]);
  return { root, data, path, write, snapshot, clean: () => rmSync(root, { recursive: true, force: true }) };
}
function coreFixture(requests: any[]) {
  return tcpServer(socket => {
    socket.on('error', () => {});
    socket.on('data', data => {
      const packet = JSON.parse(data.toString()); requests.push(packet);
      socket.end(JSON.stringify({ id: packet.id, error: { code: 'denied', message: 'private-core-token' } }) + '\n');
    });
  });
}

test('healthy fixture: layered observations, no credentials, no authenticated call or identity invention, no profile writes', async () => {
  const f = fixture(), requests: any[] = [], core = coreFixture(requests), httpRequests: string[] = [];
  const http = httpServer((req, res) => {
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.origin, undefined);
    httpRequests.push(`${req.method} ${req.url}`);
    if (req.url === '/healthz') res.end(JSON.stringify({ healthy: true, transport: 'streamable-http-stateless', secret: 'private-health' }));
    else if (req.url === '/readyz') res.end(JSON.stringify({ ready: true, buildIdentity: { dbPath: f.path }, email: 'private@example.com' }));
    else if (req.url === '/mcp') { res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="private-client-id"' }); res.end('private-http-token'); }
    else { res.writeHead(404); res.end(); }
  });
  try {
    f.write(await listen(core), await listen(http)); const before = f.snapshot();
    const report = await diagnoseHeadless({ root: f.root, timeoutMs: 300 });
    assert.equal(report.core.observation, 'jsonl_auth_denied');
    assert.equal(report.core.identity, 'unknown');
    assert.equal(report.mcp[0].state, 'available');
    const surface = report.mcp[0] as any;
    assert.equal(surface.readiness.profileIdentity, 'matches_selected_profile');
    assert.equal(surface.transport.supported, 'advertised_auth_gated_not_negotiated');
    assert.equal(surface.transport.legacySse.supported, 'absent');
    assert.equal((report.metadata as any).chief.state, 'configured');
    assert.equal((report.metadata as any).workers[0].state, 'configured');
    assert.equal(report.liveConnector.exactConversationPresence, 'unknown');
    assert.equal(report.liveConnector.resultDelivery, 'unknown');
    assert.equal(report.status, 'HOLD'); assert.equal(report.exitCode, 2);
    assert.equal(report.effects.authenticatedCallMade, false);
    assert.deepEqual(requests.map(req => req.method), ['runtime.status']);
    assert.match(requests[0].token, /^doctor-unconfigured-/);
    assert.ok(httpRequests.every(req => ['GET /healthz', 'GET /readyz', 'POST /mcp', 'GET /sse'].includes(req)));
    assert.deepEqual(f.snapshot(), before);
    const serialized = JSON.stringify(report);
    for (const privateText of ['private-', 'private@', f.root, 'chatgpt.com/c/', 'Bearer realm']) assert.ok(!serialized.includes(privateText), privateText);
  } finally { await Promise.all([close(core), close(http)]); f.clean(); }
});

test('closed configured services remain blocked and missing worker model remains blocked', async () => {
  const f = fixture(), reserve = tcpServer(); const unused = await listen(reserve); await close(reserve);
  try {
    f.write(unused, unused); const db = new DatabaseSync(f.path); db.exec('DELETE FROM model_bindings'); db.close();
    const report = await diagnoseHeadless({ root: f.root, timeoutMs: 200 });
    assert.equal(report.configuration.runtime, 'configured'); assert.equal(report.core.listening, false);
    assert.equal(report.core.state, 'blocked'); assert.equal(report.mcp[0].state, 'blocked');
    assert.equal((report.metadata as any).workers[0].state, 'blocked');
    assert.equal((report.publicTunnel as any).observation, 'not_requested');
  } finally { f.clean(); }
});

test('different downstream Core/profile and non-Core listener cannot be labeled ready', async () => {
  const f = fixture();
  const core = tcpServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\n')); });
  const http = httpServer((req, res) => {
    if (req.url === '/healthz') res.end(JSON.stringify({ healthy: true, transport: 'streamable-http-stateless' }));
    else if (req.url === '/readyz') res.end(JSON.stringify({ ready: true, runtime: { buildIdentity: { dbPath: join(f.root, 'different.sqlite') } } }));
    else if (req.url === '/mcp') { res.writeHead(401); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  try {
    f.write(await listen(core), await listen(http)); const report = await diagnoseHeadless({ root: f.root, timeoutMs: 300 });
    assert.equal(report.core.observation, 'different_or_unrecognized_protocol');
    assert.equal(report.core.state, 'blocked'); assert.equal(report.mcp[0].state, 'blocked');
    assert.equal((report.gateway as any).readiness.profileIdentity, 'different_profile');
    assert.equal(report.liveConnector.workerExecution, 'unknown');
  } finally { await Promise.all([close(core), close(http)]); f.clean(); }
});

test('health without POST transport, arbitrary 200/session claims, old SSE and redirects remain distinct', async () => {
  const f = fixture(), core = coreFixture([]); let mode = 'missing'; let redirectFollowed = false;
  const http = httpServer((req, res) => {
    if (req.url === '/healthz') res.end(JSON.stringify({ healthy: true, transport: 'streamable-http-stateless' }));
    else if (req.url === '/readyz') res.end(JSON.stringify({ ready: true, sessionId: 'fake-external-session', host: 'fake-host' }));
    else if (req.url === '/sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); }
    else if (req.url === '/mcp' && mode === 'missing') { res.writeHead(404); res.end(); }
    else if (req.url === '/mcp' && mode === 'weird') res.end(JSON.stringify({ ready: true, sessionId: 'fake-external-session' }));
    else if (req.url === '/mcp') { res.writeHead(302, { Location: '/should-never-follow' }); res.end(); }
    else { redirectFollowed = true; res.end(); }
  });
  try {
    f.write(await listen(core), await listen(http));
    for (mode of ['missing', 'weird', 'redirect']) {
      const report = await diagnoseHeadless({ root: f.root, timeoutMs: 300 }); const surface = report.mcp[0] as any;
      assert.equal(surface.state, 'unknown'); assert.equal(surface.transport.supported, 'unknown');
      assert.equal(surface.transport.legacySse.supported, 'event_stream_observed_not_mcp_session');
      assert.ok(!JSON.stringify(report).includes('fake-')); assert.equal(report.status, 'HOLD');
    }
    assert.equal(redirectFollowed, false);
  } finally { await Promise.all([close(core), close(http)]); f.clean(); }
});

test('absolute time and size bounds handle stalled streams and oversized replies without retries', async () => {
  const f = fixture(), requests: string[] = []; const core = coreFixture([]);
  const http = httpServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/healthz') res.end('x'.repeat(70_000));
    else { res.writeHead(200); res.write('{'); }
  });
  try {
    f.write(await listen(core), await listen(http)); const start = performance.now();
    const report = await diagnoseHeadless({ root: f.root, timeoutMs: 120 });
    assert.ok(performance.now() - start < 2500);
    assert.equal((report.mcp[0] as any).health.observation, 'response_too_large');
    assert.equal((report.mcp[0] as any).readiness.observation, 'deadline_exceeded');
    assert.equal(requests.length, 8); assert.equal(report.bounds.retries, 0);
  } finally { await Promise.all([close(core), close(http)]); f.clean(); }
});

test('WAL and malformed metadata are left untouched; error text and options never leak', async () => {
  const f = fixture(), reserve = tcpServer(); const unused = await listen(reserve); await close(reserve);
  try {
    f.write(unused, unused); const db = new DatabaseSync(f.path); db.exec('PRAGMA journal_mode=WAL'); db.close();
    const before = f.snapshot(); const report = await diagnoseHeadless({ root: f.root, timeoutMs: 100 });
    assert.equal((report.metadata as any).reason, 'live_or_wal_database_requires_owner_provided_quiescent_snapshot');
    assert.deepEqual(f.snapshot(), before);
    writeFileSync(join(f.data, 'runtime-spec.json'), '{private-invalid-json');
    const invalid = await diagnoseHeadless({ root: f.root, timeoutMs: 100 });
    assert.equal(invalid.configuration.runtime, 'invalid'); assert.ok(!JSON.stringify(invalid).includes('private-invalid'));
    const outputs: unknown[] = [];
    assert.equal(await runHeadlessDoctor(['--root', 'private-secret', '--timeout-ms', '5001'], f.root, value => outputs.push(value)), 1);
    assert.equal(await runHeadlessDoctor(['--root', 'a', '--root', 'b'], f.root, value => outputs.push(value)), 1);
    assert.ok(!JSON.stringify(outputs).includes('private-secret'));
  } finally { f.clean(); }
});

test('CLI discovers only selected root; no public request by default and unsafe public URL rejected before network', async () => {
  const f = fixture(), outputs: any[] = [];
  try {
    writeFileSync(join(f.data, 'gateway.json'), JSON.stringify({ version: 1, publicBaseUrl: 'https://user:private@127.0.0.1/secret?token=private' }));
    assert.equal(await runOperator(['doctor', '--root', f.root, '--public', '--timeout-ms', '100'], { output: value => outputs.push(value) }), 2);
    assert.equal(outputs[0].configuration.runtime, 'missing');
    assert.equal(outputs[0].publicTunnel.observation, 'public_url_missing_or_not_safe_devtunnel_origin');
    assert.ok(!JSON.stringify(outputs).includes('private'));
  } finally { f.clean(); }
});

test('service readiness, non-worker Communicators and Gateway instance correlation have separate semantics', async () => {
  const f = fixture(), core = coreFixture([]);
  const http = httpServer((req, res) => {
    if (req.url === '/healthz') res.end(JSON.stringify({ healthy: true, transport: 'streamable-http-stateless', instanceId: 'private-instance' }));
    else if (req.url === '/readyz') { res.writeHead(503); res.end(JSON.stringify({ ready: false })); }
    else if (req.url === '/mcp') { res.writeHead(401); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  try {
    f.write(await listen(core), await listen(http), { nodes: [{ nodeId: 'chief' }, { nodeId: 'worker' }, { nodeId: 'other-chat' }] });
    const db = new DatabaseSync(f.path); db.exec("INSERT INTO node_ontology VALUES ('other-chat','Communicator')"); db.close();
    const report = await diagnoseHeadless({ root: f.root, timeoutMs: 200 }); const surface = report.mcp[0] as any;
    assert.equal(surface.state, 'available'); assert.equal(surface.stateScope, 'transport_only'); assert.equal(surface.serviceReadiness, 'blocked');
    assert.equal((report.metadata as any).workers.length, 1);
    assert.equal((report.metadata as any).otherRegistrations[0].nodeKind, 'Communicator');
    assert.equal(compareGatewayInstances('local-instance', 'remote-instance'), 'different_reported_instance');
    assert.equal(compareGatewayInstances('local-instance', 'local-instance'), 'same_reported_instance');
    assert.equal(compareGatewayInstances(undefined, 'remote-instance'), 'unknown');
    assert.ok(!JSON.stringify(report).includes('private-instance'));
  } finally { await Promise.all([close(core), close(http)]); f.clean(); }
});

test('worker condition uses existing correlated evidence and expires it without repairing missing incarnations', async () => {
  const f = fixture(), reserve = tcpServer(); const unused = await listen(reserve); await close(reserve);
  try {
    f.write(unused, unused);
    const db = new DatabaseSync(f.path);
    db.exec(`ALTER TABLE sessions ADD COLUMN session_id TEXT; ALTER TABLE sessions ADD COLUMN hythe_id TEXT;
      ALTER TABLE sessions ADD COLUMN locator_ref TEXT; UPDATE sessions SET session_id='session',hythe_id='hythe',locator_ref='locator';
      CREATE TABLE session_incarnations (session_id TEXT,owner_node_id TEXT,incarnation TEXT);
      INSERT INTO session_incarnations VALUES ('session','worker','generation');
      CREATE TABLE session_health (session_id TEXT,state TEXT,event_id TEXT,updated_at TEXT);
      CREATE TABLE events (event_id TEXT,kind TEXT,payload TEXT,created_at TEXT);`);
    const updateEvidence = (expired: boolean) => {
      const at = new Date(Date.now() - (expired ? 120000 : 1000)).toISOString();
      const until = new Date(Date.now() + (expired ? -60000 : 60000)).toISOString();
      db.exec('DELETE FROM session_health; DELETE FROM events');
      db.prepare('INSERT INTO session_health VALUES (?,?,?,?)').run('session','available','event',at);
      db.prepare('INSERT INTO events VALUES (?,?,?,?)').run('event','host.health.observed',JSON.stringify({ sessionId: 'session',
        conditionEvidence: { subject: { kind: 'host', ref: 'session', generation: 'hythe:locator:generation' },
          evidenceClass: 'HOST_LOCATOR', outcome: 'AVAILABLE', source: 'host-probe', evidenceRef: 'event', observedAt: at, validUntil: until } }),at);
    };
    updateEvidence(false);
    let report = await diagnoseHeadless({ root: f.root, timeoutMs: 100 });
    assert.equal((report.metadata as any).workers[0].hostCondition, 'AVAILABLE');
    assert.equal(report.liveConnector.workerExecution, 'unknown');
    updateEvidence(true);
    report = await diagnoseHeadless({ root: f.root, timeoutMs: 100 });
    assert.equal((report.metadata as any).workers[0].hostCondition, 'STALE');
    db.exec('DELETE FROM session_incarnations'); db.close(); const before = f.snapshot();
    report = await diagnoseHeadless({ root: f.root, timeoutMs: 100 });
    assert.equal((report.metadata as any).workers[0].hostCondition, 'UNKNOWN'); assert.deepEqual(f.snapshot(), before);
  } finally { f.clean(); }
});

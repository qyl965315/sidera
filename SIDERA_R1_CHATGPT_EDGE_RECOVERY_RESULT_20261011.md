# Sidera R1 Chat-first EDGE recovery — 2026-10-11

## Scope and observation boundary

This is an edge-only recovery report for the `r1-chatfirst-edge` checkout. It
does not alter Core scheduling, the UI, a production database, a tunnel account,
an OAuth client ID, tokens, or a ChatGPT login.

The starting observation is the current Chief tool failure:

```text
MCP SSE probe returned HTTP 404 from openai.org
```

That string is an observation of the ChatGPT-side/proxy probe. It is **not** an
observation of a request reaching the local Sidera listener, a Core RPC failure,
an OAuth rejection, an exact Chief binding failure, or a return-route failure.
No external ChatGPT request was observed during this checkout's isolated tests.

## Exact protocol and route diagnosis

There are two intentionally different server surfaces in the source tree:

| Surface | Listener owner | MCP endpoint | Tool surface | Authentication |
|---|---|---|---|---|
| Existing Chief-compatible GPT Hythe | `hythes/gpt-mcp.ts` (started by `core/service.ts`) | `POST /mcp` | canonical tools, including `chief_dispatch_status` | existing bearer boundary token |
| Generic external Gateway | `hythes/mcp-gateway.ts` / `mcp-gateway-cli.ts` | `POST /mcp` | six stable `sidera_*` tools | per-edge bearer or OAuth |

The generic Gateway's existing OAuth repair is valid for its own public edge, but
it does not make its six-tool outer surface identical to the existing
Chief-compatible `chief_dispatch_status` surface. A tunnel's HTTP 200 health
response likewise says nothing about which of those listeners it forwards to.

The recovered GPT Hythe declares one supported protocol:

```text
Streamable HTTP: POST /mcp with its configured Bearer token
```

It does not implement legacy MCP SSE at `/sse`. A legacy `/sse` probe now receives
HTTP 410 and this machine-readable body:

```json
{
  "schema": "sidera.mcp-protocol-diagnosis/1",
  "code": "LEGACY_SSE_ENDPOINT_UNSUPPORTED",
  "expected": { "transport": "streamable-http", "endpoint": "/mcp", "method": "POST" },
  "coreState": "NOT_PROBED",
  "connectorE2E": "HOLD"
}
```

This is deliberately not a compatibility shim: accepting or faking an SSE
session would hide an incorrect connector registration and could weaken the
existing authentication boundary.

## Machine-readable state

While the existing Chief-compatible listener is running, its unauthenticated
read-only `GET /edge-healthz` exposes `sidera.chatgpt-edge-health/1`. It reports
separate listener, bearer requirement (never the token), authenticated ingress
count, tool-call count, Core readiness observation, and the exact Chat/return/E2E
claims. The latter three remain `false` / `HOLD` until independently observed.

An `Origin: https://chatgpt.com` header is only retained as a boolean diagnostic
observation. It never authenticates a request and is explicitly reported as not
being identity proof. A ChatGPT-looking Origin without the configured bearer token
still receives HTTP 401.

## Isolated regression witness

`tests/gpt-mcp-edge-health.test.ts` starts the actual GPT Hythe on port `0` with
a test-only Core token and test-only boundary token. It proves:

1. authenticated Streamable HTTP `initialize` and `tools/list` requests with a
   ChatGPT web Origin reach `/mcp`, and `tools/list` contains the existing
   `chief_dispatch_status` tool;
2. the edge health counter records the authenticated arrival but still reports
   exact Chat E2E as `HOLD`;
3. an Origin header does not bypass bearer authentication; and
4. `GET /sse` returns the explicit legacy-protocol diagnosis without probing Core.

This is a local protocol witness, not a remote ChatGPT call and not an OAuth or
return-route acceptance.

## Human reconnection step (unavoidable)

The observed 404 originates at the ChatGPT-side probe, and this checkout has no
authority to inspect or modify the existing private ChatGPT connector record.
A Human must perform the one product-side reconciliation:

1. Open the existing Sidera connector for the existing Chief conversation and
   choose **Reconnect**; do not create a new connector, conversation, client ID,
   or replacement Task.
2. Verify the configured public URL forwards to the running
   **Chief-compatible GPT Hythe** and ends exactly in `/mcp`; it must not be an
   `openai.org` URL, a health URL, or an `/sse` URL. Verify it is configured as
   Streamable HTTP, not legacy SSE.
3. If the existing connector is the explicit public-PKCE OAuth Gateway path,
   complete the already-required local owner approval on `127.0.0.1:8791`; do
   not enter a static Core credential or generate a replacement OAuth client.
4. After reconnect, call `chief_dispatch_status`, then perform one read-only
   discovery/list operation in the same existing conversation. Preserve the
   displayed request/error and the listener's `/edge-healthz` snapshot.

Only a correlated product-side tool call plus the listener ingress observation can
advance transport/authentication from unverified. It still does not prove Chief
binding, dispatch, worker execution, or return delivery. Full external ChatGPT
connector E2E is therefore **HOLD**.

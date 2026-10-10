# External MCP Client Nodes — Grok Chat, Gemini Chat, Gemini Spark

These three Nodes already existed as Human-owned Sidera identities. This phase makes
them usable as independent **external MCP-client Nodes**: the product calls the Sidera
MCP Gateway, and the Gateway acts as that Node's exact Core principal.

The Node identities were not recreated, forked or renamed. They have independent
origin lineage, separate Sessions, separate boundary credentials, separate Authority
and separate health.

## 1. Identity and Session facts

| Product | Node ID | Session ID | Hythe ID | Host kind | Locator |
|---|---|---|---|---|---|
| Grok Chat | `4c5f3b7a-70e5-4b33-b67a-2a01dc228453` | `0b1f0f0a-6ed4-4c40-9f4d-2c1f0a7b8e01` | `external-grok-chat` | `external-mcp-client` | `gateway-edge://grok-chat` |
| Gemini Chat | `b4806f5b-71bd-4894-b4a7-22d93d2c17c2` | `1c2e3d4f-5a6b-4c7d-8e9f-0a1b2c3d4e02` | `external-gemini-chat` | `external-mcp-client` | `gateway-edge://gemini-chat` |
| Gemini Spark | `7747ef76-1e9f-4d04-8832-b6d6f0a6c7ef` | `2d3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a03` | `external-gemini-spark` | `external-mcp-client` | `gateway-edge://gemini-spark` |

**No ModelBinding is declared for any of them.** The product-side model is not reliably
controlled by Sidera, so inventing one would assert something Sidera cannot observe.
`provider`, `modelId` and reasoning effort stay empty until a real product-side
observation exists.

## 2. The generic adapter

`hythes/external-mcp-client.ts` is one adapter for every external product that reaches
Sidera as an MCP client. There is no per-product branch, no Grok/ChatGPT/Gemini special
case, and no pair-specific route. Adding another cloud Chat is configuration, not code.

What it honestly declares:

| Aspect | Declaration |
|---|---|
| Inbound operations | Real. The Gateway authenticates the edge credential, resolves the bound Node and calls Core as that Node. |
| `message.receive` | **Not claimed.** Unless the product offers an official machine interface for Sidera to push into the exact conversation, there is no proactive receive. |
| `conversation.send` | **Not claimed.** Same reason. |
| Host controls | None. |
| `canStartTurn` | `false`. Sidera has no way to start a turn inside the product. |
| Session creation | None. These are configured edges, not containers Sidera can create. |
| Effect control | `ProviderAutonomousNonCancelable`: Sidera controls the Gateway boundary, not the product behind it. |

Inbound-only is an accepted state for this import phase. A later real product test may
add an official return/wake route; until then nothing pretends one exists.

## 3. Identity rule (unchanged from Phase 1)

```text
presented boundary credential
  -> exactly one configured edge
  -> its boundNodeId
  -> that Node's exact Core principal
  -> canonical Sidera operation
```

Identity is never inferred from tool arguments, product name, tunnel, model, IP address
or MCP session. Two edges can never borrow each other's Node, and an unknown credential
is refused with HTTP 401 before Core is contacted.

## 4. Presence and health progression

| Step | State |
|---|---|
| Node exists, no runtime Session | `NOT_CONFIGURED` |
| runtime Session declared and accepted by Core | `CONFIGURED` (session health `available`) |
| Gateway edge bound with its own credential | `OFFLINE` / `UNKNOWN` — never `ONLINE` from configuration |
| A real authenticated MCP request arrives from that edge | traffic is observed; `ONLINE` may then be claimed for that edge |
| No recent authenticated activity | `OFFLINE` / `DEGRADED` for that edge only |

A tunnel going down makes the affected edge offline. It never makes Core unavailable,
never rewrites Node identity, and never cancels durable work.

## 5. Endpoint and import configuration

All three edges share one Gateway endpoint:

```text
http://127.0.0.1:8788/mcp
```

Cloud products cannot reach loopback, so a tunnel or public ingress will be needed to
publish that same endpoint. Reachability is transport, not identity: the same server,
the same five tools and the same operations serve local and remote clients.

Generated import configuration is available per edge:

```powershell
node hythes/mcp-gateway-cli.ts init <nodeId> <edgeId>   # bind an edge (idempotent by edge)
node hythes/mcp-gateway-cli.ts profiles                 # write all import profiles
node hythes/mcp-gateway-cli.ts check                    # validate every configured edge
```

Each product receives **only** its own boundary credential. Core credentials never
appear in a generated import configuration; they stay in the private mode-0600
workspace file.

## 6. The one remaining Human authority step

The three edges can already authenticate, resolve their exact Node and perform
read-only work. Publishing a Resource or dispatching work requires that Node to hold a
Human-rooted standing grant, and Sidera never mints one on its own.

A Human runs this once in an interactive terminal:

```powershell
node scripts/human-onboard.ts admit --only 4c5f3b7a-70e5-4b33-b67a-2a01dc228453,b4806f5b-71bd-4894-b4a7-22d93d2c17c2,7747ef76-1e9f-4d04-8832-b6d6f0a6c7ef
node scripts/human-onboard.ts provision --only 4c5f3b7a-70e5-4b33-b67a-2a01dc228453,b4806f5b-71bd-4894-b4a7-22d93d2c17c2,7747ef76-1e9f-4d04-8832-b6d6f0a6c7ef
```

`admit` prints each exact statement and requires the operator to type `ADMIT`; a Node,
model or script cannot satisfy it. `provision` then issues the bounded, non-delegable,
Human-rooted grants. Without it, an external edge's publish is refused with
`Sidera denied: No matching authority grant` — which is the correct fail-closed result,
not a defect.

## 7. Gemini identity caution

Google may expose Chat and Spark through one shared Custom App configuration. Grok Chat
and Gemini Chat may also share a connector mechanism with an Agent-side product.

Shared connector mechanism does **not** merge Nodes:

- separate Node IDs, Sessions, boundary credentials, Authority, health and work history;
- separate gateway edges (`grok-chat`, `gemini-chat`, `gemini-spark`);
- separate import configurations.

Two independent connector instances with independent credentials are the first attempt.
If product-side behaviour proves that one shared connector cannot distinguish the
callers, that is reported as:

```text
PRODUCT_IDENTITY_GRANULARITY_LIMIT
```

It is a product-edge limitation. It does not change Core identity and it does not
authorize collapsing the Nodes.

## 9. Gemini standard OAuth

Gemini rejects a static bearer credential and requires standard OAuth. The Gateway
therefore supports OAuth 2.1 Authorization Code + PKCE (S256) on remote HTTP edges,
implemented with the MCP SDK's authorization handlers rather than a private protocol.

OAuth is boundary authentication only. It answers "is this registered external client
allowed to authenticate as this edge". Sidera Authority still answers what the Node may
do, and no Sidera Grant is created, widened or consulted during login.

```text
OAuth client -> configured edge -> boundNodeId -> exact Core principal
```

Each OAuth client belongs to exactly one edge, so a Gemini Chat token can never
authenticate as Gemini Spark and the reverse is equally impossible.

### Endpoints

| Purpose | URL |
|---|---|
| MCP resource | `<publicBaseUrl>/mcp` |
| Protected resource metadata | `<publicBaseUrl>/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `<publicBaseUrl>/.well-known/oauth-authorization-server` |
| Authorization | `<publicBaseUrl>/authorize` |
| Token | `<publicBaseUrl>/token` |
| Revocation | `<publicBaseUrl>/revoke` |

`publicBaseUrl` is explicit runtime configuration (`gateway.json`), never inferred from a
request host and never bound to a tunnel hostname, tunnel ID or IP address.

### Configuration fields

```jsonc
{
  "publicBaseUrl": "https://<reachable-origin>",
  "accessTokenTtlSeconds": 3600,
  "localOwnerApprovalPort": 8791,       // loopback-only Human approval listener; never tunnel-forwarded
  "edges": [
    {
      "id": "gemini-chat",
      "boundNodeId": "b4806f5b-71bd-4894-b4a7-22d93d2c17c2",
      "coreToken": "<private Node Core credential>",
      "authMode": "oauth",              // bearer | oauth ; defaults to bearer
      "oauth": {
        "clientId": "sidera-gemini-chat-<hex>",
        "clientSecret": "<secret>",     // confidential path; omit for a public PKCE client
        "publicPkceOwnerApproval": false, // true = keep a public client_id but require on-device Human consent
        "clientName": "Sidera gemini-chat",
        "redirectUris": ["<the exact value from Copy Redirect URI>"]
      }
    }
  ]
}
```

`client_secret` and `coreToken` live only in the private mode-0600 workspace file. On the
confidential path the product receives `client_id` + `client_secret`; no Core credential is
ever exposed to a product, a token response, a metadata document or a status command.

A client marked `publicPkceOwnerApproval: true` keeps its registered `client_id` but is
public: metadata advertises token auth method `none` and no secret is required. Because
`client_id` + PKCE alone authenticates no resource owner, `/authorize` does not return a
code. It renders a page that asks the Human to open a separate confirmation page served
by a listener bound to `127.0.0.1` only (`localOwnerApprovalPort`, default 8791; never
forwarded by the tunnel). The Human reviews the exact client, bound Node, redirect URI and
display code, then clicks approve. Approval carries a one-time CSRF token and an exact
same-origin `Origin` check, and only then does the public page complete with a one-time
authorization code. A public client without this flag is still refused code issuance.

### Operator commands

```powershell
# 1. register one OAuth client for one edge (prints client_id + client_secret once)
node hythes/mcp-gateway-cli.ts oauth-init gemini-chat
node hythes/mcp-gateway-cli.ts oauth-init gemini-spark

# 2. record the exact redirect URI the product showed you
node hythes/mcp-gateway-cli.ts oauth-set-redirect gemini-chat "<paste the copied Redirect URI>"
node hythes/mcp-gateway-cli.ts oauth-set-redirect gemini-spark "<paste the copied Redirect URI>"

# 3. inspect what is registered and how many tokens are live
node hythes/mcp-gateway-cli.ts oauth-status

# 4. serve; discovery, bearer edges and OAuth edges run on the one listener
node hythes/mcp-gateway-cli.ts serve
```

Until step 2 is done the edge fails closed: discovery and status stay usable, but every
authorization attempt is refused because no redirect URI is registered. An unregistered
`redirect_uri` is never accepted, and redirect matching is exact.

### Product-side entry

| Field | Gemini Chat | Gemini Spark |
|---|---|---|
| OAuth Client ID | `sidera-gemini-chat-8ec4cc94` | `sidera-gemini-spark-eb49623e` |
| OAuth Client Secret | in `gateway.json` (mode 0600) | in `gateway.json` (mode 0600) |
| MCP URL | `https://<publicBaseUrl>/mcp` | `https://<publicBaseUrl>/mcp` |

Register two independent connectors. Never enter the same client in both products: the
Gateway would see one edge and the second product would be acting as the first Node.

### Quick Tunnel caution

A Cloudflare Quick Tunnel hostname changes whenever the tunnel is recreated. OAuth
metadata and redirect generation read `publicBaseUrl`, so a hostname change is a
configuration update, not an identity change. For a durable product-side import use a
stable hostname; otherwise re-run the two provisioning steps above after the hostname
changes. A tunnel outage makes that edge offline and nothing else.

## 10. Product-side import (after the local side)

1. Publish the Gateway endpoint through the tunnel or ingress.
2. Grok Chat: add the custom MCP connector with the `grok-chat` boundary credential.
3. Gemini Chat: add the custom Connected App with the `gemini-chat` boundary credential.
4. Gemini Spark: add the same custom-app mechanism with the **`gemini-spark`**
   credential — a separate connector instance, never the Chat one.
5. Query `sidera_capabilities`, then run one real read.
6. Only a real correlated round trip may report the edge `ONLINE`.

Do not hand the same credential to two products. The Gateway would see one edge and the
second product would be acting as the first Node — the exact identity borrowing this
design refuses.

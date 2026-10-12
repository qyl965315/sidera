# Headless Chat-first doctor and safe operator recovery

Contract baseline: `d80e936`. The doctor is an engineering diagnostic, not a live connector acceptance test. **Live ChatGPT connector: HOLD.** Normal Human input stays in the existing Chief Chat; Console/Workbench is optional administration. No service startup, OAuth flow, connector reconnect, configuration edit, task dispatch, Host creation or production migration is part of this doctor change.

The owner-directed Chat-first R0 was read at `../../SIDERA_CHATFIRST_R0_20261011.md` relative to this project; the charter's `../SIDERA_CHATFIRST_R0_20261011.md` location was absent. The Constitution and the additive Chat-first precedence correction in the Working Plan govern this document. Older desktop-first instructions remain historical.

## Run the read-only diagnostic

From this isolated checkout, with Node.js 24 or newer:

```powershell
node scripts/sidera.ts doctor --root "D:\Sidera-R1-v0.1.0" --timeout-ms 1500
```

An explicit root selects a profile to **read**, not a profile to start. Omitting `--root` uses `SIDERA_PROJECT_ROOT` when set, otherwise the current project; no parent-profile search occurs. The optional public observation is explicit:

```powershell
node scripts/sidera.ts doctor --root "D:\Sidera-R1-v0.1.0" --public --timeout-ms 1500
```

Output is JSON. `status: "HOLD"` / exit code `2` means the live connector acceptance remains unproven, including when the bounded infrastructure checks succeed. Invalid options produce sanitized `ERROR` / exit code `1`; this diagnostic never emits an E2E PASS or exit code `0`. Individual observations retain `configured`, `available`, `blocked` or `unknown`; they do not inherit a global green state. Surface `state` describes transport only; `serviceReadiness` separately reports the endpoint's declared ready/blocked/unknown state. A timeout is an unavailable observation now, not proof of destroyed runtime resources or permission to retry an Effect.

The doctor reads selected configuration metadata and permitted SQLite metadata, uses bounded loopback probes and, only with `--public`, the configured public endpoint. It does not start services or import live OAuth handlers. It does not submit the selected Node's credential to an arbitrary listener on the configured Core port. Active SQLite WAL/journal state is left untouched and produces unknown metadata rather than opening a connection that might alter sidecars. Credentials, client IDs, conversation URLs, emails and raw server error/log contents are excluded from the report. Do not attach raw configuration, OAuth state, process command lines or private logs when sharing its JSON.

Network requests have a 100–5000 ms absolute deadline each (1500 ms default), a 64 KiB response cap, no redirects and no retries. Local requests run concurrently; the optional public phase follows them. At most 16 configured native MCP ports are inspected. Public probes accept only a configured HTTPS `*.devtunnels.ms` origin without credentials, nondefault port, path, query or fragment. Configuration files are limited to 1 MiB and must resolve within the selected root. Metadata inspection is limited to a 64 MiB, non-WAL database and 32 configured Nodes; the network deadline does not bound filesystem/SQLite execution. The canonical worker condition reader is used only after checking that its existing incarnation is present in the same read transaction, preventing its compatibility repair path. Registered Communicators are not classified as workers. Missing or stale evidence stays UNKNOWN/STALE, and stored Host evidence never proves fresh execution or Authority.

Interpret each layer separately:

| Observation | What it establishes | What remains unproven |
| --- | --- | --- |
| Runtime/Gateway port configured | Selected files name an endpoint | Any listener or supported protocol |
| Core listener plus expected unauthenticated JSONL challenge | A compatible unauthenticated protocol response on that port | Authentication, selected-profile identity, task Authority |
| `/readyz` build database identity matches selected profile | The observed downstream identity matches the selected profile | Exact external conversation or Host execution |
| `/healthz`, `/readyz`, `/mcp` challenge | HTTP reachability, declared health and an authentication boundary | Successful client OAuth or tool invocation |
| `POST /mcp` vs `GET /sse` | Observed Streamable HTTP/legacy SSE compatibility | Successful product-side connector session |
| Registered Chief metadata | Existing exact binding is recorded | Fresh Presence, authenticated ingress or prepared return |
| Worker/ModelBinding metadata | Recorded worker condition and configuration | Current authenticated Host capability or execution |
| Public endpoint response | Bounded current public transport observation | Existing Chief identity, a Grant or delivery |

The Gateway in this baseline serves stateless Streamable HTTP at **`POST /mcp`**; `GET /mcp` returns 405 and old **`/sse`** is not a supported route. A connector's SSE 404 must not be relabeled as healthy merely because `/healthz` works. An HTTP authentication challenge is expected without a bearer credential; it is not a failed login performed by the doctor. A challenged endpoint is reported as advertised/auth-gated, not as a completed protocol negotiation. The report compares public/local Gateway instance identifiers as same/different/unknown without publishing the identifiers. This is a comparison of unauthenticated reports, not cryptographic owner proof.

The charter's 2026-10-11 starting observation was: legacy Core 8765, native MCP 8787, Gateway 8788 and loopback Human consent 8791 closed; configured public tunnel health timed out; DevTunnel CLI provisioned without a hosting process. P5's 47321/47322 belonged to a different developer pilot. These are **historical starting observations**, not promises about the machine when this document is read. Rerun the doctor; never identify production by an open port alone.

## Recovery is a separate, owner-approved operation

Everything below is an operator plan, **not executed by the doctor and not authorized for execution by this bounded PR**. Starting Workbench/Core/Gateway/DevTunnel can write runtime state or expose a listener. First obtain the owning Human's approval for the exact root, code version, service, endpoint, process ownership and proposed change. Do not use the examples as a batch startup script.

1. Keep original `D:\Sidera-R1-v0.1.0`, frozen G2, the current live P5 desktop/profile, existing developer account, DevTunnel account, OAuth configuration and provider credentials unchanged during diagnosis. A later recovery must explicitly select its authorized runtime root. Do not point candidate code at production data by default or launch this checkout as a substitute production instance.
2. Identify the selected profile's runtime spec, database and Gateway config privately. Confirm expected Core/MCP/Gateway/consent ports and the configured public origin. Compare database/profile identity and immutable running build identity, not just Git HEAD. P5 listener 47321/47322 is unrelated to legacy 8765/8787/8788/8791.
3. Check listener ownership with `Get-NetTCPConnection -State Listen`, then correlate each relevant `OwningProcess` with `Get-CimInstance Win32_Process`: executable, creation time, parent, exact script/config/profile selection and original owner. Inspect command lines locally without pasting them into evidence. An unknown owner, different Core, occupied port or mismatched root means stop and reconcile; do not kill it or pick replacement ports.
4. Before a stop/restart, inspect canonical open Task/Run/Attempt and uncertain Effect records under the existing authorized principal. The charter reported zero open production tasks and zero uncertain Effects at its start; this must be reconfirmed at recovery time. Preserve exact original IDs/receipts and owner records. Unknown effects stay UNCERTAIN; do not resubmit work or recreate a session to make diagnostics green.
5. Approve and record one lifecycle owner for each existing component. Start only a confirmed absent component, retain its PID/executable/creation-time/root evidence, and stop only through its owning lifecycle. If an existing owner is live, reuse/reconcile it. No new supervisor, daemon or automatic retry loop is introduced.

## Existing canonical launch commands

These are alternatives or separately owned existing components, not three new background services. Set `$approvedRoot` to the **already reviewed, owner-approved** runtime root before using any example. The placeholder intentionally fails until replaced; it is not an instruction to select production.

```powershell
$approvedRoot = (Resolve-Path -LiteralPath '<owner-approved runtime root>').Path
Set-Location -LiteralPath $approvedRoot
```

**Optional Workbench recovery:**

```powershell
node scripts/local-launcher.ts --no-browser
```

Equivalent existing wrapper: `Start-Sidera.cmd --no-browser`. This launcher derives the root from its own script location, **not** `SIDERA_PROJECT_ROOT`, uses port 47320, calls `LocalSetup.bootstrap()` and attempts to start its Core. It is therefore a mutating lifecycle entry, not a doctor. Run the script belonging to the approved root only; an existing P5/Workbench owner or occupied 47320 requires reconciliation. Do not also launch standalone Core for that profile. Workbench is not required to type in the Chief Chat or to run Sidera headlessly.

**Headless Core recovery, when no Workbench/desktop owner already owns that profile:**

```powershell
$env:SIDERA_PROJECT_ROOT = $approvedRoot
node core/launch.ts
```

`npm run dev` is the package alias for `node core/launch.ts`. The canonical launcher owns Core and its private owner-control endpoint. Do not replace it with a detached `core/service.ts` process. Preserve the profile's existing approved private environment; do not copy another account's provider tokens, native thread variables or Host identity into it. Starting Core may initialize/migrate runtime state, so the owner-approved recovery checkpoint and compatibility check must precede this command.

The exact-owner stop path, only after open-work/Effect checks and approved shutdown, is:

```powershell
$env:SIDERA_PROJECT_ROOT = $approvedRoot
node scripts/core-lifecycle.ts stop
```

Require the actual stop receipt. A refused, missing-owner or uncertain result is not permission to kill by PID/name or repeat the stop. Reconcile the original owner and request. An exit alone does not prove the external Host or its Effects ceased.

**Existing Gateway recovery, after its exact Core/profile and edge bindings are verified:**

```powershell
$env:SIDERA_GATEWAY_CONFIG = Join-Path $approvedRoot '.sidera-dev\sol\data\gateway.json'
$env:SIDERA_RUNTIME_SPEC = Join-Path $approvedRoot '.sidera-dev\sol\data\runtime-spec.json'
node hythes/mcp-gateway-cli.ts serve
```

Run from approved-root code. The explicit paths prevent accidental CWD selection and preserve each edge's exact existing Node principal. `serve` writes lifecycle/ingress/OAuth runtime state; it is not read-only. Preserve existing client/Node/redirect/public-origin configuration and token state; do not run `init`, `oauth-init`, `oauth-set-redirect` or `profiles` as diagnosis. Those commands rewrite configuration or generate credentials/import files. `check` and `oauth-status` are also not substitutes for this privacy-filtered doctor: their legacy output may include credential prefixes, client IDs or redirect URLs. Restart an existing Gateway only through its verified owning process after approval; never terminate unrelated `node.exe` processes.

**Existing DevTunnel recovery, by its existing account/process owner:**

```powershell
devtunnel.exe host sidera-r1.asse
```

This is the historically recorded exact hosting command, not a newly provisioned tunnel. Before executing it, the owner must confirm that the existing tunnel still maps the selected Gateway port to the **same configured stable public origin**, and that no hosting process already owns it. Keep its existing account, identity, access policy and port mapping. If those facts cannot be confirmed, retain HUMAN_REQUIRED/HOLD instead of creating, logging into, renaming or substituting a tunnel. Never forward the loopback Human consent port 8791. Keep the owning foreground process supervised by its approved existing lifecycle; do not add a second hosting process, scheduled task or daemon. `scripts/start-sidera-tunnel.ps1` belongs to the separate Secure MCP Tunnel profile and is **not** a substitute for this DevTunnel ingress.

After each approved component change, run one bounded doctor observation and compare identities. Do not disable TLS verification, replace accounts, rotate client IDs or change the connector URL merely to turn a health check green.

## Human OAuth and actual acceptance

Once the stable configured ingress and existing client are ready, the owning Human may separately approve reconnecting the **original** ChatGPT connector. Preserve its client ID, exact redirect URI, Node binding and existing Chief Conversation. The baseline public client flow uses `publicPkceOwnerApproval` and S256 PKCE. The Human opens the local confirmation page from the authorization flow, verifies the exact client, Node, redirect and display code, then approves on the machine. The consent listener stays loopback-only. Codex/test fixtures must not click or forge owner approval, call `/approve` on the Human's behalf, or manufacture a fresh external session. OAuth authentication does not grant Sidera task Authority.

Then use the original Chief Chat's supported Sidera read/capability tools to obtain a real correlated authenticated response. Report authentication, exact Project/Chief binding, current worker/Host readiness, current Authority and return capability separately. `sidera_read` can summarize supported canonical status when the service exists; this patch adds no new daemon or MCP transport and does not imply the standalone doctor has been installed as a remotely callable MCP operation.

Only a separately authorized real task with the exact request/Task/Run IDs, actual pinned worker receipt/result, and observation in the **original Chief Conversation** can satisfy the Chat-first P0. Supported pull from that conversation is a disclosed capability; it is not unsolicited push into an arbitrary cloud Chat. A URL, Origin header, cached UI, configured Session row, Node name, healthy fixture or listening tunnel proves none of those steps. Missing worker ModelBinding/authentication or a return route remains blocked/unknown. No new Chat, fake Host, Human message relay or uncertain Effect replay is a recovery shortcut.

## Source map

- [Constitution](SIDERA_R1_CONSTITUTION.md): identity, Authority, no browser transport, uncertain Effect boundary.
- [Vision](VISION.md) and [Working Plan](SIDERA_R1_BACKEND_CONVERGENCE_WORKING_PLAN.md): independent headless runtime, Inspect/Probe/Recover, distinct ingress/Presence/return states and canonical lifecycle ownership.
- [README start/inspect/recovery](README.md#start-and-inspect), [package aliases](package.json), [Core launcher](core/launch.ts), [owner stop](core/local-lifecycle.ts), [stop CLI](scripts/core-lifecycle.ts).
- [Workbench wrapper](Start-Sidera.cmd) and [Workbench implementation](scripts/local-launcher.ts): script-derived root, bootstrap, Core ownership and `--no-browser`.
- [Gateway operator/OAuth documentation](EXTERNAL_MCP_CLIENT_NODES.md), [Gateway CLI](hythes/mcp-gateway-cli.ts), [Gateway options and transports](hythes/mcp-gateway.ts).
- [Existing-connector OAuth repair](SIDERA_R1_EXISTING_CONNECTOR_OAUTH_REPAIR_RESULT.md): unchanged original identity and Human-only local PKCE approval.
- [Historical DevTunnel evidence](SIDERA_R1_DSH_REVIEW_REVISION_RESULT.md): existing `devtunnel.exe host sidera-r1.asse` command and distinction from the native Secure MCP Tunnel.

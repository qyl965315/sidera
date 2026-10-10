# Sidera Desktop Architecture R1 — Phase 2

The normal Windows Human flow is installer -> Sidera -> Setup -> Integrations -> owning-product sign-in -> Work -> monitoring -> Updates. CLI is recovery/developer only. Electron 44.5.1 and a separate Node 24 runtime are bundled. R1 Node, Host, Session, ModelBinding, Authority, Presence and Effect semantics remain canonical; no R2 ontology is introduced.

## Installation and private data

desktop/package.cjs copies an explicit production asset/dependency allowlist, excluding private runtime directories, databases, tokens, logs and conversation history. desktop/installer.cjs builds a Windows x64 assisted NSIS installer from the exact portable payload. It defaults to per-user Programs installation, creates a Start Menu shortcut, offers a desktop shortcut, registers uninstall, disallows elevation and preserves app data. [NSIS configuration](https://www.electron.build/docs/nsis/).

The custom NSIS running-app check replaces the default process termination routine. Running Sidera or uncertain process detection aborts installation/uninstall (exit 10); no process is killed. Updates additionally use canonical Core stop. An orphaned standalone Core launched outside the desktop is a recovery condition; the installer does not implement general process discovery/reconciliation.

Application data remains in Electron userData/runtime/.sidera-dev/sol/data, separate from app resources. Uninstall offers no data deletion. Chromium profile/cache is also outside the payload. Installer and portable EXE are unsigned; no Authenticode publisher identity or signing certificate is fabricated.

## Process and renderer boundary

Main owns the window, fixed data-folder action, native Human confirmation, diagnostics export and update state machine. The bundled Node worker owns Workbench and its lifecycle controller. Core owns adapters. Quit requests canonical owner-token stop, respects open Host turns, waits for ownership to disappear and closes Workbench. Blocked/uncertain results preserve ownership and keep the app open. No replay, automatic retry, forced quit or process-name kill occurs.

Renderer is sandboxed/context isolated, without Node integration, webview, secondary windows, external navigation, permissions or production devtools. Private loopback Workbench retains Host/Origin/fetch-site, JSON/content-type, size and strict-schema checks. Native Human confirmation displays the exact reviewed act; model and renderer claims do not manufacture Human authority.

Preload exposes ten fixed functions: diagnostics, openChat(reference ID), openFallback, openDataFolder, exportDiagnostics, updateStatus, checkUpdates, downloadUpdate, installUpdate and openHostGuide(adapter ID). Every handler verifies exact main frame, trusted window and local origin. There is no generic shell, invoke, RPC, downloader, path opener, credentials API or arbitrary write console. The data-folder action selects main's fixed runtime root. Export destination is chosen through a native save dialog.

Normal executable Host setup allows known product basenames codex.exe, grok.exe and antigravity.exe, with fixed adapter arguments. DSH script-entry and ZCode SDK installation are unavailable in normal setup until safe owning-product contracts exist. Existing trusted configuration remains visible and Core-managed. The basename check bounds product commands; it is not cryptographic publisher verification. Installed files remain within local operator/OS trust.

## Updates

desktop/updates.cjs is the canonical main-process boundary. This candidate ships no release-feed.json and never contacts an update server. System -> Updates shows 未配置更新源 / Update feed not configured. No automatic check/download/install or publication is configured.

A future release owner may ship resources/release-feed.json (development: desktop/release-feed.json). Schema: schema=1, exact HTTPS feed, allowedHosts list, format=manifest. Metadata requires schema 1, product sidera-desktop, platform win32-x64, semantic version, installer EXE URL, byte size and SHA-256. GitHub release format uses format=github-release plus exact assetName; only a non-draft/non-prerelease release with one matching asset and sha256 digest is accepted. There is no UI URL/feed field or inferred server.

Metadata is bounded to 64 KiB; installer bytes are bounded by declared size (maximum 1 GiB). Exact HTTPS hosts are allowlisted; credentials, query strings, fragments, ports and redirects are rejected. GitHub redirecting downloads are conservatively rejected: production must supply a compatible direct asset endpoint or add a separately audited redirect policy. Hash mismatch prevents staging; staged installer is hashed again before installation. SHA-256 verifies integrity against metadata, not publisher identity. Native confirmation explains the unverified publisher. Installation launches only after graceful stop succeeds; blocked shutdown never invokes the installer.

## Integrations and MCP

Eight onboarding cards separate installed/configured, sign-in, reachability, authentication, Presence and Ready/Limited evidence. Detection checks only configured adapter-specific files. Built-in API/external MCP adapters do not prove an external client is installed. Authentication and Presence remain UNVERIFIED without canonical observations. Official guidance opens three fixed destinations: Codex authentication documentation, Grok Build documentation and DeepSeek platform. Other external actions are unavailable. Re-check is explicit.

MCP center inventories canonical frontend routes, exact service actor ID, transport, endpoint, binding IDs, mapped capabilities/tools and enabled state. Existing typed Exact return route forms add supported MCP Streamable HTTP integrations; no raw JSON writer exists. enabled is an optional R1 configuration switch; frontendFactory filters disabled routes before construction. Enable/disable/remove require Core stopped and conservatively reject any durable unfinished work. Identity/history/reference migration is not performed.

Health only initializes an enabled configured endpoint and lists tools, using server-side environment credentials, bounded timeouts and disabled redirects/reconnect. It never invokes tools, sends conversations, creates Presence or verifies return. Native bridge inspection requires an owning-product contract and is unavailable here. Advanced shows a read-only sanitized manifest summary. Inbound Sidera gateway remains owned by Core; external client setup remains in the client.

## Exact Chat navigation and diagnostics

Active Chief binding IDs remain supported. Other Nodes may store explicit product/userOpenableConversationRef in a separate private navigation.json sidecar. The typed local Human form checks Node existence and accepts exact ChatGPT/Grok HTTPS paths. It writes no RuntimeSpec identity, Session locator, return route or Presence. Main re-reads and validates each click against product hostname/path allowlists. Missing/unsupported refs are unavailable; URLs are never constructed from IDs. Legacy main policy recognizes Claude/Gemini bindings; new navigation form is conservatively ChatGPT/Grok only.

Main lifecycle logs persist at most 100 sanitized code lines. Workbench logs are also filtered to lifecycle codes. Exported JSON is an allowlisted summary: app/Core/Workbench/Electron versions, redacted private directory indicator, health, update state, adapter configuration and bounded logs. Runtime specs, database, owner tokens, credentials, raw adapter output, user labels and conversation content are excluded. Renderer diagnostics show the fixed data directory for recovery; canonical status uses browser redaction. No credential vault/encryption claim is made.

## Evidence boundary

The Phase 2 report records full checks, packaged/installed UI smoke, synthetic active-turn refusal and payload privacy scans. Fresh install/data on this Windows machine is not disposable VM/fresh OS evidence. Cross-version migration, real external login/return and production update delivery remain external evidence. FULL_ROUTE_READY stays false without canonical return evidence. Opening Chat, configuration and transport health do not constitute external readiness.

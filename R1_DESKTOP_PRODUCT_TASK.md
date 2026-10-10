# Sidera Desktop Product Shell — EXE Direction

Human product decision:
The browser Workbench is transitional. The target product is a Windows desktop application / EXE.

The desired Human experience:
- launch Sidera as an app, not PowerShell;
- install/configure MCP integrations and supported services from inside the app;
- start/stop/monitor those services from inside the app;
- inspect Nodes, Hosts, Sessions, Authority, Effects, routes, health and logs from inside the app;
- click a Node / conversation entry to open the owning external Chat (ChatGPT, Grok, etc.) when Sidera has an exact user-openable conversation reference;
- the desktop app is the normal Human Control Plane;
- web UI may remain as internal renderer/fallback, but normal Human operation should not expose localhost URLs or require a browser.

Current baseline:
- R1 UI completeness pass is complete.
- Frontend surfaces: Work, Nodes, Connections, Authority, Recovery, System, Tools.
- Full tests 258/258 PASS.
- Candidate currently RELEASE_READY_WITH_EXPLICIT_EXTERNAL_LIMITS.
- Existing local Workbench / setup HTTP control plane has canonical backend reuse and Human confirmation semantics.
- PowerShell/CLI is to be recovery/developer only.

## Architectural principle

Do not rewrite the canonical backend.
Build a thin desktop shell around the existing React/Vite UI and local control-plane semantics.

Preferred decision criteria:
1. Minimize new runtime/language/toolchain complexity.
2. Reuse existing Node/TypeScript code.
3. Package to a Windows EXE.
4. Main/native process owns lifecycle, windowing, external-link opening, app data paths and bounded installer/service actions.
5. Renderer remains untrusted relative to main; no arbitrary shell execution bridge.
6. Human-only authority confirmation remains explicit and cannot be triggered by Node/MCP.
7. No generic IPC -> shell/RPC bridge.

Evaluate Electron vs Tauri vs another appropriate Windows shell based on the current repo and installed toolchain. Choose one and document why. Do not choose based on fashion.

## Required deliverables

### A. DESKTOP_ARCHITECTURE_R1.md
Define:
- desktop shell
- renderer
- backend/Core lifecycle
- local admin API / IPC boundary
- secrets
- app data locations
- external Chat opening
- MCP/service install model
- update/logging model
- recovery CLI boundary

Clarify which existing localhost HTTP interfaces remain internal implementation detail versus which can be replaced by IPC later.

### B. Desktop shell implementation
Create a desktop package/project in this workspace.
It must:
- launch as a normal Windows desktop app;
- host the current Sidera frontend internally;
- start/attach to the local Workbench/Core honestly;
- show startup/setup errors inside the app;
- not require the user to open PowerShell;
- not require the user to manually browse to localhost;
- retain Setup/System even when Core is stopped;
- close/quit cleanly without blind-killing active work;
- support open-in-browser only as explicit fallback.

### C. External Chat navigation
Add UI behavior:
- each Node/connection may expose “打开对话 / Open Chat” only when an exact user-openable URI is known;
- opening happens through the desktop shell’s safe external-open API;
- allowed schemes: https (and only other schemes explicitly supported by the owning product);
- no guessed ChatGPT conversation URL;
- no deriving identity from URL;
- if no exact URI exists, show unavailable and explain why.

Do not make external Chat opening equivalent to Presence or return-route readiness.

### D. Integrations / Services center
Create a desktop-oriented Integrations surface for:
- MCP integrations
- Host adapters/services
- install/configure/start/stop/health where bounded R1 support exists
- credentials via environment/secure local reference, never exposed to renderer
- exact actor/readiness labels

No generic “run command” field.
No arbitrary shell.
No raw JSON options editor for normal users.

Where true installation cannot yet be automated safely:
- show Installed / Not installed / Needs Host action / Advanced
- provide an explicit owning-product action when supported
- do not tell normal users to open PowerShell as the primary path.

### E. Desktop logs/diagnostics
System UI should expose:
- recent app/Core/Workbench lifecycle logs
- bounded diagnostics
- version/build
- data directory
- health
without requiring terminal tailing.

### F. Packaging
Produce a Windows desktop release candidate, ideally:
- portable or installer EXE plus required resources
- no private runtime state
- no dev paths/usernames/tokens/logs
- fresh-machine/fresh-dir launch test
- one click -> Sidera window -> Setup
- no visible PowerShell dependency in ordinary use

Do not publish to GitHub yet.

### G. Validation
- existing npm check/tests remain green
- UI build/smoke
- desktop shell tests
- security tests for renderer/main boundary
- external URL allowlist test
- clean install desktop launch test
- Core stopped -> Setup still usable
- missing full route remains false
- Human-only acts cannot be fired by Node/MCP or arbitrary renderer IPC
- no secrets in renderer/devtools-visible payloads
- graceful app exit does not silently kill open Host turns

Write:
- DESKTOP_ARCHITECTURE_R1.md
- R1_DESKTOP_PRODUCT_REPORT.md
- a desktop candidate manifest + SHA256SUMS

Final verdict:
- DESKTOP_RELEASE_READY
- DESKTOP_RELEASE_READY_WITH_EXPLICIT_LIMITS
- DESKTOP_HOLD

Do not redesign R2 Node ontology in this task. This is a desktop product-shell layer over R1.

# Sidera R1 Desktop Product Report

Verdict: **DESKTOP_RELEASE_READY_WITH_EXPLICIT_LIMITS**.

The candidate is a Windows x64 portable application: `candidates/Sidera-Desktop-R1-Windows-x64/Sidera.exe` plus the entire adjacent resources directory. Double-click the EXE to open Sidera Setup. Node and Chromium are bundled; ordinary use requires neither an installed Node runtime, a PowerShell window nor manually browsing localhost. Nothing was published to GitHub.

## Delivered behavior

Electron 44.5.1 was chosen against the installed Node/TypeScript toolchain and the absence of Rust/Cargo on PATH. It adds one JavaScript shell runtime; Tauri/custom WebView2 would introduce another language/build stack while retaining a Node sidecar. The desktop package pins Electron and contains a dedicated main process, sandboxed preload, worker, bounded external-opening policy, build script and security tests. Canonical R1 backend classes/protocols remain in use.

The window internally hosts the current React/Vite product. Workbench starts independently, Core starts or attaches through existing semantics, and Setup/System remains usable with Core stopped. Startup errors are shown inside the app. Browser opening is an explicit fallback only. App data is separate from installed resources. A second launch focuses the existing desktop instance.

Human authority confirmation requires both the existing exact review/typed confirmation and a native main-process dialog displaying the canonical statement. Provisioning and intent ingress also require native approval. Preload has only three bounded operations: diagnostics, exact binding navigation and local browser fallback. No generic shell/RPC/IPC invocation or credential-access bridge exists.

Open Chat uses a recorded active conversation binding. Main re-reads it on click and applies a product-specific HTTPS host/path allowlist. UI enables supported ChatGPT/Grok bindings; missing, unsupported or non-user-openable references show unavailable. No ChatGPT URL is guessed, and non-Chief Nodes without exact conversation records remain unavailable. Navigation does not create Presence, identity or a return route.

Integrations / Services shows local service controls, MCP/Host inventory, typed configuration, separate evidence labels and supported Core start/stop. Third-party installation/login is explicitly Needs Host action / Advanced. Existing typed executable/API/MCP route forms are reused. Environment credential references are accepted; raw secrets are not accepted or returned by the desktop bridge.

System admin, Setup and Integrations expose recent bounded desktop/Workbench/Core lifecycle codes, versions, health and the private data directory. Desktop logs contain lifecycle codes, not raw Host output. Source CLI tools remain recovery/development interfaces.

## Validation evidence

| Check | Result and scope |
| --- | --- |
| `npm run check` | PASS, including desktop worker TypeScript |
| `npm test` | **259/259 PASS**; original 258 tests retained, one native-confirmation/secret-redaction/stopped-Setup test added |
| `npm --prefix ui run build` | PASS, TypeScript and Vite production build |
| `npm --prefix ui run test:smoke` | PASS, existing navigation/state/language checks; no React runtime errors |
| `npm --prefix desktop test` | **3/3 PASS**: HTTPS allowlist/mismatch rejection, exact IPC sender/main-frame/origin checks, no privileged preload bridge |
| Packaged desktop smoke | PASS, candidate copied into a fresh directory with fresh private data; EXE opens Setup, Core starts, Integrations works, Core stops, Setup/System remains usable, no renderer errors |
| Native authority gate | Renderer confirmation alone denied; the canonical pending statement reaches the native gate. Positive approvals in acceptance are supplied by the test driver, not real Human authority |
| Renderer isolation/secrets | `process` and `require` unavailable; preload has exactly three methods. Actual generated runtime/Core tokens absent from status and diagnostics payloads |
| External navigation | Exact binding accepted and `shell.openExternal` invocation intercepted. Arbitrary URL supplied as binding ID rejected. No external browser/Chat side effect occurred |
| Full route | Remains **false** with a healthy local desktop/Core and a bound conversation lacking an actual return route |
| Active turn graceful exit | A valid persisted synthetic task/message/open-run fixture causes the real canonical Core owner stop gate to refuse exit. Core remains ready, original owner unchanged, open turn unchanged. After fixture completion, safe stop and app exit succeed |
| Ordinary native launch | PASS: executable launched with **no debugger flags**, native window present, fresh Setup initialized, normal window close completes. PowerShell is used only by the acceptance driver to inspect/close the native test window |
| Missing bundled runtime | PASS: missing Node produces an in-app startup error; app can quit. A startup-quit reentrancy defect found in this test was repaired |
| Candidate privacy | PASS: allowlisted files only, no `.sidera-dev`, databases, runtime logs, JSONL, development paths, local username or detected credential literals. No screenshot/evidence runtime directory is packaged |
| Redistribution resources | Electron/Chromium notices retained; official Node v24.18.0 license included. This is not a legal certification |

Evidence retained outside the distributable: `desktop-evidence/packaged-smoke.json`, `normal-launch.json`, `startup-error.json`, desktop screenshots and `desktop-backend-tests-full.txt`. The candidate manifest embeds the portable validation results and SHA256SUMS covers its contents. Screenshots were inspected: Setup and the new Integrations surface render in the desktop layout without overlap or clipping of controls.

## Explicit limits

1. This is an **unsigned portable candidate**, not an Authenticode-signed installer. Keep the full directory together. There is no automatic updater, Start Menu integration or background Windows service installer. Manual resource replacement requires safe app exit and preserves user data.
2. Clean directory and clean private data were tested on this Windows machine. A fresh Windows VM/OS and independent physical user double-click acceptance were not performed. The ordinary no-debug native process launch was separately verified.
3. Official third-party Host install/login, secure credential-vault provisioning and independent adapter start/stop are not automated. Core manages its configured adapter set through the existing canonical lifecycle. Unsupported operations are labelled, not replaced by arbitrary shell execution.
4. External open behavior was intercepted during tests. No live owning-product conversation, external MCP integration/login, detached ChatGPT proactive return or real external Host turn was verified. Missing full-route readiness remains false.
5. Only existing active Chief conversation bindings currently supply exact URLs to the desktop. Other Nodes/connections remain unavailable until they possess a canonical exact user-openable reference. Claude/Gemini main-policy patterns are conservative; their UI entries are not enabled in this candidate.
6. Native confirmation responses and the active-turn record are synthetic acceptance fixtures. They test the real application gates but do not constitute a real Human approval or real Host-turn completion.
7. A blocked/uncertain Core stop or an unresponsive Workbench intentionally keeps the desktop open for recovery; it does not offer a hidden force-kill button. Unexpected OS/process termination retains the existing reconciliation semantics and is not a graceful exit.
8. Local loopback HTTP remains the internal renderer/admin transport with canonical origin/Host checks. A compromised OS account or privileged local software is outside the renderer isolation boundary. Future typed IPC/custom-scheme migration must preserve redaction and native Human confirmation.

The candidate implements the desktop product shell over R1; it does not redesign R2 Node ontology or claim that local desktop readiness establishes external conversation capability.

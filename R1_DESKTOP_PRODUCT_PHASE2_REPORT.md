# Sidera R1 Desktop Productization Phase 2

Date: 2026-10-06. Workspace: D:\Sidera-R1-v0.1.0.

**Verdict: DESKTOP_PHASE2_RELEASE_READY_WITH_EXPLICIT_LIMITS**

This is an unpublished Windows x64 candidate. It extends the established Electron 44.5.1 portable desktop with a per-user installer, bounded update system, eight onboarding cards, canonical MCP route management, non-Chief exact Chat navigation and redacted diagnostics export. R1 identity, Authority, Session, Presence and return-route semantics remain unchanged.

## Delivered behavior

| Product area | Result and boundary |
| --- | --- |
| Windows installer | Assisted NSIS EXE, per-user installation, no elevation, Start Menu shortcut, optional desktop shortcut, registered uninstall with owned optional-shortcut cleanup, bundled Node. App data preserved. Running app/uncertain process detection refuses replacement/uninstall; no forced process termination. |
| Updates | Dedicated System -> Updates, main-process state machine, honest no-feed state, typed release manifest and GitHub release metadata support, exact HTTPS allowlists, bounded download, SHA-256 after download and before install, native unsigned-publisher warning, canonical graceful-stop gate. No feed or publication configured. |
| Onboarding | Cards for codex-app-server, dsh-harness-acp, grok-build-acp, antigravity-cli-headless/Gemini, zcode-native-service/GLM, openai-compatible-api, deepseek-api and external MCP client. Configured-file detection, separate sign-in/health/authentication/Presence/readiness, explicit Re-check, bounded official guidance where known. |
| MCP center | Inventory exact frontend service actor and transport, endpoints, binding IDs, semantic capability/tool mapping; typed MCP endpoint form; canonical enabled switch; Core-stopped/no-active-work enable/disable/remove; health initialization/listTools only; read-only manifest summary. |
| Chat | Separate navigation.json metadata for exact ChatGPT/Grok Node conversation refs. Main re-reads and validates allowlists. No guessed URL, Session locator reuse, ID-derived URL, identity mutation, Presence or readiness fabrication. |
| Diagnostics | Versions, fixed data directory, health, updates, integration summary, at most 100 persisted main lifecycle codes, filtered Workbench codes; native destination selection for exported allowlisted JSON; fixed main-process data-folder action. No database/raw Host output/user labels/conversation/token included in export. |
| Fresh machine path | Repeatable bundled-Node validation script and clean Windows checklist. Actual current-machine isolated installation, fresh-data first run, portable launch, reinstall and uninstall smoke completed. Disposable VM evidence pending. |

Normal flow is Install -> launch -> Setup -> Integrations -> connect/sign in in owning product -> Work -> monitor -> update. There is no normal PowerShell step. Existing source CLI instructions remain developer/recovery only.

## Acceptance record

| Required check | Evidence/result |
| --- | --- |
| npm run check | PASS; desktop-evidence/phase2-check.txt |
| full npm test | **266/266 PASS**, original 259 retained plus 7 management/security tests; desktop-evidence/phase2-backend-final.txt |
| UI build + smoke | PASS; phase2-ui-build.txt and phase2-ui-smoke.txt; installed and packaged UI additionally exercised through real Electron |
| desktop tests | **13/13 PASS**; phase2-desktop-tests.txt |
| installer build | PASS, Windows x64 NSIS; phase2-installer-build.txt |
| installer fresh-install smoke | PASS; phase2-installer-smoke.json; real isolated extraction, installed UI, blocked running-app replacement, same-version reinstall, uninstall/data preservation |
| portable smoke | PASS; packaged-smoke.json and phase2-portable-smoke.txt; fresh copied payload/data, bundled Core, renderer isolation, non-Chief exact navigation, graceful stop |
| updater tests | No feed/no network, valid metadata, GitHub exact asset/digest, hash mismatch, staged tampering and blocked shutdown; real packaged install handler also blocked by canonical active-turn gate |
| MCP management tests | Typed inventory, enable/disable/remove, active durable work protection, disabled factory not constructed, real local MCP fixture listTools without tool execution, no invented Presence |
| integration onboarding tests | Eight cards and configuration/authentication/Presence separation; generic shell/runtime rejected by normal Host setup |
| Chat security tests | ChatGPT/Grok exact navigation, unsupported/absent ref unavailable, malformed/scheme/host/credential/query/port/fragment rejection; non-Chief navigation does not modify RuntimeSpec/identity |
| diagnostics redaction tests | Secret/private content excluded by export allowlist; actual native-save export validated in installed app; Core/Node secrets absent from renderer status/diagnostics |
| payload privacy | Portable and extracted installer scanned for private state paths, user/workspace identifiers and credential patterns. Extracted installer payload compared by SHA-256 against every portable payload file. Final scan evidence: phase2-portable-privacy.json and phase2-installer-privacy.json |
| renderer privilege audit | Ten fixed preload methods, exact sender/frame/origin guards, sandbox/context isolation/no Node/webview; no generic shell/RPC/downloader/path opener/credential bridge; typed same-origin server mutations |
| active Host turn gate | Synthetic persisted open turn exercises real canonical Core refusal: quit and update installation blocked, original owner unchanged; NSIS separately refuses any running Sidera |
| real return evidence absent | FULL_ROUTE_READY remains false in fresh setup and packaged Core smoke; opening Chat, configuration, MCP inspection and transport health do not change that fact |

The first restricted test run stalled at existing isolated Chrome tests; a TypeScript parameter-property incompatibility in initial implementation was corrected. Final tests ran successfully with permission to launch local isolated browser/adapter fixtures. NSIS's initial unused-uninstaller-function build warning was fixed. Electron builder prints a signing stage even without a certificate; actual Get-AuthenticodeSignature reports **NotSigned**, which is the release claim.

## Explicit release limits

1. **Unsigned installer/application**: no Authenticode certificate was available to this build. SHA-256 establishes artifact integrity, not cryptographic publisher identity. Windows reputation/SmartScreen behavior on a fresh OS remains unverified.
2. **No production update feed**: this candidate has no release-feed.json, no fake public server, no automatic update and no GitHub publication. Future real feeds require explicit HTTPS host configuration and metadata hashes. Redirects are rejected, so default GitHub browser download URLs that redirect may fail conservatively; a compatible direct asset endpoint or a separately audited redirect policy is required. Production delivery and successful cross-version update installation are not claimed.
3. **Owning-product install/login boundaries**: unsupported automatic installation/login is displayed as Complete in owning product. Only fixed official guidance is opened for known Codex/Grok/DeepSeek destinations. DSH arbitrary script-entry and ZCode arbitrary SDK installation are unavailable through normal Host setup. Existing trusted configurations remain visible/Core-managed. Authentication, ModelBinding and Presence are never inferred from a file, configuration or guidance click. API credential provisioning still uses existing server-side environment references; no new desktop credential vault is provided.
4. **MCP scope is the canonical R1 frontend integration contract**: supported outbound MCP Streamable HTTP routes and installed native bridges are inventoried. There is no generic stdio MCP launcher, arbitrary tool-execution console or OAuth-login implementation. Inbound Sidera gateway is Core-owned and external clients are configured in their owning products. Native bridge health cannot be generalized without its product contract. Unfinished-work protection is intentionally conservative across all durable work.
5. **Fresh OS/VM pending**: no callable Windows Sandbox/Hyper-V validation capability was found; the hardware query was access denied. The repeatable harness/checklist is delivered. Current evidence is the same Windows machine with isolated installation and private data. The validation host does have developer Node installed, although the tested app launches only its bundled runtime with Node removed from PATH. A no-installed-Node fresh OS run, installer wizard visual/shortcut-option interaction and cross-version data migration remain external evidence.
6. **Fixtures are bounded local evidence**: active turns, native Human confirmation responses and external URL openings in smoke tests are synthetic/test-driver/intercepted. The update feed is mocked in memory only, with no network or feed file. Real external Host login, live model identity, external Chat navigation, proactive return and actual Host turn completion were not claimed. Installer data-preservation witness uses the isolated main-process test data override; default-profile/cross-version preservation should also be checked in the disposable VM.
7. **Local OS trust remains**: product executable basename checks are not publisher attestation. Local operator software can replace installed programs. The installer refuses running Sidera but does not reconcile a standalone orphan Core started outside desktop ownership. Use Recovery for such conditions.

## Artifacts and reproducibility

Final delivery is candidates/desktop-phase2/: portable ZIP, unsigned installer EXE, individual candidate manifests, SHA256SUMS, validation scripts/checklist and report/architecture copies. The extracted portable folder is also retained for direct smoke/recovery. No private validation data is placed in final delivery; temporary install-validation folders are moved to desktop-evidence after validation. Checksums are generated after final artifact assembly; manifests record the actual measured limits.

Build from source: npm run check; npm test; npm --prefix ui run build; npm --prefix ui run test:smoke; npm --prefix desktop test; node desktop/package.cjs <new-directory>; node desktop/installer.cjs. Developer-only smoke scripts are desktop/smoke.mjs and desktop/installer-smoke.mjs. The installer builder uses publish=never. There was no GitHub publication or fake release-feed configuration.

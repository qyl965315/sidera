# Sidera R1 Desktop Productization Phase 2

Human decision: continue from the current DESKTOP_RELEASE_READY_WITH_EXPLICIT_LIMITS candidate and add the remaining product-grade desktop capabilities.

Workspace:
D:\Sidera-R1-v0.1.0

Current baseline:
- Electron 44.5.1 desktop shell exists.
- Windows portable candidate exists and launches without PowerShell/installed Node.
- Existing full test baseline is 259/259 PASS.
- Renderer sandbox/context isolation/security boundary is already established.
- Frontend is the Human control plane.
- CLI remains recovery/developer only.
- Do not redesign R2 ontology.

## Product goals

### 1. Windows installer
Add a normal Windows installer in addition to the portable build.

Requirements:
- build an x64 installer EXE using the current Electron stack;
- install under a normal per-user app location unless there is a strong reason otherwise;
- Start Menu shortcut and optional desktop shortcut;
- uninstall support;
- preserve user data across upgrade/uninstall unless Human explicitly chooses data removal;
- no PowerShell UX;
- no private runtime state bundled;
- installer must work without separately installed Node;
- if no Authenticode certificate is available, produce an unsigned installer honestly and surface this as a release limit. Do NOT fabricate signing.

### 2. Update system
Add product-level update support without hardcoding a fake server.

Requirements:
- UI: System -> Updates / 检查更新;
- canonical desktop main-process update boundary;
- support a configured release feed / GitHub Releases-style metadata only when a real feed is configured;
- if no feed is configured, show “更新源未配置” rather than pretending update is available;
- download/update verification must use SHA-256 at minimum; if signature infrastructure is unavailable, do not claim cryptographic publisher identity;
- updater must never overwrite while Core has open Host turns; respect the existing graceful-stop gate;
- no arbitrary URL entry in normal UI;
- no generic downloader;
- tests for no-feed, valid metadata, hash mismatch, and blocked shutdown.

Do not publish or configure a fake public update feed yet.

### 3. Integrations / service install and login guidance
Extend Integrations so each supported Host has a product-grade install/onboarding card:
- codex-app-server
- dsh-harness-acp
- grok-build-acp
- antigravity-cli-headless / Gemini
- zcode-native-service / GLM
- openai-compatible-api
- deepseek-api
- external MCP client

For each adapter expose explicit states:
- Not installed
- Installed
- Needs sign-in
- Configured
- Reachable
- Authenticated
- Presence observed
- Ready / Limited

Rules:
- use bounded, adapter-specific detection/install/open-host actions;
- no generic shell field;
- no arbitrary command execution;
- no arbitrary download URL;
- if Sidera can safely launch the owning app or official login surface from an already-known installed executable/URI, provide that action;
- if installation/login cannot be automated from existing local/product contracts, show “在所属产品完成 / Complete in owning product” and a safe “打开所属产品” action when possible;
- after the external action, provide “重新检测 / Re-check”;
- never manufacture authentication, ModelBinding, or Presence.

### 4. MCP management center
The desktop Integrations page should support ordinary Human MCP management:
- inventory installed/configured MCP integrations;
- add/configure supported MCP endpoints through typed forms;
- enable/disable where canonical config semantics allow;
- health check;
- show capabilities/tools exposed by each integration;
- show exact actor and transport;
- remove/disconnect only when safe and not referenced by active work;
- no raw JSON editor in normal mode;
- Advanced may show read-only raw manifest, but not an arbitrary write console.

### 5. Chat navigation expansion
Expand “Open Chat” beyond only the Chief where exact canonical user-openable references exist.

Requirements:
- connections/nodes may carry an explicit userOpenableConversationRef separate from Session locator and return-route state;
- preserve R1 semantics: opening Chat != Presence != readiness != identity;
- support exact HTTPS destinations only through product-specific allowlists;
- no guessed URLs;
- no URL construction from node/session IDs;
- if exact ref absent, UI shows unavailable;
- add tests for ChatGPT/Grok and conservative disabled states for unsupported exact refs.

Do not mutate canonical identity semantics just to attach URLs. If storing this reference requires a new R1-safe metadata field, keep it clearly navigational and non-authoritative.

### 6. Logs and diagnostics improvements
Complete the desktop System diagnostics experience:
- bounded recent lifecycle logs;
- export diagnostics bundle from UI;
- bundle must redact secrets, user tokens, API keys, private conversation content;
- show app/Core/Workbench versions, data dir, health, update state, integration summary;
- allow “Open data folder” through a fixed bounded main-process action;
- no arbitrary path opener.

### 7. Fresh-machine validation path
Create a repeatable clean-machine validation harness/document.

If a real disposable Windows VM / Windows Sandbox / Hyper-V capability is available locally, use it to validate the installer and first-run flow.
If not available, do NOT fake VM evidence. Instead:
- implement a validation script/package that can be run on a clean Windows machine later;
- perform the strongest current-machine fresh-user-data/fresh-install validation available;
- report VM validation as pending external evidence.

### 8. Product UX
Normal Human flow should be:
Install Sidera -> launch app -> Setup -> Integrations -> connect/sign in -> Work -> monitor -> update

No normal flow should instruct the user to open PowerShell.

### 9. Acceptance
Run and record:
- npm run check
- full npm test (must retain existing 259 unless intentionally extended)
- UI build + smoke
- desktop tests
- installer build
- installer fresh-install smoke
- portable smoke
- updater tests
- MCP management tests
- integration onboarding tests
- chat-open security tests
- diagnostic export redaction tests
- privacy scan over installer payload and portable payload
- verify no generic shell/RPC/downloader/path opener reaches renderer
- verify no secrets are exposed to renderer
- verify active Host turn blocks update/quit replacement
- verify FULL_ROUTE_READY stays false without real return evidence

Write:
- R1_DESKTOP_PRODUCT_PHASE2_REPORT.md
- update DESKTOP_ARCHITECTURE_R1.md
- update README.md Chinese quick start
- produce final candidates under:
  D:\Sidera-R1-v0.1.0\candidates\desktop-phase2\
  including portable ZIP, installer EXE, manifests and SHA256SUMS

Final verdict must be one of:
- DESKTOP_PHASE2_RELEASE_READY
- DESKTOP_PHASE2_RELEASE_READY_WITH_EXPLICIT_LIMITS
- DESKTOP_PHASE2_HOLD

Do not publish to GitHub yet.

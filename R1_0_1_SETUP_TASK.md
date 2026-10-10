# Sidera R1.0.1 First-Run Frontend Setup

We are modifying the unpacked Windows R1 release at D:\Sidera-R1-v0.1.0.

Human product decision: all normal first-run/operator setup operations should live in the frontend instead of requiring PowerShell. The current Human has already run human-onboard admit/provision manually; current activation status has HUMAN_PRINCIPAL/HUMAN_WORLD_MEMBERSHIP/HUMAN_ROOTED_AUTHORITY satisfied, while frontend binding/presence/return route/chief runtime presence/effect profile remain unsatisfied.

## Product goal
Add a local, Chinese-first **首次设置 / Setup** flow to the existing frontend. A normal user should be able to unpack the Windows package, launch the local app, and understand/perform setup without memorizing CLI commands.

## Required setup model
Frontend should present these steps:
1. 本地运行配置 / Runtime configuration
   - detect whether runtime-spec.json exists
   - show config-check result in Chinese
   - offer safe minimal bootstrap creation only when missing
   - do not expose private tokens
2. Human 身份与根权限
   - show current HUMAN_PRINCIPAL / WORLD_MEMBERSHIP / HUMAN_ROOTED_AUTHORITY state
   - show the exact bounded Human statements before admission
   - Human-only confirmation MUST remain explicit: user must type the exact confirmation phrase in the browser. No prefilled value, no one-click silent admission, no automation.
   - preserve the same semantics as scripts/human-onboard.ts
3. 授权落地 / Provision
   - only enabled after the matching Human act exists
   - explain exact grant count/scope before applying
4. Node / Host
   - show configured Nodes and Host kinds
   - distinguish configured, available, unavailable, unverified
   - no fake Presence
   - no automatic Host login
5. Chief 前端绑定
   - show current exact bound conversation if any
   - allow Human to explicitly enter/select a conversationRef only through a Human-confirmed local setup action
   - do not invent/guess the current ChatGPT URL
   - do not claim proactive return unless an authenticated supported route exists
6. 启动与健康
   - Core / MCP / frontend health
   - translated blocker list
   - clearly distinguish “配置完成” from “可执行/可返回”
7. 完成后 lead into the normal project/task Home.

## API / security design
- Keep browser UI served on loopback only.
- Add a dedicated local setup API under the existing Vite integration layer or a sibling server-only module.
- GET/read endpoints may report config/setup state.
- POST endpoints are allowed ONLY for these narrowly defined local operator setup actions.
- Require same-origin + loopback Host checks.
- Never return coreToken/httpToken/API keys/cookies/credentials.
- No generic command execution endpoint.
- No arbitrary file path input.
- No arbitrary RPC method input.
- No retry/replay of uncertain Effects.
- Human admission must be represented as Human local operator ingress, not a Node/model action.
- Do not permit a model/MCP caller to trigger Human-only confirmation.
- Any setup mutation should return exact before/after status and stable error codes.

## Clean-install fix
The R1 package currently assumes an “already provisioned workspace”. Add a safe bootstrap path so a clean package can create the minimum RuntimeSpec + empty DB needed to enter Setup, instead of failing with the generic operator error.

For the minimal bootstrap, use an honest inbound-only local Chief edge if no real Host is chosen yet. It may support read/setup but must NOT claim dispatch or proactive return capability.

## UX
- Add primary navigation item “设置” / “Setup”, but on first run with incomplete prerequisites automatically land on Setup instead of a broken empty dashboard.
- Translate blocker codes into short Chinese explanations while retaining the raw code in advanced details.
- Use the existing R0.2 visual direction; do not revert to generic admin cards.
- Show a progress rail like: 运行配置 → Human → 授权 → Node/Host → Chief → 健康.
- Never show secrets or giant JSON by default.

## Existing CLI
Keep CLI tools working. Refactor shared logic rather than duplicating semantics where practical. Setup UI is a new trusted local Human frontend, not a replacement for the canonical backend rules.

## Validation
- npm run check
- npm test
- ui npm run build
- ui npm run test:smoke
- add setup-specific tests covering:
  * clean install/missing runtime-spec
  * config creation with secrets never returned
  * status read
  * Human confirmation rejected unless exact phrase is supplied
  * duplicate admission idempotence/no widening
  * provision requires admitted act
  * no arbitrary operation/file execution
  * frontend binding requires explicit exact conversationRef and Human confirmation
  * unavailable return route remains blocked, not marked ready
- write R1_0_1_SETUP_REPORT.md summarizing changes and any still-manual product limits.

Do not alter R2 ontology. This is a release usability patch for R1.

# G3 Grok Bot, Grok Build, and Dots — verified discovery (2026-10-11 09:12 CST)

**Status:** DISCOVERY COMPLETE; HOST/PLUGIN END-TO-END INTEGRATION STILL HOLD. This file is engineering evidence, not a new constitution or an assertion of product readiness.

## Ground truth / local machine

- G3 source HEAD before this report: `9a0e529` (accepted G3-P2.3). Working tracked tree unchanged. G3 pilot Workbench on localhost:47511 responded HTTP 200.
- Grok Bot desktop: `C:\Program Files\Grok Bot\Grok Bot.exe` exists. Installed version 0.62.0; Electron app.asar package has productName Grok Bot, **no declared CLI bin or public protocol in package metadata**. The existing Sidera `detectInstalled('grok-build-acp')` returns installed true but supported false, contract `OWNING_PRODUCT_CONTRACT_UNAVAILABLE`. Installing/running the UI is **not proof of Grok ACP API**.
- Grok Build CLI (SEPARATE product): user CLI `grok.exe` v1.0.44 installed. Bounded plan-mode genuine model inference `grok-4.7` returned exact expected `SIDERA_GROKBUILD_PROBE_OK`, exit 0. Evidence: `../GROKBUILD_SMOKE_20261011.out` and `.err`.
- Grok Build native ACP: running `grok --no-auto-update agent stdio` returned protocolVersion 1, `cached_token` and `grok.com` supported auth modes; user-owned existing cached_token authentication succeeded; `session/new` returned an actual Session ID and 4 available models. Report `../GROK_ACP_AUTH_SESSION_20261011.json` (no Session ID, tokens, or account address stored). This is ACP transport + authentication + session proof **only**, not Sidera gated message replay/recovery acceptance.
- Sidera existing `hythes/grok.ts` explicitly states Grok Bot is separate, not impersonated by this Grok Build ACP adapter. It starts an isolated `GROK_HOME`, and its cached login must be valid in that isolated owner home. Do NOT copy cached account tokens or spoof desktop app/host identifiers to force integration.
- Dots: no independent `Dots.exe`, installed app entry, or local Sidera Dots adapter discovered. Dots refers to OpenAI's ChatGPT Dots cloud personal agent product, not an assumed local desktop CLI.
- Dots official docs (https://openai.com/index/introducing-dots/ and https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs): Dots can use users' existing ChatGPT-connected plugins with shared app permissions and approval boundaries. Correct integration direction is **Dots -> existing personal Sidera Plugin -> Sidera MCP/Core**, not fabricated `DotsHythe` or raw Dots account API.
- Existing PRIVATE personal Sidera plugin was found in Plugin Creator account inventory; its provider command `sidera_status` currently returns an internal tool error. A private plugin being created is **not** evidence its underlying MCP server is reachable, nor evidence an individual Dot successfully invoked it.

## Narrow next work / gates
1. G3 production-like isolated Core startup/Chief routes/recovery remains higher priority than host expansion. Preserve original production state and G2 acceptance.
2. Grok Build ACP: verify true Sidera GrokHythe -> exact Host Session -> G2 final Effect Gate -> one admitted literal Conversation -> correlated ACP reply -> persistent history. Authenticate the isolated `GROK_HOME` through supported owning-product login if required. No token copying. Do not treat Grok Bot as the ACP Host.
3. Grok Bot desktop: seek an OFFICIAL owned app integration protocol or user-authorized plugin/IPC endpoint. Until concrete contract evidence exists mark OWN_PRODUCT_CONTRACT_UNAVAILABLE.
4. Dots: restore/validate Sidera Core/MCP/secure tunnel first. Then test an approved private Sidera plugin action from a Dot (if available and connected) and exact scoped results. Never claim automatic cloud-ChatGPT return from local Sidera without proof.
5. No new Basic Rules, cross-world impersonation, provider account migration, speculative Effect replay, login bypass, or simulated acceptance.

## User-facing status
G3-P2.3 accepted; Grok Build CLI genuine inference PASS; Grok ACP authenticated session PASS; Grok Bot unsupported pending official interface; Dots plugin path identified, backend currently unavailable. G3 Final and new product integrations NOT COMPLETE.

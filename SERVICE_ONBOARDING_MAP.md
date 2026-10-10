<!-- GENERATED / DO NOT EDIT: node scripts/generate-evidence-docs.ts -->
# Service onboarding evidence map

generatedAt: 2026-10-07T00:00:00.000Z

Evidence snapshot: deterministic fixture. Fixture is not a current-machine observation. Desktop onboarding derives bounded detector/config facts live; no runtime/config files are read by this generator.
Runtime observations expire. These documents are snapshots, not live truth. Configuration and static implementation never prove connectivity. Model consensus is never proof.

| Interface | Technical | Runtime | Authority | Policy / freshness | Overall | Blocking dimension |
|---|---|---|---|---|---|---|
| codex-app-server | IMPLEMENTED | UNKNOWN | unknown | unknown / NO_EVIDENCE | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced; policy: unknown |
| dsh-harness-acp | IMPLEMENTED | UNKNOWN | unknown | documented_limited / CURRENT | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced |
| grok-build-acp | IMPLEMENTED | UNKNOWN | unknown | documented_supported / CURRENT | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced |
| antigravity-cli-headless | IMPLEMENTED | UNKNOWN | unknown | unknown / NO_EVIDENCE | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced; policy: unknown |
| grok-chat | IMPLEMENTED | UNKNOWN | unknown | documented_supported / CURRENT | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced |
| external-mcp-client | IMPLEMENTED | UNKNOWN | unknown | unknown / NO_EVIDENCE | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced; policy: unknown |
| generic-api | IMPLEMENTED | UNKNOWN | unknown | unknown / NO_EVIDENCE | NEEDS_REVIEW | technical: implementation test evidence missing; runtime: current correlated round trip missing or unavailable; authority: exact-scope grant not evidenced; policy: unknown |

Generic API currently implements only the OpenAI-compatible protocol. Provider policy entries below are archival/provider evidence and do not confer Generic API support. ZCode is not a default integration target.

## OpenAI: Codex

Exact scope: `{"provider":"OpenAI","product":"Codex","interface":"official-client","executionMode":"interactive","authMode":"ChatGPT login","entitlement":"provider allowance","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_supported; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

Codex clients including CLI can sign in with ChatGPT; plan allowance applies.

Limits: Does not document arbitrary third-party app-server orchestration.

- [Codex official evidence](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 287d54ae8fd16a39a8960bcd24970b93b3f37e1e4d2489132ea5aa6cecf77889

## OpenAI: Sign in with ChatGPT

Exact scope: `{"provider":"OpenAI","product":"Sign in with ChatGPT","interface":"participating-app","executionMode":"authorized connected app","authMode":"ChatGPT authorization","entitlement":"provider allowance","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_limited; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-10-21T00:00:00.000Z.

Eligible plan usage requires explicit authorization and supported flow; no API key is shared.

Limits: Local or user-controlled runtime; connected-app-only use; no pooling, sharing or bypass. Sidera participation/approval is unproven.

- [Sign in with ChatGPT official evidence](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 2efe9f3ed37bf3f7b90873b30fa470f1264de5356625a0a9686910d7e0aacce4
- [Sign in with ChatGPT official evidence](https://openai.com/policies/sign-in-with-chatgpt-terms/); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 2efe9f3ed37bf3f7b90873b30fa470f1264de5356625a0a9686910d7e0aacce4

## Google: Gemini CLI

Exact scope: `{"provider":"Google","product":"Gemini CLI","interface":"official-cli","executionMode":"local/headless cached auth","authMode":"Google login","entitlement":"Google AI Pro/Ultra or eligible allowance","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_supported; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

Individual Google sign-in supported; headless can use cached auth.

Limits: Without prior auth, use API key or Vertex AI. No inheritance to Antigravity internal/headless interface.

- [Gemini CLI official evidence](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 9b6add0d4608e722d807ebfcf8eed0df2af90bcd37756caa38c56915c389df7d

## DeepSeek: DeepSeek API

Exact scope: `{"provider":"DeepSeek","product":"DeepSeek API","interface":"OpenAI/Anthropic-compatible API","executionMode":"API","authMode":"API key","entitlement":"API quota","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_supported; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

API-key compatible access documented.

Limits: Does not prove runtime authentication.

- [DeepSeek API official evidence](https://api-docs.deepseek.com/zh-cn/); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 68b122cdb9616c9b3792fd19462d654985aa4d8dcb9de8e627e1e31938d60a0e

## DeepSeek: DeepSeek Harness

Exact scope: `{"provider":"DeepSeek","product":"DeepSeek Harness","interface":"ACP harness","executionMode":"developer-preview automation","authMode":"owning-product auth","entitlement":"provider allowance","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_limited; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

Harness Developer Preview available to harness developers worldwide.

Limits: Exact local session/auth automation needs separate runtime evidence.

- [DeepSeek Harness official evidence](https://api-docs.deepseek.com/zh-cn/); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: d71c30948d7fad96a16a9b4fb12cedcff95dc07aa73b9b60a665b0d24c0a8027

## xAI: Grok Build

Exact scope: `{"provider":"xAI","product":"Grok Build","interface":"CLI/ACP","executionMode":"headless/ACP","authMode":"local auth or API key","entitlement":"provider allowance","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_supported; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

TUI, scripts/bots and ACP automation documented; local auth or XAI_API_KEY.

Limits: Does not prove authenticated Sidera Host session.

- [Grok Build official evidence](https://docs.x.ai/build/overview); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 5d0febf4829e2b0697d32ee4930ad6823c5614cf02f36b2f06a7b03a0a172183
- [Grok Build official evidence](https://docs.x.ai/build/cli/headless-scripting); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 5d0febf4829e2b0697d32ee4930ad6823c5614cf02f36b2f06a7b03a0a172183

## xAI: Grok Chat

Exact scope: `{"provider":"xAI","product":"Grok Chat","interface":"custom MCP ingress","executionMode":"control ingress","authMode":"required connector auth","entitlement":"connector entitlement","accountType":"individual","deployment":"publicly reachable server"}`

Policy: documented_supported; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

Custom MCP server URL with required authentication; public reachability required.

Limits: Does not prove Sidera binding/import/login or model execution access.

- [Grok Chat official evidence](https://docs.x.ai/grok/connectors); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: ba5e4757482530fe05fd771c346a52c8cd3d39384c5da7ab1c4579d110d2097f
- [Grok Chat official evidence](https://docs.x.ai/grok/connectors/custom-mcp-tunneling); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: ba5e4757482530fe05fd771c346a52c8cd3d39384c5da7ab1c4579d110d2097f

## Z.ai: ZCode

Exact scope: `{"provider":"Z.ai","product":"ZCode","interface":"official-app model connection","executionMode":"official application","authMode":"account authorization or API key","entitlement":"GLM Coding Plan or API quota","accountType":"individual","deployment":"user-controlled"}`

Policy: documented_supported; freshness: CURRENT; checkedAt: 2026-10-07T00:00:00.000Z; nextReviewAt: 2026-11-06T00:00:00.000Z.

Z.ai/BigModel authorization, Coding Plan quota and compatible API providers documented.

Limits: Does not document zcode-native-service machine interface.

- [ZCode official evidence](https://zcode.z.ai/en/docs/configuration); retrievedAt: 2026-10-07T00:00:00.000Z; canonical_claim_bundle_sha256: 6b0469b0e33f50f3b785eb3f9a681d505ed754dc537744577ea0410eefea2c8a

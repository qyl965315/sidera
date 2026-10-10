# Sidera Evidence Governance Layer — implementation task

Workspace: D:\Sidera-R1-v0.1.0
Date: 2026-10-07

Human product decision:
"Supported" must not be one self-declared adapter field. Sidera must separate:
1) technical implementation fact,
2) current runtime fact,
3) authority/governance fact,
4) official-use/policy evidence.
Only a derived projection may summarize them. Model consensus is never proof.

Do NOT publish to GitHub. Do NOT read or print credential/token/API-key values. Do NOT perform external model work or login. Treat current filesystem as authoritative. Preserve the current active Human-owned Chief binding and current Gateway/Core runtime data. Validation may use isolated fixtures.

## A. Kill the overloaded CONNECTED semantics

Current bug:
hythes/mcp-gateway.ts TARGET_EDGES statically uses statuses such as CONNECTED / READY_FOR_IMPORT even when runtime health is UNKNOWN and no correlated round trip exists.

Refactor the public/evidence model so static capability is clearly separate from runtime connectivity.

Required concepts (exact names may be adjusted if better):
- interfaceSupport: IMPLEMENTED | PARTIAL | DECLARED | UNSUPPORTED
- runtimeConnectivity: OBSERVED_CONNECTED | DEGRADED | OFFLINE | UNKNOWN
- runtime evidence must contain observedAt, expiresAt/freshness, evidenceRef/correlation where available.
- A static adapter or configured Session MUST NEVER by itself produce OBSERVED_CONNECTED.
- Remove/retire static CONNECTED as a product truth. If backward compatibility is needed, expose an explicitly named legacy field, never a misleading status.
- Update MCP compatibility rendering, status output, tests and docs accordingly.

## B. PolicyEvidenceRegistry

Implement a provider-neutral registry independent of adapters. It must NOT let an adapter grade its own policy status.

Suggested schema:
supportSubject:
  provider
  product
  interface
  executionMode
  authMode
  entitlement
  accountType
  deployment

policyEvidence:
  status: documented_supported | documented_limited | unknown | stale | conflicted | unsupported
  exactScope: structured subject or equivalent
  officialSources: [{url,title,publishedOrUpdatedAt?,retrievedAt,sourceHash,hashKind}]
  checkedAt
  checkedBy
  nextReviewAt
  claims[]
  limits[]

Evidence source type/state must be independent:
- types: implementation_test | protocol_test | runtime_observation | official_document | provider_terms | human_attestation
- states: current | stale | superseded | conflicted | unavailable

Freshness:
- Derive CURRENT/STALE from checkedAt/nextReviewAt; do not hand-author "fresh".
- Policy conclusions outside their exact scope cannot be inherited by adjacent products/interfaces.
- Runtime mismatch does not automatically rewrite policy. Surface it as a separate machine/runtime conflict.
- A generated support summary should become SUPPORTED only if the dimensions required for that exact subject are satisfied.
- Unknown stays unknown.

Seed initial policy subjects from current official evidence reviewed by the supervising GPT on 2026-10-07. IMPORTANT: the hash must be honestly labeled. Do not pretend to hash remote page bytes if unavailable. It is acceptable/preferred to hash a canonical local claim bundle and set hashKind=canonical_claim_bundle_sha256.

Initial official evidence:

1. OpenAI — Codex with ChatGPT account
URL: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
Current official claim: Codex clients including Codex CLI can sign in with ChatGPT; usage is subject to the plan allowance.
Exact scope for Sidera: Codex official client/account login is documented. This does NOT automatically document arbitrary third-party app-server orchestration.

2. OpenAI — Sign in with ChatGPT plan usage
URL: https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
Terms: https://openai.com/policies/sign-in-with-chatgpt-terms/
Current official claim: participating apps can let users explicitly authorize eligible ChatGPT plan usage; no API key is shared. Terms require supported flow/user authorization, local or user-controlled runtime, connected-app-only use, and prohibit pooling/sharing/bypass.
Exact scope: preferred future Sidera OpenAI entitlement path; Sidera itself is NOT to be marked participating/approved unless independently proven.

3. Google Gemini CLI auth
Official repository page:
https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx
Current claim: local Gemini CLI supports Sign in with Google for individual Google accounts, including Google AI Pro/Ultra. Headless can use cached auth; without prior auth, docs direct to API key or Vertex AI.
Exact scope: Gemini CLI. Do NOT transfer this policy conclusion to the current Antigravity internal/headless adapter. Antigravity/Sidera exact policy status remains unknown unless separately documented.

4. DeepSeek API + Harness
URL: https://api-docs.deepseek.com/zh-cn/
Current claim: DeepSeek API supports API-key OpenAI/Anthropic-compatible access; DeepSeek Harness is a Developer Preview for harness developers worldwide.
Exact scopes:
- DeepSeek API key path: documented_supported.
- DeepSeek Harness developer-preview mechanism: documented_limited; exact local Sidera session/auth automation remains runtime evidence, not policy proof.

5. xAI Grok Build
URL: https://docs.x.ai/build/overview
Headless/ACP URL: https://docs.x.ai/build/cli/headless-scripting
Current claim: Grok Build supports TUI, headless scripts/bots, and ACP in other apps; headless/ACP can use existing local auth or XAI_API_KEY.
Exact scope: Grok Build CLI/ACP automation mechanism documented_supported. Do not infer a current authenticated Sidera Host session.

6. xAI Grok custom MCP connector
URL: https://docs.x.ai/grok/connectors
Tunnel URL: https://docs.x.ai/grok/connectors/custom-mcp-tunneling
Current claim: Grok supports custom MCP connectors; MCP server URL plus required auth; server must be publicly reachable.
Exact scope: Grok Chat custom MCP ingress mechanism documented_supported. Does not prove current Sidera binding/import/login.

7. ZCode / Z.ai
URL: https://zcode.z.ai/en/docs/configuration
Current claim: ZCode supports Z.ai/BigModel account authorization and GLM Coding Plan quota directly, and API-key/OpenAI/Anthropic-compatible providers.
Exact scope: official ZCode application/model connection. The current Sidera zcode-native-service local-service machine interface is NOT documented by this source; policy for that interface remains unknown.

Review cadence:
- Default policy review <= 30 days for provider docs/terms.
- Terms-sensitive/OpenAI SIWC <= 14 days.
- The registry must be able to become stale automatically.

## C. Four-dimensional support projection

For each onboarding/integration subject expose separate machine-readable dimensions:
- technical: implementation/interface support + tests
- runtime: current correlated observation only
- authority: granted/denied/unknown for relevant scope
- policy: registry result + freshness + exactScope

Derived overall values, e.g.:
SUPPORTED
SUPPORTED_WITH_LIMITS
NEEDS_REVIEW
UNAVAILABLE
UNSUPPORTED

Rules:
- Overall SUPPORTED must not be possible when policy is stale/conflicted/unknown if the integration depends on that policy assertion.
- Current runtime UNKNOWN cannot become CONNECTED based on config.
- For control ingress such as ChatGPT -> Sidera MCP, policy/model-entitlement classification must not be conflated with model-execution access.
- Generated UI/prose should explain which dimension is blocking, not just show one green/red state.

## D. Runtime/static/doc conflict detection

Implement conflict detection such that examples like:
- configured ZCode interface exists,
- detector says stale/missing executable,
- static adapter exists,
are shown as distinct facts and an explicit machine evidence conflict/NEEDS_REVIEW, not silently collapsed.

Do not call static implementation "connected".
Do not call old generated docs canonical.

## E. Productize it

Integrate the support projection into the existing DesktopManagement/onboarding/status data.
Normal UI stays simple. Advanced/evidence disclosure may show the four dimensions, freshness, exact policy scope and official source URLs.
No token/secret values.

If feasible in one pass, add a compact Evidence/Support section to Settings -> Advanced or integration details. Do not add a generic execution console.

## F. Generate docs from canonical registry

Create a deterministic generator for:
- SERVICE_ONBOARDING_MAP.md
- MCP_COMPATIBILITY.md

Both must:
- contain a GENERATED / DO NOT EDIT marker,
- include generatedAt and evidence freshness,
- derive policy claims from the registry,
- derive current machine installation/config conflicts through bounded read-only detector/config data where appropriate,
- never embed credentials,
- state that runtime observations expire and docs are snapshots, not live truth.

Add a check/test that fails if committed/generated docs drift from the generator output under the same fixture/snapshot. For current-machine-dependent output, either generate a checked current-machine evidence snapshot first or design deterministic fixture mode plus a separately timestamped local observation section.

## G. Testing / acceptance

Required:
- npm run check PASS
- full npm test PASS
- npm run desktop:test PASS
- npm --prefix ui run build PASS
- npm --prefix ui run test:smoke PASS
- focused new evidence-governance tests
- static CONNECTED semantic removed from static edge support
- freshness transition tests
- exact-scope non-inheritance tests (Gemini CLI != Antigravity; ZCode app != zcode-native-service; Codex client != arbitrary third-party orchestration)
- conflict test for configured-vs-detector mismatch
- docs generation deterministic/drift test
- no credential values in generated evidence/docs
- privacy scan on final candidate/evidence if packaging is changed

Write:
- EVIDENCE_GOVERNANCE.md
- EVIDENCE_GOVERNANCE_RESULT.md
- policy-evidence registry artifact (JSON/TS as appropriate)
- updated/generated SERVICE_ONBOARDING_MAP.md
- updated/generated MCP_COMPATIBILITY.md

Do not package/release unless source changes require a candidate only for validation; if packaged, keep unreleased.
Final verdict:
EVIDENCE_GOVERNANCE_READY
EVIDENCE_GOVERNANCE_READY_WITH_LIMITS
EVIDENCE_GOVERNANCE_HOLD

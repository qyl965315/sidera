# Sidera provider-neutral API consolidation

Human decision (2026-10-07):
- Remove DeepSeek API as a first-class/special Sidera integration.
- Replace it with one provider-neutral Generic API integration.
- DeepSeek Harness remains a separate supported Host.
- ZCode is no longer a first-class/default R1 integration. Do not spend product/UI/onboarding effort on it. Existing dormant adapter code may remain only for compatibility/history; it must not appear in default onboarding, product tiles, target matrix, or new-host forms.
- Do not delete old user credential files automatically.

Current production runtime-spec has only external-mcp-client Chief + Codex, so no live deepseek-api/zcode node migration is required.

## Required architecture

1. Canonical new API Host kind:
   - Prefer `generic-api`.
   - Provider-neutral product label: "Generic API" / "通用 API".
   - It MUST NOT imply a provider.
   - Add an explicit protocol field. For this pass, only `openai-compatible` is implemented. Be honest about that in UI/evidence.
   - Reuse the existing OpenAI-compatible protocol engine internally.
   - Existing `openai-compatible-api` may remain as a hidden legacy alias if needed for backward compatibility, but it must not be advertised as a first-class product.
   - `deepseek-api` must not remain an accepted new Host kind, factory target, manifest target, onboarding adapter, product tile, guide, or default.

2. Generic credential storage:
   - Remove DeepSeek-specific `saveDeepSeekKey`, `desktop:save-deepseek-key`, `deepseek-credential.bin` loading, and worker logic that only sets DEEPSEEK_API_KEY.
   - Replace with a provider-neutral desktop API such as `saveApiCredential(credentialRef,key)`.
   - Accept only `env:NAME` where NAME matches [A-Za-z_][A-Za-z0-9_]*.
   - Store values encrypted with Electron safeStorage in one local generic credential store (e.g. api-credentials.json with base64 ciphertext values), mode 0600, atomic replace.
   - Never log or expose values.
   - On desktop startup, load/decrypt valid stored generic API credentials into the worker environment before worker spawn.
   - When opening owning-product login processes (Codex/DSH), scrub every generic API credential env name so credentials cannot leak into unrelated child apps.
   - Do NOT delete the legacy deepseek-credential.bin automatically; simply stop loading it.

3. Generic API UX:
   - Product tiles/default onboarding: Codex, Generic API, Grok Build, Gemini/Antigravity, DeepSeek Harness, MCP. No DeepSeek API tile. No ZCode/GLM tile.
   - Generic API setup should be normal-user friendly: name, provider identifier, base URL, optional API key. Advanced may expose/derive the local credential env reference.
   - If an API key is entered in desktop mode, save it via the generic encrypted credential API, then configure the Host using only the env reference.
   - Allow no-key loopback/local providers where credentialRef is absent.
   - Do not expose raw secrets in evidence/diagnostics.
   - HostSetup advanced form must have no provider-specific defaults and no adapter selector between DeepSeek/OpenAI. It configures Generic API with protocol=openai-compatible.
   - Remove DeepSeek-specific modal and official-guide action.

4. Core/schema/factory:
   - `apiHostInput`: canonical hostKind `generic-api`; protocol `openai-compatible`; providerId; baseUrl; optional credentialRef.
   - `LocalSetup.addApiHost`: persist provider protocol/providerId/baseUrl/credentialRef without inventing authentication/model binding.
   - hostFactories + manifest support `generic-api`.
   - Keep a hidden `openai-compatible-api` alias only if necessary for old configs. If retained, label it legacy in code and do not surface it.
   - Remove `deepseek-api` factory and manifest entry.
   - Remove dedicated `hythes/deepseek.ts` preset; migrate its stream-usage test to instantiate the generic protocol engine with DeepSeek-style provider compatibility data, proving DeepSeek can be one provider behind Generic API rather than a special adapter.

5. Evidence governance:
   - Remove `deepseek-api` from INTEGRATION_SUBJECTS / onboarding projections.
   - Add `generic-api` exact subject as provider-neutral and policy unknown/NO_EVIDENCE by default.
   - Keep the DeepSeek API official policy evidence entry if useful as provider evidence; it is evidence for DeepSeek's API, NOT evidence that Generic API as a whole is supported and must not auto-inherit.
   - Generated SERVICE_ONBOARDING_MAP.md and MCP_COMPATIBILITY.md must reflect no special DeepSeek API integration and no ZCode first-class target.
   - Add tests that DeepSeek policy evidence does not automatically make a generic-api integration SUPPORTED.
   - ZCode official policy evidence may remain archival/provider evidence, but no ZCode integration row/target in generated default product docs.

6. ZCode product retirement:
   - Remove zcode from DesktopManagement default adapters, ProductApp products, ExecutableHostSetup selectable fields, Gateway TARGET_EDGE_IDS/TARGET_EDGES and generated default compatibility matrix.
   - Existing low-level zcode adapter implementation/tests may remain dormant for historical compatibility; do not delete it unless clearly safe.
   - New manual setup should not allow creating zcode-native-service.

7. Tests/acceptance:
   - npm run check
   - npm test
   - npm run desktop:test
   - npm --prefix ui run build
   - npm --prefix ui run test:smoke
   - npm run evidence:check
   - focused tests for:
     * deepseek-api absent from new-host schema/factory/default UI/onboarding
     * Generic API accepts arbitrary providerId/baseUrl with optional credentialRef
     * generic credential store validation + no secret leakage
     * generic credentials scrubbed from Codex/DSH child env behavior (unit-test helper where practical, no real login)
     * DeepSeek provider evidence does not inherit to generic-api exact subject
     * ZCode absent from first-class/default target matrices
   - Run a static search proving no `DeepSeek API` first-class UI label and no `deepseek-api` factory/schema target remain. Historical docs/evidence text may still mention DeepSeek API as provider policy evidence.
   - Do not publish/package/release.
   - Preserve current Human-owned Chief binding and live runtime data.
   - Do not inspect or print any actual credential values.

Write `GENERIC_API_CONSOLIDATION_RESULT.md` with concise changes, validation, and remaining limitation that Generic API protocol coverage is currently OpenAI-compatible only.

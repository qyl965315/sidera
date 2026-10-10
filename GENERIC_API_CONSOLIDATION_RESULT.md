# Generic API consolidation result

**Verdict: GENERIC_API_CONSOLIDATION_READY**

Date: 2026-10-07  
Workspace: `D:\Sidera-R1-v0.1.0`

## Product decision implemented

Sidera no longer treats DeepSeek API as a first-class provider-specific integration. API-backed model services now enter through one provider-neutral **Generic API** Host.

The default integration surface is now:

- Codex
- Generic API
- Grok Build
- Gemini / Antigravity
- DeepSeek Harness
- MCP

ZCode/GLM and DeepSeek API are not default product integrations.

## Generic API contract

Canonical new Host kind: `generic-api`.

Current protocol:
- `protocol: openai-compatible`

Configuration:
- Human-facing name
- provider identifier
- base URL
- optional API key / optional `env:NAME` credential reference

No-key loopback/local services are supported. A provider such as DeepSeek can still be connected as one provider behind Generic API, but it receives no special adapter, policy inheritance, UI tile, credential path, or factory branch.

`openai-compatible-api` remains only as a hidden legacy configuration alias where needed for old configs. It is not advertised for new setup.

## Credential handling

Provider-specific DeepSeek credential handling was retired.

Desktop now uses a generic encrypted credential store:
- validated `env:[A-Za-z_][A-Za-z0-9_]*` references only
- Electron `safeStorage` ciphertext
- atomic local file replacement
- mode 0600
- values are loaded before worker spawn
- values are never returned in diagnostics/evidence
- configured Generic API credential environment variables are scrubbed from Codex and DeepSeek Harness owning-product login child environments

The old `deepseek-credential.bin` file is not loaded and was not automatically deleted.

## ZCode retirement

ZCode was removed from:
- default UI integrations
- Desktop onboarding
- new executable Host setup
- Gateway default target matrix
- generated default compatibility matrix

Low-level ZCode implementation/tests remain dormant for historical compatibility and do not block the R1 product path.

## Evidence governance

`generic-api` is a provider-neutral exact support subject with policy `unknown / NO_EVIDENCE` by default.

DeepSeek API official documentation remains only as provider policy evidence. It does **not** confer support to Generic API. Generated onboarding/compatibility documents reflect this separation.

## Final validation

| Check | Result |
|---|---|
| `npm run check` | PASS |
| full `npm test` | **290/290 PASS**, 0 fail, 0 skipped, 0 cancelled |
| `npm run desktop:test` | **16/16 PASS** |
| `npm --prefix ui run build` | PASS |
| `npm --prefix ui run test:smoke` | PASS |
| `npm run evidence:check` | PASS |
| focused Generic API + OAuth tests | **16/16 PASS** |
| retired API/default ZCode static audit | PASS |

Final acceptance logs are under `evidence/generic-final-*.log`.

The OAuth expiry test was made deterministic at the provider boundary so it no longer depends on MCP client background/reconnect behavior; production token validation behavior was not weakened.

## Remaining limitation

**Generic API is provider-neutral, but its implemented wire protocol is currently OpenAI-compatible only.**

Additional protocols such as Anthropic-compatible should be added later as explicit `protocol` implementations under the same Generic API product, rather than creating provider-specific first-class adapters.

No live Human-owned Chief binding or runtime data was migrated. No provider login, packaging, publication, release, or external model work was performed.

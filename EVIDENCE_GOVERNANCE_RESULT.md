# Evidence governance result

**Verdict: EVIDENCE_GOVERNANCE_READY_WITH_LIMITS**

Date: 2026-10-07  
Workspace: `D:\Sidera-R1-v0.1.0`

## Delivered

- Static edge implementation is no longer reported as runtime `CONNECTED` / `READY_FOR_IMPORT`. Static capability uses `interfaceSupport`; runtime connectivity is a separate expiring observation.
- Added a provider-neutral `PolicyEvidenceRegistry` with exact-scope matching, source type/state, review deadlines, official-source URLs, limits, and honest `canonical_claim_bundle_sha256` hashes.
- Added four independent support dimensions: **technical / runtime / authority / policy**, plus machine conflicts, blockers, and derived overall state.
- Added automatic policy freshness: provider evidence defaults to 30 days, Sign in with ChatGPT evidence to 14 days.
- Missing exact-scope evidence is now explicitly `NO_EVIDENCE`, distinct from an existing but expired `STALE` record.
- Runtime evidence requires exact scope, correlation, evidence reference, observed time, and expiry. Configuration, installation, login hints, or Session existence cannot create `OBSERVED_CONNECTED`.
- Exact-scope non-inheritance is enforced: Gemini CLI != Antigravity; ZCode official app != `zcode-native-service`; official Codex client login != arbitrary third-party app-server orchestration.
- Desktop onboarding and Settings → Advanced expose support/evidence and blocking dimensions without exposing raw credentials or adding a generic execution console.
- `SERVICE_ONBOARDING_MAP.md` and `MCP_COMPATIBILITY.md` are deterministic generated artifacts with **GENERATED / DO NOT EDIT** markers and drift checks.
- Generated policy registry is `evidence/policy-evidence-registry.json`; its provenance explicitly says the seed is a Human-provided official-source review snapshot and assistant transcription is not provider approval.
- OAuth expiry testing was made deterministic with a test-only injectable clock boundary; production behavior still defaults to `Date.now`.

## Final validation

| Check | Result |
|---|---|
| `npm run check` | PASS |
| Full `npm test` | **286/286 PASS**, 0 fail, 0 skip/cancel |
| `npm run desktop:test` | **13/13 PASS** |
| `npm --prefix ui run build` | PASS |
| `npm --prefix ui run test:smoke` | PASS |
| Focused evidence-governance tests | **10/10 PASS** |
| Generated-document drift check | PASS |
| UI UTF-8 replacement-character audit | PASS |
| Static edge `CONNECTED/READY_FOR_IMPORT` semantic search | PASS — none found |
| Generated governance evidence privacy scan | PASS |

Final logs are under `evidence/final3-*.log`.

## Evidence boundaries retained

1. Policy entries record the official-source claims reviewed on 2026-10-07. The generator does **not** claim to have hashed remote page bytes; hashes cover the canonical local claim bundle.
2. Sidera is **not** claimed to be a participating/approved Sign in with ChatGPT application.
3. Existing live Gateway/Host observations and Core grants are not automatically imported into the policy registry. A runtime or authority dimension remains unknown until trusted exact-scope evidence is supplied.
4. Generated documents use a deterministic fixture snapshot, not a claim about the current machine. Live installation/configuration conflicts are surfaced separately by Desktop onboarding.
5. No provider login, external model work, package/release, GitHub publication, Chief rebinding, Gateway config mutation, or Core runtime-data migration was performed by this governance pass.

## Canonical artifacts

- `core/evidence-governance.ts`
- `tests/evidence-governance.test.ts`
- `scripts/generate-evidence-docs.ts`
- `evidence/policy-evidence-registry.json`
- `EVIDENCE_GOVERNANCE.md`
- `SERVICE_ONBOARDING_MAP.md`
- `MCP_COMPATIBILITY.md`

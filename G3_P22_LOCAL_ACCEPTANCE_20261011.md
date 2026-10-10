# G3-P2.2 Local Communication admission acceptance (2026-10-11)

Scope: isolated G3 source checkout only. **Local contract accepted, not production or full G3.** Baseline prior commit 456b3e3.

## Independently verified machine evidence
- npm run check: exit 0; G3_P22_FINAL_TSC.log.
- node --test --test-concurrency=1 tests/*.test.ts: **390/390 PASS**, 0 fail, 0 skipped, 0 cancelled; G3_P22_FINAL_ALL_TESTS.log.
- npm --prefix ui run build: exit 0; G3_P22_FINAL_UI_BUILD.log.
- npm --prefix ui run test:smoke: exit 0; G3_P22_FINAL_UI_SMOKE.log.
- npm run evidence:check: exit 0; G3_P22_FINAL_EVIDENCE.log.
- Prior Windows Electron script: 21 screenshot checks PASS, no page errors; G3_P22_ELECTRON_20261011.log.
- Real Antigravity CLI native duplex was verified earlier, and **actual AntigravityHythe** established a native Session, returned accepted and one exact correlated terminal from account-authenticated agy CLI: G3_ANTIGRAVITY_REAL_HYTHE_SMOKE_20261011.json. The adapter used an explicit **synthetic test EffectBoundary**, not Core authorization and not a production Conversation.

## Security and compatibility changes
- Local Workbench human.conversation.view/send now refuses ambiguous locally enrolled Human sources, so a browser selector or a local-owner bearer is not assumed to authenticate an arbitrary World Human.
- For an older installation with a literally single enrolled Human but no new Desktop Conversation source, the first private view is permitted without requiring retroactive re-enrollment. After trusted local device ingress exists, that active source determines the eligible Human.
- One Human can see only their own literal body and correlated Host reply in the private transcript. A second local Human without actor-specific sign-in is fail-closed.
- Original durable queued message may be **explicitly continued** with the same nonce only before the external Effect crossing; sending/uncertain/delivered/observed never replay.
- OpenAI-compatible Host supports a typed ordinary Human Conversation without inventing Task/Run or task_dispatch tools. Deterministic injected HTTPS/SSE test verifies one correlated answer; it is not proof of a live provider account.
- Work stays the primary UI, Console remains the Human-facing Boundaries UI, and no untrusted model response is synthesized.

## Remaining G3 / release blockers
1. Native Desktop Chat → canonical Core → **real authenticated Host** → exact reply → durable restart evidence, including actual G2 Effect permission, is not yet proven end to end.
2. External ChatGPT Chief MCP remains inbound-only. No unverified push to a selected cloud Chat conversation.
3. Fresh isolated production-like startup and cold recovery, Task/Result tests, nonsecret provisioning/onboarding, and stable 24h run remain.
4. Gemini CLI personal OAuth succeeded in browser but official client returned IneligibleTierError UNSUPPORTED_CLIENT. Never bypass. Antigravity authenticated real Host works independently.
5. Current admin Console needs release smoke against a live Core; visual/browser fixture-only checks are not product signoff.

No original production DB, Rules, identities, external accounts or Google credentials are changed by the P2.2 source work. The backed-up Sidera original remains unchanged. Do not declare full G3 ACCEPT on this report.

# G3-P2 local Communication verification — 2026-10-10

Verdict: LOCAL_VERTICAL_SLICE_VALIDATED. **G3 product / live provider Chat / production signoff: HOLD.**
Source parent: G3 P1 commit 58a3c2b, accepted G2 efe1ace. All work isolated to g3-stage/project.

## Machine-observed tests after Codex partial implementation
- Full backend node --test --test-concurrency=1 tests/*.test.ts: exit 0; G3_P2_FULL_SERIAL.log, 384/384 PASS, 0 fail, 0 skipped. Serial avoids an existing Chromium concurrency/test-sandbox timeout; no assertion suppression.
- npm.cmd run check: exit 0, G3_P2_TSC_INDEPENDENT.log.
- npm.cmd run evidence:check: exit 0, G3_P2_EVIDENCE_INDEPENDENT.log.
- npm.cmd --prefix ui run test:smoke: exit 0, G3_P2_UI_SMOKE_INDEPENDENT.log.
- npm.cmd --prefix ui run build: exit 0, G3_P2_UI_BUILD_INDEPENDENT.log.
- Native Windows Electron node desktop/hierarchy-visual.mjs: exit 0, 21 screenshots, no errors, using existing isolated dependency junction. This is fixture-based UI validation.

## Scope implemented
- Typed Human Conversation ingress through same-origin local Workbench to Core private local-owner RPC; exact active Chief binding, World membership, canonical Human utterance, current Node authority and G2 final Effect/Attempt.
- Durable client nonce and original Bus message correlation; Host ACK versus genuine result observed, duplicate and speculative results gated.
- Privately bound message body view in Communication; unsupported Host and non-Conversation forms remain blocked rather than returning synthetic model text.
- Work remains default; Console remains Human Boundaries, not a Node.

## Known release boundaries
- All positive Host tests use an isolated deterministic fixture, not authenticated external ChatGPT/Codex/Gemini production. NO full G3 end-to-end acceptance or native live Chat delivery claimed.
- No independent third-model security signoff was obtained in this pass. Post-implementation security review and live exact-Host tests remain.
- Native desktop configuration, provider sign-in, exact Human return and credentials were not changed.
- Google network issue diagnosed separately: Clash Verge active profile 谷歌服务 pointed to a failing specific node while Gemini group used 节点选择. The persistent selection was backed up and corrected to 节点选择, but the already-running Mihomo routing state was not reloaded; normal accounts.google.com still times out. Do not claim fixed until official group refresh and HTTP/TLS retest.

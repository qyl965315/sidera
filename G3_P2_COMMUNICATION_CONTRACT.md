# G3-P2 — Real Communication and Chat contract, 2026-10-10

Status: bounded engineering contract, NOT Basic/World/Project/Task Rules. G3 source checkout only. Parent UI baseline: f27465a; P1 acceptance: G3_P1_GPT_ACCEPTANCE_20261010.md. Preserve Constitution 2026-10-08 and backend G3 working plan 2026-10-09. Human explicitly asks for a functional Chat, functional Console, stable Backend and no common AI-brand aesthetic. No new vendor integrations.

## Single objective
A real Human using the existing Windows Sidera Desktop can open a correctly bound Conversation with one genuinely reachable Communicator Node, send a literal message exactly once, see real correlated receive/result and prior messages after a restart, and inspect accurate unavailable/unknown states. The same underlying Communication history must integrate with Work/Task/Chief without inventing a parallel state authority or turning a Human into an Operator. Prefer reusing existing canonical Core RPC/Bus/History/Authority/Effect. The existing ChatGPT external Chief route remains valid if it is supported by provider ingress/return. A native local Chat client is a Frontend; it is never a Node or alternative Authority.

## Required invariants
1. Communication forms: Human–Communicator Conversation, Communicator–Communicator Discussion, Communicator–Operator Thread, Operator–Operator Messaging. Do not redefine kinds or let Human send as Node.
2. NodeRef, D/E, ModelBinding, real Host session are separate. Selecting model never changes Node or Sovereignty.
3. Human input requires exact local same-origin Human source and appropriate semantic admission, same-world and exact project/conversation binding; setup/transport alone is no permission. Every outward action must pass current capability/Authority and G2 final Effect gate.
4. Send uses a **client-supplied stable request/message nonce**, persisted before dispatch, exact destination, and idempotent reservation so browser retry cannot duplicate effects. Unknown result remains UNCERTAIN with no automatic replay. Duplicate/late Host replies are correlated, never synthesized.
5. Messages and History: preserve real user/body privacy. Shared History includes provenance/reference, not whole private transcript by default. If private message storage is required, tie it to canonical existing record IDs/revisions; do not create a second independent task/result truth. A transcript can show only actual admitted body and actual verified received assistant output with timestamps/status/correlation.
6. UI: mature engineering desktop; 13–14px type, flat grayscale with blue-gray accent, narrow rail, Conversation left pane, message chronology/detail center, compact composer. No AI-style gradients, bubble chat gimmicks, streaming dots, animations or giant AI avatars. Disabled/send-block reasons must be legible and specific.
7. If a verified real route cannot be established without owning product login or authenticated endpoint, DO NOT create a fake assistant or bypass it. Implement the accurate route contract, test with a local deterministic adapter, and classify live provider route as HUMAN_REQUIRED/UNRESOLVED with evidence. Never claim synthetic loopback is full G3.
8. Console remains Human Boundaries graphical view; Work remains default project/task subject. Preserve existing operations and auth. No production data/account/OAuth changes.

## P2 acceptance
- Native client can read exact real messages/revisions, send through a typed/local-owner-aware path into canonical Core and registered Communicator when genuinely reachable, and receive correlated verified result if Host actually responds; no fake text or unverifiable completion.
- Gated negative tests for unbound/wrong Human/World, no Authority, blocked Host, stale incarnation, duplicate send, lost response, restart, speculative Host feedback, double-click/timeout, concurrent attempts. Guard origin/cross-site, size and content. Same live API permits no generic unrestricted RPC/shell.
- Test native Chat UI both blocked and successful fixture states (separately labeled); message ordering, text, status, keyboard, localization and integration with Work. Current P1 read-only status on tabs other than supported Conversation remains truthful.
- Full backend regression (381 baseline, C2), UI build/typecheck/smoke, Evidence, Windows Electron visual screenshots 1024x768/1280x850/1440x900, + one **real owned Host** roundtrip if verified and authorized. Distinguish harness integration from provider production.
- Maintain source checkpoint, commit only if clean; no source-rewriting Constitution or extending Basic Rules. Preserve G2 acceptance.

## Operational target
After P2 implementation, GPT will independently verify logs and request DSH safety review. P3 = full system startup, Chief/Codex actual link, bounded restart and long observation. Product not final until real task results and stable core verified.

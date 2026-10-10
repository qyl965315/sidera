# G3-P2.3 — Antigravity native Communication integration (2026-10-11)

**Engineering acceptance for the scoped isolated implementation only. NOT G3 final or production deployment.** Parent Git commit: ba23910 (G3-P2.2).

## Source and UI changes
- AntigravityHythe recognizes native agy 1.3 string model identity in init while still rejecting absent/invalid model attestation. Explicit model selection is pinned to the installed Host instead of trusting an invented auto default.
- A Human Conversation (kind=conversation, no Task/Run) is sent to the genuine native Host without synthesizing Task/Run or instructing a Task delegation. The existing Operation/Task prompt retains its semantics.
- The Host sends through an exactly scoped EffectBoundary with the caller's locatorRef. The Core's action/Attempt/Host-correlation logic remains authoritative.
- DesktopManagement.checkService reads actual installed agy models and exposes sanitized model identifiers as catalog evidence, NOT provider sign-in or entitlement verification.
- LocalSetup's explicit model choice is required; model catalog is independently rechecked before writing a new Antigravity NodeSpec. No broad/default model selected on the Human's behalf.
- The Work/Integrations GUI displays an Antigravity model selector; the Connect control remains disabled until an explicit selection. Tested end-to-end with fixture-only UI, not production.
- Antigravity is a distinct agent Host name. Gemini CLI remains an unrelated official client whose personal OAuth currently returns IneligibleTierError UNSUPPORTED_CLIENT; no credentials or client impersonation applied.

## Independently observed evidence
- 391/391 backend regression tests pass, 0 failures: G3_P23_ALL_TESTS_20261011.log.
- TypeScript check, UI production build, UI smoke, Evidence audit, native Electron screenshots, git diff whitespace check ALL exit 0: G3_P23_*_20261011.log.
- Isolated actual agent onboarding: ANTIGRAVITY_ONBOARDING_SMOKE_20261011.json (14 actual listed models; missing model blocked; explicit tested model persisted correctly).
- Native AntigravityHythe actual account Host Session, acceptance, and one exact correlated result: G3_ANTIGRAVITY_REAL_HYTHE_SMOKE_20261011.json (adapter-only synthetic EffectBoundary).
- **Real Core Effect Gate / Bus / Conversation ledger to real authenticated agy/Gemini inference and back**: G3_REAL_CORE_ANTIGRAVITY_ROUNDTRIP_20261011.json. PASS with one Effect Attempt, one real model reply, exact Session/HostRef/messageId correlation, persisted assistant transcript, no fabricated Task or Run. The trial used **SYNTHETIC TEST HUMAN / GRANTS / EXTERNAL IDENTITY in an in-memory DB**, not user production credentials, no production modification.

## Honest product blockers
- Actual user desktop against persistent isolated Core with enrolled Node/ModelBinding/Authority, restarts, and model service is not yet end-to-end proven.
- External ChatGPT Chief is inbound-only; native Chat targeting another registered Communicator needs an exact authorized binding distinct from the existing external Chief. No guessed delivery back into the ChatGPT browser.
- Existing real provider identity must be reconciled with Sidera canonical Node ModelBinding rather than assuming catalog/sign-in checks establish Authority or Presence.
- Cold starts, recovery, stable runtime and production candidate packaging remain G3.
- Official Gemini CLI authorization succeeded in browser but provider returned UNSUPPORTED_CLIENT. Antigravity is available and works; Gemini CLI is not silently substituted.

No original production DB or G2 frozen checkout changed by P2.3. Keep source evidence and private test credential identifiers out of public release artifacts.

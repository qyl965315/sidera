# G3-P3 today HOLD — 2026-10-11

## Implemented source scope

- Antigravity now rejects an absent or non-absolute Node MCP entry before it launches `agy`.
- New executable-Host setup resolves `node-mcp-entry.ts` from the portable backend asset root, the isolated source root, or the executing backend module directory. It does not write a known-absent source or `app.asar` path.
- Antigravity writes a per-Node private Core binding file in its isolated workspace and supplies that file as the required second argument to `node-mcp-entry.ts`. The Core token is removed from the owning Host environment.
- A `CONFIRMED_LOST` Host has a Human-reviewed, one-shot recovery proposal. Service startup durably changes an approved request to `attempting` before the provider boundary. Success records the distinct Registry handoff; an error/crash leaves `blocked`. Neither path replays old effects, turns, or the recovery request.
- The local Status UI exposes a reviewed recovery action only for `CONFIRMED_LOST`; ordinary local Conversation remains the typed Human route, not a Node/CLI path.

## Green evidence

- The focused Antigravity, Conversation, G2 recovery, and convergence groups passed; the first combined 43-test run found only the expected private-Pilot port collision in installed detection. After the fixture was moved to 49731–49736, `tests/installed-detection.test.ts tests/desktop-management.test.ts` passed 9/9.
- `npm.cmd run check`: passed.
- `npm.cmd --prefix ui run build`: passed.
- `npm.cmd --prefix ui run test:smoke`: passed after its WebSocket test port was free.
- `npm.cmd run evidence:check`: passed.
- `npm.cmd --prefix desktop test`: 16/16 passed.
- `git diff --check`: passed.

## Precise blockers / limits

- The running private Pilot owns Core port 47321. Existing configuration fixtures that also used that port were changed to 49731–49736; no Pilot process, database, profile, OAuth state, port, or 47511 frontend was modified.
- The full `node --test --test-concurrency=1 tests/*.test.ts` process was started separately at 2026-10-11 local time and intentionally left running. Its log ceased progressing after the passing Generic API group, while the parent process remained alive. It has no final exit code and is not green evidence. It was not killed or retried.
- `npm.cmd run desktop:package` is blocked before packaging because this checkout lacks `desktop/assets/sidera.ico` and `desktop/assets/sidera.png`.
- `node desktop/smoke.mjs` is blocked because the expected `candidates/r1-desktop-candidate` input is absent. The incomplete `candidates/r1-desktop` directory created by the failed package command was removed; existing `desktop-evidence/` was preserved.
- The installed `agy.exe` was found (native 1.3.3), but the current execution context could not write its private app-data directory and it reported no active Antigravity login. No real inference, real Human send, or provider recovery was submitted. This is not evidence against an account in another protected profile; it is a current-context blocker.

## Commit decision

No commit was made. The contract requires a green full suite and Electron desktop smoke before committing, and those terminal conditions are not currently met.

# Headless doctor engineering checkpoint

Contract baseline: `d80e936b456052cf5bd4179065ab75837f1f08bd`.
Date: 2026-10-11. **Scoped implementation verified; live Chat-first connector HOLD.**

## Scope and implementation

- Added `node scripts/sidera.ts doctor --root <workspace> [--public] [--timeout-ms 100..5000]` and a diagnostic-only module. Existing operator commands retain their path.
- Separate configuration, listener, Core JSONL rejection, HTTP health, declared readiness, profile mismatch, MCP POST challenge/ping and legacy SSE observations. No real credential is transmitted; response content, headers, identifiers, paths, client IDs and private metadata cannot pass through into JSON.
- Public probes are opt-in, HTTPS DevTunnel origin only, with the same absolute deadlines/body limit and no redirects/retries. Public/local Gateway instance comparison is redacted and explicitly unauthenticated.
- Non-WAL metadata reads use SQLite read-only/query-only mode, never the application's DB initializer. Operator classification and stored Host condition are separate from registration and Authority. The condition reader's incarnation repair fallback is guarded out. WAL/journal or unavailable schema returns UNKNOWN without repair.
- No OAuth, gateway, Core Chief, production config, frozen G2 or P5 code changes. No new service, connector reconnect, authenticated external call, task, Host or Session was created by the doctor.
- Recovery directions are in `HEADLESS_DOCTOR_RECOVERY.md`. All recovery starts and Human OAuth consent remain a separately approved operator operation.

## Validation

| Check | Result |
| --- | --- |
| `npm.cmd run check` | PASS, TypeScript no-emit |
| `node --test tests/headless-doctor.test.ts tests/human-literal-intent.test.ts` | PASS: 13/13, including 9 new doctor cases and 4 existing CLI/Human intent cases |
| Doctor fixtures | Healthy protocol, closed ports, different service/Core profile, missing POST transport, arbitrary fake session claims, legacy SSE, redirects, stalled and oversized bodies, secret filtering, no profile writes, WAL refusal, invalid CLI/config, Communicator classification, Gateway instance comparison, fresh/stale/missing-incarnation worker evidence |
| Fixture external effects | No model call or real DevTunnel; servers use temporary directories and OS-assigned loopback ports |
| Recovery document local links | PASS: 15/15 resolve |
| Generated evidence content | PASS against all four exact `d80e936` Git blobs; working files match after CRLF normalization |
| `npm.cmd run evidence:check` | FAIL in unchanged baseline working files: raw CRLF vs generated LF, first reported `SERVICE_ONBOARDING_MAP.md`; no regeneration or out-of-scope edit made |
| Full `npm.cmd test` attempt | NOT GREEN / NOT COMPLETE: 191 passes and 2 failures reported before progress stalled; the owned test command was interrupted. No full-suite pass is claimed |

The reported full-suite failures were the unchanged desktop native-boundary test and generated-document byte comparison. A focused reproduction of `tests/desktop-boundary.test.ts` failed with `STOP_CORE_BEFORE_CONFIG_CHANGE` from `core/local-setup.ts` when adding the fixture Node. `tests/desktop-boundary.test.ts`, `core/local-setup.ts`, `scripts/local-launcher.ts`, `tests/evidence-governance.test.ts` and `scripts/generate-evidence-docs.ts` were verified unchanged from `d80e936` (line-ending normalization only). This identifies a baseline-path failure; it does not claim a complete separate baseline-suite run. The full run's last reported tests were the Generic API group; the cause of the subsequent stall was not established. No unrelated implementation was changed to hide these failures.

The PowerShell `npm` wrapper is disabled by local execution policy; validation used the existing `npm.cmd` entry, without changing policy.

## Actual local/public observation

See `live-observation.json`, recorded at `2026-10-11T11:30:56.724Z` (19:30:56 Shanghai).

- Configured legacy Core 8765, native MCP 8787, Gateway 8788 and local Human consent 8791 all returned `connection_refused` on loopback. These observations concern those configured endpoints only; P5 ports 47321/47322 were not probed or treated as production.
- The optional configured public DevTunnel requests returned `connection_error` in this execution environment. Remote endpoint health and public/local instance correlation remain UNKNOWN; the result does not establish whether the cause is local network restriction, DNS/TLS, tunnel hosting or the remote service. There was no retry or hosting action.
- Production SQLite is WAL-backed. The doctor declined to open it, so Chief/worker metadata remains UNKNOWN in this observation. The charter's earlier registered Chief/missing worker binding statements were not independently refreshed or promoted into current facts.
- `production-readonly-check.json` records before/after SHA-256 equality and existence for runtime spec, Gateway config, SQLite, WAL, SHM, OAuth state and Core owner record: all seven unchanged. No credential values or fingerprints are included in the shareable report. This is a sampled-file boundary check, not a claim about every file on the machine.
- Exit code `2`, `status: HOLD`: authenticated Chief ingress, exact current Conversation Presence, worker execution/Authority, prepared return and actual result observation were not exercised.

Independent bounded review found and led to fixes for transport/readiness ambiguity, public instance comparison, non-Operator classification, metadata size limits and a fixed invalid-credential sentinel. Only scoped source, tests, recovery documentation and diagnostic evidence are intended for commit.

# Sidera R1 usability closure

Verdict: USABILITY_READY_WITH_LIMITS. This is an unreleased local usability candidate, not proof of external login, product reconnect or model cooperation. Current source was treated as authoritative after the disconnected turn; intentional OAuth/Gateway changes were retained and audited. No GitHub publication, external account login or external model work occurred in this continuation.

## Product changes

Simple is default: five navigation entries, three-step first run, plain service states, generated private configuration and Advanced disclosure. DeepSeek API and Harness are distinct. Codex, DSH and Gemini are automatically detected; DSH/Gemini automatic configuration was exercised against actual installed packages in an isolated candidate profile. Grok's missing contract and stale ZCode are reported honestly. The existing blue star/orbit icon remains unchanged; portable EXE and NSIS wiring preserve it.

MCP has bounded discovery, link and typed snippet import with preview, list-only health and no execution console. Reports implement independent detail/precision controls, preserve unknowns, and support native copy/export. See the three companion documents for exact capability limits.

## Human gate

Renderer sends a review ID over a guarded, exact-main-frame desktop IPC only. Main process requests the server-held review through private worker IPC, displays its exact canonical statement in a native confirmation dialog, and supplies a one-use result. HTTP approve/confirm routes always reject and cannot invoke that dialog. Renderer has no reusable confirmation secret or approved flag. Expiry, configuration fingerprint, policy epoch and exact statement remain checked when applying after the dialog. CLI confirmation remains recovery/developer only.

Packaged smoke intercepted the real main-process dialog handler to CANCEL and verified exact scope. No real Human approval was asserted. Positive application and one-time/expiry/fingerprint/epoch boundaries were verified with local fixtures. The screenshot is the ordinary renderer review, not an OS dialog capture.

## OAuth and reconnect audit

2026-10-08 Codex revision supersedes the earlier authentication paragraph: confidential client authentication plus S256 PKCE issues opaque access tokens and rotating refresh tokens, bound to exact client / edge / Node / resource / scopes. Refresh secrets are persisted only as digests; replay revokes the family. Public client_id plus PKCE alone cannot authenticate a resource owner in this R1 machine-to-machine flow and is refused. The current chatgpt edge retains its client ID, bound Node and redirect URI, and now has a private client secret in .sidera-dev/sol/data/codex-review-connector-import.private.json. Old token receipts are retained; tokens without recorded exact Node binding require reauthorization. Actual connector refresh is a Human product-side step and has not occurred in this audit.

2026-10-08 connector OAuth repair correction: the chatgpt edge now runs as an explicit public PKCE client (`oauth.publicPkceOwnerApproval: true`, advertised token auth method `none`). The public `/authorize` page no longer issues a code automatically; an explicit Human click on the loopback-only 127.0.0.1 consent page (separate listener, never tunnel-forwarded) is required before a one-time, PKCE/redirect/client/scope-bound code is issued. The confidential client-secret path remains implemented but is no longer used by this connector. Client ID, bound Node, redirect URI, Chat binding and valid auth state are unchanged. See SIDERA_R1_EXISTING_CONNECTOR_OAUTH_REPAIR_RESULT.md.

Production local/public metadata was fetched read-only. Both /healthz and /readyz returned 200, with ready=true; /health is not a supported route and returned 404. This establishes local/public reachability and Core observation, not product-side authentication. The Gateway was then controlled-reloaded without restarting Core or the dev tunnel. Public OAuth metadata now advertises only authorization_code with public-client auth method none, matching the implemented flow. After that reload, this supervising ChatGPT conversation successfully called sidera.status through the connector, so connector transport/auth round-trip is OBSERVED. A direct chief.frontend_prepare probe still returned `Chief binding required`; therefore the exact Human-owned Primary/Chief conversation binding and exact Presence remain unestablished. No new interactive OAuth login flow or Human approval was initiated. Devtunnel reachability is not identity, Authority or Effect evidence. The configured external origin is explicit, never inferred from request Host. Stable origin/config across restart preserves unexpired tokens; changed origin invalidates audience and needs product reconnect. No refresh support means expiry requires a new authorization flow. No identity/Authority/Effect gate was weakened.

## Validation and evidence

| Check | Final result | Evidence |
|---|---|---|
| npm run check | PASS | usability-evidence/check.txt |
| Full backend tests | 276/276 PASS | usability-evidence/backend-tests.txt |
| OAuth/Gateway focused | 25/25 PASS | usability-evidence/oauth-gateway-tests.txt |
| Desktop tests | 13/13 PASS | usability-evidence/desktop-tests.txt |
| UI production build/typecheck | PASS | usability-evidence/ui-build.txt |
| UI smoke/localization/disclosure | PASS: 5 nav, 3 setup stages, 7 product dialogs, zh/en, unknown/uncertain boundaries | usability-evidence/ui-smoke.txt |
| Packaged isolated smoke | PASS: 13 screenshots, DSH/Gemini auto-config, native cancel, four reports, copy/export | usability-evidence/packaged-smoke.json |
| Machine detection | Actual product paths/contracts, stale shortcut and unverified login | usability-evidence/current-machine-detection.json |
| Source/payload consistency | PASS | usability-evidence/source-payload-consistency.json |
| Portable privacy scan | PASS, no findings | usability-evidence/privacy-scan.json |
| Signatures/icons/hashes | Unsigned; unchanged source icon; extracted EXE/installer icons; SHA256 manifests | usability-evidence/signatures.json and candidate SHA256SUMS |

The earlier agy models diagnostic was read-only but attempted diagnostic/log/telemetry writes in the prior sandbox and returned sign-in required; it was not model inference. Automatic detector probes only bounded --help. Evidence screenshots contain isolated fixtures/current local machine observations, not online success. The installer was built; installation into the Human's real profile was not performed. Privacy scanning is a bounded artifact heuristic plus source/payload comparison, not a mathematical guarantee.

## Delivery and limits

Final portable directory: candidates/r1-usability-20261007/portable; installer and portable ZIP are alongside it. Both executables are unsigned. Earlier candidate directories are retained for recovery and are not the final deliverable. The pre-change ZIP/checkpoint hashes remain in usability-evidence.

External acceptance still requires explicit Human sign-in/reconnect and actual owning-product contract evidence. Gemini blocks default-model work unless identity is attested. Grok ACP remains unavailable; real ZCode is absent. General MCP import does not automatically wire arbitrary authenticated tools into canonical operations. These limits prevent an unconditional USABILITY_READY verdict. The production Gateway metadata fix is now loaded; the remaining ChatGPT-side limitation is exact Human-owned Primary/Chief conversation binding, not Gateway reachability.

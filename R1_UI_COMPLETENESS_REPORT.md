# R1 UI completeness report

Verdict: RELEASE_READY_WITH_EXPLICIT_EXTERNAL_LIMITS, subject to the adjacent final candidate validation record.

The frontend is the Human control plane. This pass uses the existing 56-function inventory and product/architecture closure constraints. It adds 195 visible catalog entries: all mapped functions, canonical RPC branches/aliases and canonical MCP tools. The catalog is informational, never a generic execution console. Every FUNCTION_INTERFACE_MAP.md row has a final frontend location column.

## Product surfaces

| Surface | Frontend location | Behavior |
| --- | --- | --- |
| Home / Work | /, /projects, /tasks/:id, /new-work | Canonical project/task journal, output review, literal intent capture, one-shot submission and blocked/uncertain guidance |
| Nodes | /nodes, /nodes/admin | Canonical Nodes plus all configured Nodes; typed adapter configuration, reviewed Human rename, distinct evidence states and visible lifecycle restrictions |
| Connections / Routes | /connections | Exact Chief bind/handoff, MCP HTTP return routes, installed-context native route gate, configured routes and external Chat edge inventory |
| Authority / Permissions | /authority | Human principal, exact profile manifest and grants; separate reviewed canonical package revocation |
| Effects / Recovery | /recovery, /system/effects | Original identifiers, uncertain effects, sourced revision-bound reconciliation; Node result repair remains visibly actor-gated |
| System | /system/admin, /system | Core safe start/stop, runtime ports, Core/Gateway/UI evidence, adapter inventory, version/build identity and local/full-route readiness |
| Tools / Capabilities | /tools | Human, Node, inspection and advanced/recovery entries with description, actor, conditional availability, canonical source, execution status and restriction reason |

Admin routes deliberately share the existing bounded Setup control plane and confirmation UI; they do not duplicate backend implementations. Home monitoring and Tools remain separate surfaces. Tools is accessible while Core is stopped or canonical work reads are denied/unavailable.

## Host setup and external limits

Eight requested adapters have frontend setup: codex-app-server, dsh-harness-acp, grok-build-acp, antigravity-cli-headless, zcode-native-service, openai-compatible-api, deepseek-api and external-mcp-client. API forms retain environment secret references; inbound edges retain exact locators. Installed executable adapters use discriminated strict schemas with fixed adapter-specific fields, no launch arguments/options editor and no shell. Installed executable/entry/SDK files must exist. Codex directories must be distinct. The four singleton adapters retain their canonical fixed Hythe IDs and replacement is rejected rather than silently changing an active Host.

Configuration creates neither authenticated identity nor verified ModelBinding nor Presence. The UI guides login to the owning installed Host and provides explicit state refresh. This local context has no supported login-launch mechanism; no guessed command, profile, provider credential or login state is manufactured. Actual Host discovery, authentication, model verification and external delivery remain external evidence obligations.

Session handoff/close, Node retirement, Host replacement and original message/task result reconciliation require authenticated Node actor/Session and canonical Authority. The UI displays their exact operation names and reasons; there is no Human impersonation path. Human Chief conversation handoff and Human rename continue through admitted Human acts. Intent revision now reviews the exact owned parent revision through SemanticStore.reviseIntent; stale admission fails and existing tasks are never rewritten or resubmitted.

## Validation

- npm run check: PASS.
- Full npm test: 258/258 PASS, zero failures/skips, original tests retained. See correction-evidence/ui-completeness-full-test-final.log.
- Setup/admin/catalog tests: 15/15 PASS.
- UI build/typecheck: PASS. Existing UI smoke and canonical projection smoke: PASS.
- Catalog test checks all 56 inventory functions and every registered canonical MCP tool; Node entries cannot be executable and exact lifecycle/result repair entries are present.
- Human revoke and intent revision behavioral tests verify inert reviews, exact confirmation, one-use consumption, retained history and stale-parent rejection.
- Installed Host declaration test verifies canonical identity, no fabricated sessions/grants/model/Presence and no replacement.
- Existing HTTP tests retain same-origin/strict-field protections and reject generic RPC/command endpoints. Browser redaction retains nested/configured-secret checks.
- Final candidate privacy scan, offline production dependency vendoring and clean-install browser flow are recorded in candidate CANDIDATE_VALIDATION.json. Clean install visits Tools and all admin routes before the original Setup / Human / permission / Chief / Core / blocked one-shot Work / safe stop flow. No external model calls.

The first restricted full-suite run timed out on Chrome fixture startup. The required suite passed with local fixture browser launch permission; no assertion was relaxed. Browser actions are synthetic test actions, not physical Human or provider E2E proof. No live external Host login, model execution, detached ChatGPT proactive return or delivery is claimed.

## Candidate boundary

Prepare only; no publication, GitHub change or archived release overwrite. A new candidate is created under this workspace's candidates directory using the existing allowlist builder. It contains production dependencies and UI dist, no private runtime, test databases, local logs, usernames, development paths or screenshots. SHA256SUMS and privacy scan are adjacent to the payload. Final readiness is based on canonical sourced facts; missing full-route evidence continues to block work that requires it.

Initial clean-install validation received a transient Setup error response during Core start (no runtime field). The test now fails with the actual bounded response rather than a TypeError. A second fresh installation passed; no mutation was retried within an installation. This is a local startup observation, not evidence of an external route. Historical development paths are removed from exported public Markdown before the all-file scan.

Final artifact: `candidates/r1-ui-completeness-release-candidate/Sidera-R1-UI-Completeness-Candidate.zip`. Final ZIP-unpack clean install PASS; all 3,585 payload files verified. Archive SHA-256: `4831617197a9278bb2636fb9c42e11d51e86b9a4ac8a4eba00b02e1d605221c8`. Candidate CANDIDATE_VALIDATION.json and SHA256SUMS are authoritative. Test Workbench cleanup required exact-process termination after safe Core stop; fixture world ownership was verified before termination.

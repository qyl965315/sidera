# Sidera R1 — independent DSH review + revision result

Date: 2026-10-08 (Asia/Shanghai). Workspace: `D:\Sidera-R1-v0.1.0`.
Source distribution has **no Git metadata**; no commit/HEAD exists and none is fabricated.
No package, installer, publication or upload was produced. Live data, the private
D/E regions and the Human-owned Chat binding were preserved; the Gateway and Core
processes were restarted, never the data.

Scope: one-shot independent reproduction, in-place revision and unified acceptance
of the previously reported P0-A, P0-B, P0-C and P2 findings, plus the design
correction that reviewer topology must be Rule/bootstrap policy rather than a
Basic invariant.

---

## 1. P0-A — Gateway operation registry was a duplicated source of truth

**Root cause (reproduced live).** `hythes/mcp-gateway.ts` built its dispatch
registry by iterating the hand-written `GATEWAY_OPERATIONS`, itself flattened from
`STABLE_OPERATION_GROUPS`. The canonical MCP registration was consulted only as a
lookup for already-listed names. Anything registered canonically but absent from
that list was invisible northbound. Reproduced against the live Gateway with the
registered `chatgpt` OAuth edge:

| Operation through the live Gateway | Before | After |
|---|---|---|
| `history.list` | `UNKNOWN_OPERATION` | `OK` |
| `omega.inspect` | `UNKNOWN_OPERATION` | `OK` |
| `rules.list` | `UNKNOWN_OPERATION` | `OK` |
| `executor.list` | `UNKNOWN_OPERATION` | `OK` |
| `chief.conversation_role` | `UNKNOWN_OPERATION` | `OK` |
| `node.ontology` | `UNKNOWN_OPERATION` | `OK` |
| `consequence.apply` | `UNKNOWN_OPERATION` | `OK` |
| `conflict.resolve` | `UNKNOWN_OPERATION` | `OK` |
| `session.active` | `OK` | `OK` |
| `task.dispatch` | reachable (blocked by Core) | reachable |

**Fix.** `buildOperationRegistry` now derives every dispatchable operation from
`canonicalMcpServer(core)._registeredTools`; membership comes only from canonical
registration. `hythes/tool-catalog.ts` owns the naming: `canonicalOperationForTool`
maps a registered tool name to its dotted operation, with an explicitly labelled
**naming-exception table** (`rules.adopt`, `peregrine.*`, `chief.conversation_role`,
`message/task.reconcile_result`, `conflict/consequence/rules.review_object`,
`grant.from_rules`). That table cannot add or hide an operation: an operation that
is not registered is not dispatchable. `STABLE_OPERATION_GROUPS` and
`GATEWAY_OPERATIONS` are deleted. `sidera_capabilities` groups are now derived from
the operation namespace, so the internal catalog grows without a second list. The
outer surface stays exactly `sidera_status`, `sidera_capabilities`, `sidera_read`,
`sidera_invoke`, `sidera_work`, `sidera_resource`.

New regression tests: `N-T02` (registers `history.list`…`grant.from_rules`),
`N-T02b` (registry ≡ canonical registration, one operation per tool, invented
operations such as `node.rename` are not dispatchable). The static audit
`gateway-registry` fails if a duplicated operation list returns.

**Consequence, stated honestly:** `node.rename` had no canonical MCP registration
and is therefore no longer reachable through the Gateway. That is the honest result
of "canonical registration is the single source of truth". Add a canonical tool if
it must be exposed.

## 2. P0-B — `sidera_read` mismatch: layer localisation

Layer-by-layer result:

| Layer | Finding |
|---|---|
| Server / tool registration (`hythes/mcp-gateway.ts`) | Registers all six tools, including `sidera_read`. |
| Live `tools/list` (loopback and devtunnel, before any change) | Already returned all six, including `sidera_read`. |
| Manifest / profile (`hythes/mcp-gateway-cli.ts`) | **Local defect**: `stableSurface` was restated three times and omitted `sidera_read`. |
| Old connector / product cache | ChatGPT's connector tool schema still lacks `sidera_read`. |
| Cache (local) | No local tool-schema cache exists. |

**Fix.** One canonical `GATEWAY_TOOL_NAMES` list is imported by the CLI for
profiles, `check`, and the startup record; the three restatements are gone.

**Does the Human need to reconnect?** For `sidera_read` in ChatGPT: yes. The local
server is correct and the connector's schema is product-side cached, so the single
Human step is to **remove and re-add (or re-authorize and refresh) the Sidera
connector in ChatGPT** so it re-fetches `tools/list`. That is
`CONNECTOR_SCHEMA_REFRESH_REQUIRED`, not a code bug, and no hot update may be
claimed.

**Additional finding (CODE_DEFECT, fixed).** The chatgpt OAuth access token
(`expiresAt` 1791393940117) had expired. `EdgeOAuthProvider.verifyAccessToken`
threw a plain `Error`, and the SDK bearer middleware converted it to HTTP **500
`server_error`** instead of a 401 challenge — so the product was never told to
re-authorize. Fixed to raise `InvalidTokenError` (and `InvalidGrantError` on the
code exchange). Verified live: expired/unknown token → `401` with
`WWW-Authenticate` + resource metadata; valid Authorization-Code+PKCE(S256) flow →
`200 Bearer`, 3600 s. Measured before the fix: `500 server_error`; after: `401`.

## 3. P0-C — Chief route, real status

Binding is intact and active: `cf6b0d22-e4ec-41e1-8ad1-5176fc0f0cf3`,
Project `local-project`, Communicator `ba3cb7ac-b601-4706-920d-d540960c3b4f`,
Conversation `https://chatgpt.com/c/6ac50f7f-4a6c-83ee-81ad-1e359d31c4b9`.

Reported separately by `chief.status` (new `separation` block):

| Layer | Live state | Basis |
|---|---|---|
| Core readiness | `READY` | `runtime.status` answered; `ready:true`; Core buildIdentity served the revised source digest `281ff45a…`. Core exited independently during the review and was restarted; a Core restart is not an edge event. |
| Edge transport (Chief return/transport health) | `UNAVAILABLE` (`CHIEF_TRANSPORT_HEALTH_UNAVAILABLE`) | No fresh `frontend_presence_observations` row; the activation TRANSPORT_POLL path additionally requires an admitted `human_frontend_sources` row, and the local 8790/8787 profile is absent. |
| Exact Conversation Presence | `UNVERIFIED` (`CHIEF_RETURN_TRANSPORT_UNAVAILABLE`) | No `ROUTE_VERIFIED` observation. Transport evidence was never promoted to Presence. |
| Return route | `UNAVAILABLE` (`CHIEF_RETURN_ROUTE_UNAVAILABLE`) | No usable `frontend_route_preparations` row; route readiness is downstream of exact Presence. |
| Operator Host health | Codex node `authority_denied` (host layer `host_unavailable`) | See §4. |
| Worker Authority | Codex node denied | Only a non-delegable `self.*` Grant exists for the Chief; no `message.send` return Grant and no adopted Rule grants. |
| Bootstrap governance | `sidera-r1-bootstrap-governance/1`, `adoptedRuleVersions: 0` | No adopted Rules exist. |

`chief.frontend_prepare` returns `{prepared:false, reason:"No authenticated
native/protocol route; browser transport is ineligible"}`. The native route needs
`CODEX_APP_TOOLS_PIPE_PATH` + a caller thread from a Codex app-tools executor; the
Core process has neither, and even so the isolated Codex host is not logged in.
`transport.ingress` is `unknown` because
`.sidera-dev/chief-ingress/status.json` does not exist (`.sidera-dev/tunnel` and the
8790/8787 native profile are absent).

**Recovery attempted (Sidera-owned only).** Gateway restarted to load the revised
registry and OAuth fix (OAuth state preserved; binding untouched). Core restarted
after it exited. `chief.frontend_prepare` retried — unchanged. No browser was
opened, no Presence was invented, no uncertain Effect was replayed.

**External transport fact.** The ChatGPT ingress path is the *separate* devtunnel
`https://cqhs2br0-8788.asse.devtunnels.ms` → Gateway `127.0.0.1:8788`. It answered
early in the review and later returned `ECONNRESET` while the `devtunnel.exe host
sidera-r1.asse` process stayed alive. The loopback Gateway remains healthy
(`/healthz`, `/readyz`). This is outside Sidera's control:
`EXTERNAL_PRODUCT_LIMIT` / `HOST_UNAVAILABLE`.
Local `chief-ingress` status is `LOCAL_CONFIG`.

## 4. P0-C — Codex Executor, real status

Live `executor.list`: `state:"UNAVAILABLE"`, `contextState:"usable"`,
`reason:"Host health unavailable"` — i.e. a durable `session_health='unavailable'`
row from a failed startup locate, not a context defect.

A bounded probe using the **currently installed** executable and the existing
isolated host directories (pinned locator left unchanged):

| Observation | Result |
|---|---|
| Pinned `options.codexExecutable` (`…\Codex\bin\f544b3844e0f14e9\codex.exe`) | **does not exist** — Codex auto-update moved its bin-hash directory |
| Currently installed executable (`…\Codex\bin\9691020b546a15b2\codex.exe`) | exists; app-server `initialize` **OK**; `model/list` returns models |
| `thread/resume` for the pinned locator | `false` — the pinned context is gone; `recoverLostSession:false` |
| Isolated `CODEX_HOME` login | `Not logged in` |
| Default user `CODEX_HOME` login | `Logged in using ChatGPT` |

`CodexHythe.start()` deliberately fails closed on a moved executable ("never
substitute a different binary than the one that was pinned"). Re-pinning would be a
Human/config decision and would still be blocked by the isolated host's missing
login and the lost locator, so nothing was silently re-pinned. Classification:
`LOCAL_CONFIG` (stale exe path + lost locator) + `PROVIDER_LOGIN` (isolated host not
authenticated) + `HOST_UNAVAILABLE`, and separately `AUTHORITY` (§5).

## 5. Rules / Authority — can real work start?

**No.** `rules.list` is empty (`RULES_NOT_ADOPTED`). The only Grant is a
non-delegable `self.*` for the Chief (`AUTHORITY`). No World/Project Rule exists,
so there is no standing Authority, no multiple-Executor or reviewer policy, and no
return `message.send` Grant for the Codex Operator; `chief.status` reports the
Codex node as `authority_denied`. Even a healthy Codex Host could not legally
receive or return work in this state. Bootstrap governance applies and does **not**
fabricate adoption.

## 6. Reviewer topology is now Rule/bootstrap policy, not Basic

`core/constitution.ts` adds `RuleReviewPolicy`
(`reviewers`, `reviewerSelection`, `humanInvolvement`, `independentRequired`,
`allowSelfReview`, `reviewerCount`, fixed `exactObjectHashRequired`) and the
versioned `R1_BOOTSTRAP_GOVERNANCE` (`sidera-r1-bootstrap-governance/1`).
`BASIC_INVARIANTS` gained only procedure-shape guarantees (exact versioned
object/digest/scope binding; a review record names the exact completed review it
consumed) and contains no reviewer topology.

`core/rules.ts`:
- `reviewPolicyFor(db, level, parentVersionId)` reads the policy from the **adopted
  parent version**, never from the proposal, so a proposal cannot pick its own
  reviewer or relax its own review.
- `proposeRules` validates any declared `policy.reviewPolicy`.
- `bindRuleReview` enforces `reviewerSelection` (including the exact Chief
  Conversation), independence and self-review, and records the applied policy and
  its source.
- `adoptRules` enforces Human involvement, machine-review count, independent
  reviewers and self-review, keeps the exact object-hash/`approve` binding, parent
  boundary, and append-only immutable records, and accepts `reviewTaskIds` for
  policies with more than one reviewer.
- `rules.review_object` (RPC + MCP) now returns the applied `reviewPolicy` and its
  source.

Bootstrap values reproduce today's behaviour exactly (World Human; Project
Machine + Human; Task exact Chief Conversation, no Human act), so all existing
behaviour is preserved while the topology becomes replaceable by an adopted Rule.
`core/history.ts` rule-conflict validation and `core/local-setup.ts` Human
Rule-adoption ingress now consult `humanInvolvement` instead of a level literal.
`ui/src/ConsolePanel.tsx` and the MCP tool descriptions state the policy-driven
rule. New test `CR-46` covers validation, bootstrap labelling and parent-source
resolution; the static audit `review-topology-policy` fails if a level-hardcoded
topology returns.

## 7. Bootstrap governance location and Human adoption integrity

- Policy: `core/constitution.ts` → `R1_BOOTSTRAP_GOVERNANCE`; surfaced in
  `console.inspect.bootstrapGovernance` and
  `chief.status.separation.bootstrapGovernance`.
- **No Human adoption was fabricated.** The migration receipt records
  `tasksCreated:0`, `grantsCreated:0`, `externalE2E:"NOT_RUN"`; the preserved Chief
  binding was imported as a `RoleBinding` with source
  `legacy-chief-binding-compatibility` and `preservedBinding:true` — a
  compatibility record, explicitly not a Rule adoption. `rules.list` is `[]`, no
  `human_semantic_acts` were created, and this review added no Task, Grant or Rule.
  No eligible live World Rules exist, so the correct state remains "bootstrap
  policy pending Human adoption", not invented adoption.

## 8. D/E private boundary (P2)

`core/rpc.ts` now refuses every `subjectivity.*` request that carries any
caller-selected subject selector — `nodeId`, `targetNodeId`, `nodeRef`,
`subjectNodeId`, `targetNodeRef`, `subjectRef`, `node`, `selfNodeId`,
`ownerNodeId` — before any read, with
`denied: Sovereignty accepts no Node selector`. Canonical MCP `subjectivity_get`
takes no arguments and `subjectivity_revise` takes none either. There is still no
cross-Node semantic D/E operation, with or without a Grant. The private region
remains the per-Node local `sidera.sqlite.sovereignty/<NodeRef>/current.json`; this
review used only the Chief's own token and never attempted a cross-subject read.
No privacy boundary was crossed.

## 9. History / Ω single truth

Unchanged and preserved. `history.list` is append-oriented and monotonic;
`omega.inspect` returns `derived:true` targets projected from History; there is no
independent canonical Fact Base. The review changed no History semantics and added
no second truth: the only History writes are the pre-existing adoption paths.
`Claim` still cannot carry a ΔΩ.

## 10. Real Chief → Operator Executor → result → Chief

**Not completed, and not faked.** No Task, Run or message was created. Exact
blockers, classified:

| Class | Concrete condition |
|---|---|
| `RULES_NOT_ADOPTED` | `rules.list` is empty; no adopted World/Project Rules exist. |
| `AUTHORITY` | Chief holds only a non-delegable `self.*` Grant; the Codex Operator is `authority_denied`; no return `message.send` Grant. |
| `HOST_UNAVAILABLE` | Codex `session_health='unavailable'`; pinned locator lost; no periodic Host re-probe. |
| `PROVIDER_LOGIN` | Isolated `CODEX_HOME` reports "Not logged in". |
| `LOCAL_CONFIG` | Pinned `codexExecutable` path gone after a Codex update; `.sidera-dev/tunnel` and `.sidera-dev/chief-ingress/status.json` absent. |
| `EXTERNAL_PRODUCT_LIMIT` | ChatGPT devtunnel ingress returns `ECONNRESET`; connector access token expired and its tool schema is stale. |
| `CONNECTOR_SCHEMA_REFRESH_REQUIRED` | ChatGPT connector must be refreshed/re-authorized to see `sidera_read` and the current surface. |
| `CODE_DEFECT` | OAuth expiry was reported as HTTP 500 instead of a 401 challenge — found and fixed in this review. |

Precise Human/ops steps (no prompt relay, no new Chat): re-authorize/refresh the
ChatGPT connector; restore the devtunnel ingress; re-pin `options.codexExecutable`
to the installed `codex.exe`; sign in the isolated Codex host and provide its
exact locator; then adopt the World/Project Rules and grants the work needs.

## 11. Remaining bugs / debt

1. `chief.status.transport.ingress` still reads only the 8790/8787 native-tunnel
   profile (`chief-ingress/status.json`), so the actually-used 8788 Gateway ingress
   has no Sidera-side transport observation. Reporting debt, not a false claim.
2. `node.rename` is no longer gateway-reachable because it has no canonical MCP
   registration. Add a canonical tool if it must be exposed.
3. The tool→operation naming table encodes ten legacy names. It cannot add or hide
   operations, but a wrong entry would mislabel one.
4. No periodic Codex Host health re-probe exists: `session_health` stays
   `unavailable` until a Core restart, an authorized `conversation.resume`, or a
   handoff.
5. `activation.observationFreshness.exactPresence` still treats historical
   `UI_ROUTE_VERIFIED` as Presence in diagnostics (labelling debt only).
6. CodexHost fail-closed on a moved executable is intentional; there is no
   automatic re-pin, and the isolated host login/locator remain Human work.

## 12. Final acceptance (single unified run)

| Command | Result |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | **331/331 pass, 0 fail, 0 skipped, 0 cancelled** |
| `npm run desktop:test` | **16/16 pass, 0 fail** |
| `npm --prefix ui run build` | exit 0 (`built in 2.13s`) |
| `npm --prefix ui run test:smoke` | exit 0 |
| `npm run evidence:check` | exit 0 (`Evidence docs match canonical fixture.`) |
| `node scripts/audit-constitution.ts` | **9/9 PASS** (source audit updated for the new topology/registry guards) |

Test count moved from 329 to 331 with the two new focused tests (`N-T02b`, `CR-46`).
Log: `final-acceptance.log`. Runtime diagnostics written during the revision:
`gateway-restart2*.log`, `constitutional-core-restart*.log` (held open by the two
restarted live processes).

## 13. Preserved design (unchanged by this revision)

Chief = Project → Conversation role → Communicator; Executor = Operator
sub-context, not a Node; Console = not a Node; CESAR primitives stay separate;
local per-Node private D/E with CAS and no cross-Node semantic read/write;
`Claim ≠ Fact ≠ Description ≠ Explanation`; append-oriented Shared History with
optional ΔΩ; Ω as deterministic projection of History + Basic Rules; derived
Grants only narrow parents; Basic Rules guarantee order, not correctness; no
autonomous Rule evolution or cellular automaton.

Final status: **revision delivered; real Chief → Operator E2E not reached, blocked
by the classified conditions above; final Human acceptance pending.**

## Codex 独立复核补记 — 2026-10-08

本文保留 DSH 当时的报告，不作为 Codex 当前验收的结论。独立检查发现以下已修正的 material 缺口：canonical handler 的 schema 在 Gateway 中被绕过；四个 operation 标签与真实 RPC 名称不一致；node.rename 缺少 canonical registration；Console 仍按 level 硬编码，reviewTaskIds / optional Human / Operator reviewer count 接线不完整；冲突恢复误读 Rule 自己的子级 policy；machine-adopted Project 的有效 Human ancestor 无法用于 standing Grant；Chief 使用 projectSpaceId 代替 canonical projectRef；Host health 粘滞且 Host 状态混入 Authority；freshness 仍混入历史 UI evidence；ingress 仅观察固定 native profile；Codex pin 缺失存在可安全自动修复的路径。

DSH 关于六个 live Gateway tools 与当前 connector 缺少 sidera_read 的差异、Core readiness 与 edge 失败分开、隔离 Codex 未登录及真实闭环未完成的主要结论已获得独立证据。更正：开始审核时 Core / Gateway 已停止，不能把报告时的 live 可用性当作持续事实；现有 HumanSemanticAct 为 2 条，均是早期 self Grant / Chief binding，并无 Rules adoption。

Codex 当前结果、精确 blocker、改动清单、恢复点和最终验收见 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md。

补充独立 live 发现：当前 connector 明确返回 UNAUTHORIZED / oauth_refresh_token_missing。原 OAuth provider 不发 refresh token，且 public PKCE 流没有 resource-owner authentication 却可签发 Node credential。本轮新增绑定 client / edge / Node / audience / scope 的 durable refresh rotation，拒绝 scope 扩张和 replay，拒绝无 owner authentication 的 public issuance，并将当前同一 client 增量配置为 confidential。旧 connector 仍必须由 Human 重新授权及刷新 schema；不能把本地 PKCE 成功当作这一步已经完成。
> 2026-10-08 Codex 独立复核修正：此前“reviewer topology 已完全可由 Rules 替换”的结论不完整，原 World 分支始终返回 bootstrap。现由已采纳 World.policy.worldReviewPolicy 治理后继 World，并固定 governanceVersionId 到提案 digest / immutable version / History。首个 World 仍等待真实 Human bootstrap adoption。DSH 的其他结论、实际 connector reauthentication 和本轮唯一验收失败的范围，见 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md；本文件保留历史记录。

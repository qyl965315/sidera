# CORE Chat-first P0 v2 — scoped implementation result

**CORE scoped PASS. Remote real P0 HOLD / current connector NOT_OBSERVED.**

Branch: `r1-chatfirst-core`. Starting commit:
`47f9372785fcd3a535677a4d0cd6bac014c327f9`; starting worktree was clean.
All changes are in this isolated `r1-chatfirst-core/project` checkout.
This is a tested engineering checkpoint, not deployment, Human acceptance,
release, or a claim of an actual ChatGPT/Codex cloud round trip.

Read the complete `CORE_P0_V2_PULL_DISPATCH_CHARTER.md`, R1 Constitution,
Vision, Architecture, and the separate CONTRACT audit read-only. The Constitution
remains authoritative. No Rule, Human grant, OAuth implementation, production
profile, current connector, desktop implementation, or other checkout was changed.

## Implemented behavior

An authenticated inbound MCP Chief can submit an authorized root Task without
requiring an outbound `locate`, prepared push route, or a fabricated Host turn in
the origin Chat. The target still passes the existing exact Session/Executor,
World, Authority, generation, Host health, scheduler reservation, and final Effect
Gate checks. Only the inbound actor's proactive-receive prerequisites are replaced
by the validated current pull context. Target requirements are unchanged.

`binding` now selects by exact binding, Project reference/space alias, and/or
Conversation. `isChief` tests role existence without throwing when the Node has
multiple Project Chief roles. Status, root dispatch, result retrieval, and the
post-discovery transaction use the selected binding. Omitted ambiguous selection
fails closed; no Task is minted. The original Task's `chief_task_routes.binding_id`
is retained. A Human handoff cannot turn the successor Chat into the old inbox.

The canonical MCP status/dispatch/result schemas accept `bindingId` and
`projectRef` as narrowing selectors. They reject model-supplied `conversationRef`,
metadata, and unknown fields. A selector does not authenticate a Chat.

The existing authenticated Gateway callback supplies a request-local context.
Its Human-owned edge configuration supplies `chiefConversationRef`, optional
`chiefBindingId`, and optional separately approved `chiefProviderSession` with
`sessionId` and optional `subjectId`. The context is created only after existing
bearer/OAuth validation reaches the SDK tool callback. Configuring an edge alone
does not create this context or admit work. No OAuth route/provider/token logic
was changed.

Core receives that context outside the tool/RPC parameter object, authenticated
with an HMAC under the private edge-to-Core credential. The proof binds the RPC
ID, method, parameters, and ingress scope and expires after 60 seconds. Core
checks the token principal, active Session, current Chief binding and World.
The Gateway and holders of its private Core credential are trusted adapter
infrastructure; this is not a new identity provider or a second grant system.
There is no new durable state store or database migration.

`chief_result_get` is a typed read-only view over the existing result Message and
Task/Run records. It preserves original binding/Conversation/Project provenance,
distinguishes Worker text from reviewed text, and cannot mark Human observation
or replay work. The scheduler retains inbound-only Chief results in the existing
MessageBus inbox without attempting origin wake/push or fabricating an ACK.
The result Message can consequently remain `queued` while its Worker Task/Run and
Effect are completed; fetching is not delivery acknowledgement.

Status reports `PULL_READABLE`, `PUSH_UNAVAILABLE`, and `NOT_OBSERVED` separately.
Exact provider Conversation Presence remains unverified by this transport.
Chat-scoped reads do not use a cross-request fallback cache. `task.get` and RPC
result notifications also enforce original inbox scope. Existing Node-wide
work/history aggregates that cannot honor exact Chat scope fail closed on this
external Chief route and direct callers to `chief.result_get`; this bounded work
does not implement general Chat-scoped archive/aggregate projections.

Request-ID receipts remain idempotent, including the prior `47f9372` receipt
shape when the stored binding and work match. Separate Projects cannot borrow
each other's receipt. Binding/Session changes across awaited discovery are
rechecked before the transaction admits work. Uncertain effects retain their
original Task/Run/message/attempt and are not replayed after database reopen.

## Metadata and evidence boundary

The [official OpenAI plugin reference](https://developers.openai.com/plugins/reference)
was opened on 2026-10-11. It describes `openai/session` as an anonymized
Conversation correlation identifier and `openai/subject` as an anonymized user
identifier. The installed MCP SDK exposes request `_meta` to tool callbacks;
the real SDK loopback test exercises that path.

The implementation reads these values exclusively from SDK callback context.
They never supply authentication, a Conversation URL, or Authority. Only a
separately Human-approved expected session/subject is compared; mismatch or
missing required metadata denies the request. A match is reported as
`APPROVED_CORRELATION`, never platform-authenticated Conversation Presence.
Actual anonymized identifiers are not copied into Task bodies or result views.

Without an approved provider-session binding, the explicitly configured edge
Conversation is sufficient for bounded pull, and responses say `UNVERIFIED` /
`providerConversationProof: NOT_OBSERVED`. In that mode another physical Chat
using the same credential and indistinguishable metadata cannot be independently
identified by Core. Exact provider-Chat isolation must not be claimed from that
deployment scope alone. Models cannot widen that scope through tool arguments.

## Validation and reproducible evidence

Node `v24.18.0`. New P0 tests use real Streamable HTTP MCP and TCP Core RPC on
ephemeral loopback ports. The external origin uses the actual inbound-only
`ExternalMcpClientHythe`. The Codex-named target Host, Human admissions, grants,
provider metadata, and completion stream are explicitly **SYNTHETIC**.

| Check | Result | Evidence |
| --- | --- | --- |
| Initial behavioral regression on base | Expected FAIL: `ACTOR_PRESENCE`, zero root Task | `evidence/core-p0-v2/baseline-red.log` |
| TypeScript | PASS | `evidence/core-p0-v2/typecheck.log` |
| Targeted Chief/MCP/Executor suites | 45/45 PASS, including all 7 new P0 witnesses | `evidence/core-p0-v2/targeted.log` |
| Full serial suite | 402/403 PASS; one existing out-of-scope UI catalog failure | `evidence/core-p0-v2/full-serial-final.log` |
| Evidence governance tests | 10/10 PASS | `evidence/core-p0-v2/evidence-tests.log` |
| Generated evidence consistency | PASS | `evidence/core-p0-v2/evidence-check.log` |

The positive witness records request, Task, Run, task Message, synthetic Host
receipt, result Message, original binding, Action and Attempt IDs. It verifies a
completed local Effect and exact readback after database close/reopen, with zero
origin `locate` and zero origin `invoke` calls. Negative witnesses cover missing
authentication, wrong/model-supplied metadata, wrong Conversation/Project/World,
two concurrent Project scopes, unscoped ambiguity, duplicate concurrent dispatch,
Human handoff, revoked Authority, a handoff during discovery, unsigned/altered/
expired ingress proofs, config without ingress, and uncertain restart no-replay.

The sole full-suite failure is
`tests/ui-completeness.test.ts` — canonical tool `chief_result_get` is absent from
`ui/src/capability-catalog.json`. It was already registered in the starting
commit, whose catalog also omitted it. The catalog and its test are unchanged.
`evidence/core-p0-v2/baseline-catalog-gap.json` records the baseline comparison.
No desktop change was made to hide that failure. **The full suite is not green.**

Reproduction:

```powershell
node scripts/generate-evidence-docs.ts
npm.cmd --prefix ui run build
npm.cmd run check
node --test --test-concurrency=1 --test-timeout=30000 tests/chief-pull-mcp.test.ts tests/chief.test.ts tests/chatfirst-return-e2e.test.ts tests/external-mcp-client.test.ts tests/constitutional-chief-executors.test.ts tests/constitutional-executor-routing.test.ts tests/mcp-gateway.test.ts
node --import ./tests/fixtures/private-loopback.ts --test --test-concurrency=1 --test-timeout=30000 tests/*.test.ts
node --test --test-concurrency=1 --test-timeout=30000 tests/evidence-governance.test.ts
npm.cmd run evidence:check
```

The complete suite additionally ran with a 240-second process watchdog. Existing
headless-browser fixtures required execution outside the sandbox, with disposable
profiles and loopback pages. `tests/fixtures/private-loopback.ts` redirects only
temporary LocalSetup default endpoints away from installation ports 47321/47322;
it changes no production defaults. The first unisolated suite attempt was stopped
after source inspection exposed its inherited default-port probe. That attempt
is not accepted as isolated suite evidence. Final verification used the
private-port preload; no production write was performed by this task.

The existing UI was built into ignored `ui/dist` solely because the existing
desktop-boundary test requires static assets. Existing generated evidence files
were regenerated to remove checkout CRLF drift; their normalized content has no
Git diff. Neither step changed desktop source. `--test-force-exit` was avoided in
the final run after triggering a Windows libuv shutdown assertion in an exploratory
run. Final logs and source hashes are indexed by `evidence/core-p0-v2/validation.json`.

## Remaining real P0 gate

The charter reports the user's actual connector OFFLINE. This task did not probe,
relink, reconfigure, authenticate, or deploy to that connector. Remote real P0
therefore remains **HOLD / NOT_OBSERVED**.

Completion still requires the current authorized connector to make an observed
MCP call, resolve its Human-owned exact Chief scope, dispatch one bounded Task to
the pinned real Operator, obtain correlated real Host ACK and Agent completion,
and fetch that exact result from the original current Chat. Provider correlation,
local Task/Effect completion, tool readback, and Human-observed result must remain
separate evidence levels. This isolated commit authorizes no production rollout
and supplies no evidence of real Human result observation.

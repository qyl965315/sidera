# Sidera R1 Chat-first constitutional contract audit — 2026-10-11

Status: bounded CONTRACT engineering checkpoint. **Full Chat-first P0 NOT PASSED;
remote current-ChatGPT/Operator round trip UNVERIFIED.** This report is neither
Human approval nor an adopted Rule nor a release. Scope: branch
`r1-chatfirst-contract`, base `f327c58`, this isolated checkout only.

## Authority and source preservation

Read: owner directive
`D:/Sidera-R1-v0.1.0/.sidera-dev/convergence/SIDERA_CHATFIRST_R0_20261011.md`,
`SIDERA_R1_CONSTITUTION.md`, `VISION.md`, `ARCHITECTURE.md`,
`SIDERA_R1_MIGRATION_MAP.md`, and
`SIDERA_R1_BACKEND_CONVERGENCE_WORKING_PLAN.md`.
The Constitution is canonical; later G3 product charters cannot amend it.

Recovered the requested Human source at
`C:/Users/13cheng4/Downloads/Sidera_R1_Astra_OneShot_Refactor_Prompt.md` and preserved
it byte-for-byte at [the checkout root](Sidera_R1_Astra_OneShot_Refactor_Prompt.md).
SHA-256: `dc10ac3938ddb22d9204bf380798c04bab22d9131e44cd71276d0012a35e61e3`.
The dedicated `.gitattributes` entry prevents line-ending normalization of this
source. The original file is unchanged. The prompt's full historical refactor,
migration and broad UI test instructions are preserved as source, not re-executed:
the current owner request narrows this branch to audit, docs and focused headless
tests. Its bootstrap review topology is qualified by the Constitution's later
parent-policy corrections; no governance rollback is authorized.

An independent read-only audit agent reviewed the architecture and source paths;
its findings were checked against this checkout. No model output is treated as
machine proof. Source inspection demonstrates the gaps below, not which historical
commit originally introduced every runtime defect.

## Drift and critical design risks

| Priority / owner | Evidence at base f327c58 | Consequence and required correction |
| --- | --- | --- |
| Critical / CORE | `core/chief.ts:218-229,237-238`; `core/rpc.ts:395-400,621-627` | `binding(nodeId)` throws for multiple active Projects; `isChief()` inherits this, blocking even RPC Project discovery. `conversationRef` cannot select a Project. Thread exact Project/binding selection through canonical schema, RPC, status, action and transaction recheck. Preserve ambiguous-omission rejection. |
| Critical / CORE | `core/chief.ts:260-263,293-299,344-345`; `hythes/external-mcp-client.ts:60-74,102-104` | Dispatch requires a prepared machine-egress route and origin `locate()`, while honest external MCP has no proactive locate/send. Existing retained-result pull cannot by itself unblock root dispatch. Model supported authenticated pull independently; do not forge a push route or make external `locate()` return true. |
| Critical / CORE + EDGE contract | `core/chief.ts:32,237,242,324-340` | Node/Session principal plus optional caller `conversationRef` is insufficient proof of provider conversation identity. Define trusted ingress context or an explicitly validated binding mechanism. Unverified exact Chat stays unverified. No arbitrary caller selector may widen result access. |
| Critical / CORE | `core/chief.ts:90,113,324-340,558-565` | Retained results are Project/Node scoped; presentation uses the current binding. This is intentional Human-admitted handoff behavior, not evidence of an arbitrary unauthorized redirect. Separate immutable origin, current role and explicit result transfer. Original Chat acceptance cannot be replaced by a successor Chat receipt. |
| High / CONTRACT | `G3_PRODUCT_DELIVERY_CHARTER.md` priority and "Implement P1 first"; `G3_P2_COMMUNICATION_CONTRACT.md:6`; `G3_P3_SCOPED_QA_20261011.md:23`; P4 native Chief/first-use and P5 `f327c58` | Local desktop delivery displaced the original external Chat loop as the next gate. Preserve useful components and honest HOLD reports, but make them optional product work. Existing Human Chat must not be replaced with `sidera-native://` to obtain a green result. |
| High / CONTRACT | Historical Architecture paragraph beginning "绑定由 Human 明确指定" | UI/composer readiness and SQLite current D/E wording conflict with the Constitution/private CAS storage. The new Architecture correction explicitly supersedes these statements and retains the original text. |
| High / EDGE + integration | Owner R0 reports current connector SSE HTTP 404 and generic capability internal error | This report did not reproduce the live failure. EDGE must correlate public endpoint, exact registered client and actual inbound request. Local fixture success cannot repair or certify that endpoint. |

The [additive Architecture correction](ARCHITECTURE.md#2026-10-11-additive-correction-headless-chat-first-precedence)
defines the Communication–Operation–Boundaries graph, stable NodeRef, Project Chief
role, immutable origin and distinct evidence levels. Console remains optional
Human Boundaries UI. No new ontology, broker, scheduler or duplicate History was needed.

## Executable headless witness

Run from this checkout with Node >=24:

```powershell
node --test tests/chatfirst-contract.test.ts
node --test tests/chatfirst-contract.test.ts tests/chief.test.ts tests/external-mcp-client.test.ts tests/constitutional-chief-executors.test.ts tests/constitutional-executor-routing.test.ts
npm.cmd run check
```

`npm.cmd` avoids the Windows PowerShell `npm.ps1` execution-policy restriction.
Each run creates an isolated temporary SQLite database and one bounded input file,
uses existing Core APIs and removes its own temporary fixture. The additional
existing external-MCP suite uses authenticated loopback MCP/RPC, with synthetic
credentials; it does not contact the real connector. No live profiles, production
database, credentials or tunnel are read or changed.

| Witness | Executed evidence | Limit |
| --- | --- | --- |
| Registered external transport + Chief role | Actual ExternalMcpClientHythe, canonical binding, BLOCKED, zero Task/Run/target receipt, stable blocked request replay | Baseline blocker characterization, not desired final pull-dispatch behavior; no authenticated remote ingress |
| Authorized local Core seam | Real Chief action → Authority → Task/Run → final Effect Gate → exact target adapter; adapter reads a bounded local file and computes SHA-256; acceptance remains running until runtime consumes the adapter's correlated synthetic receive stream | Identity, Human acts, Grants, Host health and prepared return are SYNTHETIC; local adapter receipt/stream is not remote Codex receipt/completion; positive path invokes Core directly, not MCP/RPC |
| Durable origin result | Exact message/receipt, completed Run/Effect, unchanged prior History records, original task route and result text after database reopen; wrong conversation filter empty | Core-seam retrieval under synthetic caller, not proof of authenticated provider Chat scope or Human observation; no UI, push or autonomous Chat turn |
| Multiple Project roles | Both bindings exist; current status conflicts even with exact second Conversation; no task created | Known CORE gap intentionally characterized; must become positive explicit-selection regression in CORE |
| Unknown external effect | Adapter crosses final gate then returns uncertain; restart/pump retains uncertain, no second invocation or result | Synthetic lost-response fault, no remote interruption experiment |

The wrong-conversation check only tests mismatch against the current binding.
Same-Project handoff isolation is **UNVERIFIED** and remains a CORE gate; the
existing project-wide lookup is not repaired here. Successful request replay is
also checked after reopen with an execution callback that must never run.

The fixture's prepared protocol route exists solely to exercise reusable local
Chief/Operation machinery behind the current egress gate. `inspect`, `deliver`
and origin `invoke` throw if called. This is not a claim that external Chat can
push or locate; the separate real external-adapter case remains BLOCKED. Test
Human admissions never count as actual Human acts outside the disposable fixture.

Tests emit machine-readable diagnostic witnesses with `evidenceClass: SYNTHETIC`,
`remoteLive: UNVERIFIED` and `fullP0: NOT_PASSED`. A test exit code of zero means
its stated local behavior was verified, including known blockers. It never means
all desired Chat-first behavior works. See
[validation record](evidence/chatfirst-contract-validation.json) and raw logs.

## Exact merge order and handoff gates

The sequence below is proposed and conditional: the owner R0 requires independent
tests **and a machine-evidenced P0 improvement before merge**. A green bounded
local commit is authorized; it does not satisfy that merge gate by itself. This
branch performs no merge and claims no live P0 improvement.

1. **CONTRACT first:** once the owner R0 merge gate is met, integrate this bounded
   docs/tests/source-preservation commit with green focused tests and tsc. It provides the common contract and
   known-blocker witnesses. No runtime or gateway change belongs here.
2. **CORE second:** rebase onto CONTRACT. Implement exact Project/binding
   selection and origin-scoped result retrieval with supported pull-return
   readiness, using existing Authority/final-gate/Task/Run/Effect machinery.
   Update canonical MCP schema in the CORE-owned surface. Replace the two
   baseline blocker expectations with desired positive regressions, retaining
   negative ambiguity/no-Authority/no-Task cases. Prove a second Project does not
   break discovery, dispatch or lookup; wrong binding and omitted untrusted Chat
   scope cannot read results; explicit handoff is distinct from original return.
   Prove request idempotency and restart/uncertain no-replay. CONTRACT must not
   patch the scheduler to make its tests pass.
3. **EDGE third:** rebase onto the merged CORE schema; repair/diagnose endpoint,
   OAuth and registered-client transport within EDGE ownership. Test that real
   authenticated ingress does not imply exact Chat Presence, Authority or push.
   Preserve existing client identity, Human-owned binding and credential scope.
   CORE and EDGE development can run in parallel; this is their integration order.
4. **Integrated live witness last:** this exact current ChatGPT connector calls
   real Core, selects its exact Chief Project, dispatches one bounded authorized
   request to the pinned real Operator in Peregrine, obtains real Host receipt
   and Agent completion, then fetches the correlated result in the original Chat
   through a supported tool route. Capture origin/request/Task/Run/Attempt/message/
   Host receipt IDs and source evidence. Verify persisted state and no replay
   after restart. No replacement Chat, browser transport or Human prompt courier.
   Human-only relink/login/adoption is a concrete remaining gate if required.
5. **Optional desktop follow-up:** assess P1–P5 reuse after P0. Desktop/UI/packaging
   acceptance is not a prerequisite or substitute for this loop.

Every merge must preserve ownership and run the relevant tests on the integrated
head. Unit/fixture PASS is an engineering checkpoint. This branch contributes
reproducible blocker and durability evidence, **not a claim of live P0 improvement**.
Hold merging until the owner R0 merge gate is evidenced; hold full P0/release
acceptance until step 4. Do not declare G3, backend convergence or production
release from this commit.

## Scope and remaining work

Only additive documentation, source preservation and tests are changed. Gateway
OAuth, core scheduler/runtime, production state, G2 frozen checkout, live P5
window/profile and accounts are untouched. The contract audit and its bounded
engineering checks are complete once the recorded commands pass. Multi-Project
selection, exact authenticated origin scope, pull-only root dispatch and live
current-ChatGPT return remain CORE/EDGE/integration gates. Full OneShot acceptance,
UI suites and full repository test suite are not claimed by this bounded audit.

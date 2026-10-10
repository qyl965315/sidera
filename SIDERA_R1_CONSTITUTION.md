# Sidera R1 Constitution

Canonical protocol: `sidera-r1-constitution/1`. This document and the Human's
`Sidera_R1_Astra_OneShot_Refactor_Prompt.md` supersede conflicting terminology in
earlier R1 implementation reports. Those reports remain historical evidence.

## Purpose and subsystems

**Basic Rules guarantee order, not correctness.** R1 preserves attributable acts,
consequences and responsibility when Nodes are mistaken, dishonest or unsuccessful.
It does not require agreement, honesty, provider diversity, a particular reviewer
topology, a punishment schedule or a fixed organization.

| Subsystem | Owns |
| --- | --- |
| Communication | Semantic interaction: Conversation, Discussion, Thread, Messaging |
| Operation | Execution against files, processes, services and supported external interfaces |
| Boundaries | Constitutional invariants, Rules, Authority, History, Ω and attributable Effects |
| Console | Human interface to Boundaries; not a Node, decision maker or owner of D/E |

The implementation shares a message bus. History preserves the form: Human ↔
Communicator is Conversation; Communicator ↔ Communicator is Discussion;
Communicator ↔ Operator is Thread; Operator ↔ Operator is Messaging. Console
institutional input is attributed as Console input without inventing a Communicator.

## Subjects and sub-units

```text
Node
├── Communicator                  official Chat-class subject
│   └── Conversation             one may hold a Project's Chief role
└── Operator
    ├── Agent                    Human / Sidera controls runtime
    └── Bot                      external service controls runtime
        [both contain Executors]
```

Sovereignty defines subjecthood. NodeRef is the stable external handle, not its
source. Existing `node_id` is retained as NodeRef. Retirement never permits reuse.
Model changes, context replacement and restarts do not create a subject. Fork
creates an independent NodeRef and preserves parent lineage and prior responsibility.
No universal rule makes children inherit every consequence.

Chief is **Project → Conversation role → Communicator**. Executor is a concrete
execution context inside an Operator. Neither is an independent subject. Legacy
`chiefNodeId` identifies a compatibility runtime endpoint; it is not a canonical
Node type. Existing Human-owned Chat references are retained exactly.

R1 scheduling prefers an idle usable Executor. When none exists, a completed
Chief Conversation machine-review Task decides wait/reuse/open. Opening a real
context still needs actual Host capability and Authority. Context exhaustion,
corruption and explicit unusability withdraw eligibility. Multiple Executor
assignments require adopted Project policy. Assignment does not prove execution.

## CESAR

| Primitive | Meaning |
| --- | --- |
| C — Capability | Technical operation actually usable now; `available` / `unavailable` |
| E — Effect | Recognized consequence of an Action; may carry an attributable ΔΩ |
| S — Sovereignty | Node-private current Description + Explanation |
| A — Authority | Whether this subject may exercise that capability in this scope now |
| R — Responsibility | Provenance derived from History, Ω and applicable Rules |

Capability inventory and documentation are discovery hints. Knowledge freshness is
separate: CURRENT, UNKNOWN or STALE. Unverified and stale technical claims do not
become available. Verification is suggested as work; no automatic model call is
created merely to make a status green. Authority denial does not hide the operation.
Local broker controls are enforced; external Host controls may be audited. Admission,
Host acceptance, Agent completion and final result observation remain distinct.

## Sovereignty: S = D + E

Description contains concrete first-person remembered/recognized facts, which may
be wrong or forgotten. Explanation contains evaluations, classifications and abstract
explanatory structure derived from D. Neither is objective Ω.

The current canonical pair is stored in a private per-Node local region, separate
from SQLite content and public History. All Conversations/Executors of a Node share
one revision. Atomic publication and compare-and-swap detect competing self-writes.
The Node chooses whether to reread, recompute, merge, overwrite, discard or forget;
Basic Rules do not prescribe a cognitive merge policy.

Sidera exposes no cross-Node semantic D/E operation, including with a broad Grant.
Infrastructure ownership of the machine is outside this subject-level boundary.
SQLite retains only blank compatibility content fields plus revision/index metadata.
Old private revisions are not automatically published to Shared History.

## Claim, Effect, History and Ω

`Claim ≠ Fact ≠ Description ≠ Explanation`. A Claim may contradict Ω and may
misrepresent D/E. Its objective provenance is that a subject made the expression;
its propositional content is not automatically true.

`Action ≠ Effect` and `Authority ≠ Effect`. An unauthorized action can have real
consequences; recognized effects remain in History. Responsibility records the
violation instead of falsifying state. Ordinary communication has no state delta.
An external assertion changes objective state only through a designated interface
with defined semantics, not through a generic Agent state-write capability.

`shared_history` is the append-oriented canonical log. Each record has stable ID,
monotonic sequence, typed kind, source, subject/context/project/task references,
causal parents, Rules versions, payload, timestamp and optional ΔΩ. Ordinary Node
operations cannot update or delete records. Private D/E and credentials are excluded.

Ω is rebuilt with `Apply(History, Basic Rules)`. No independent canonical Fact Base
exists. Compatibility operational tables are recorded through explicit public-column
Effect adapters. Their old unrecorded past is labeled migration evidence, not
invented historical acts. Future changed rows append recognized Effects atomically.

Each delta names target, base revision, resulting value or REMOVE, provenance,
causal parents, Rules versions, effective time and recorded time. Same-base equal
values are compatible. Incompatible values project that target as UNRESOLVED; no
candidate is silently definite and unrelated targets keep operating. Resolution
names the exact conflict and follows a resolution Task through a new recognized
Effect. Historical conflicting acts remain intact. Dependent-action policy belongs
to lower Rules, not a universal halt of the world.

## Rules and Authority

```text
Boundary(Task) ⊆ Boundary(Project) ⊆ Boundary(World) ⊆ Boundary(Basic)
```

Basic Rules change only through protocol upgrade. Basic fixes the **shape** of the
review/adoption procedure, not its reviewer topology: every review and adoption
record is explicit, versioned, traceable, bound to an exact object/digest/scope,
consumed from a real completed review, and may not break the parent boundary.

Who reviews, whether reviewers must be independent, whether self-review is
allowed, how many reviewers are required and whether a Human must be involved are
institutional policy carried by the applicable adopted Rule
(`policy.reviewPolicy`). Adoption of one level reads that policy from the level's
adopted **parent** version, never from the proposal itself, so no proposal can
choose its own reviewer or relax its own review.

The World/Project/Task arrangement below is the versioned **R1 bootstrap
governance policy** (`sidera-r1-bootstrap-governance/1`), applied only while no
adopted parent Rule supplies its own `reviewPolicy`: Human adopts World Rules
through exact Console admission; Project Rules need a completed Machine Review and
Human adoption; Task Rules need the issuing Node's proposal and exact Chief
Conversation Machine Review. Review is a Task, not a Node type. R1 implements no
autonomous change of that topology.

Rules versions and review records are immutable. Machine results bind the exact
proposal digest; Human decisions bind the exact structured object, scope and ID.
Prose, confidence and a requesting Node's assertion of approval cannot mint Authority.

World/Project Rules can provide standing Authority within their adopted boundaries.
Local authorization is a parent-linked Derived Grant: G0 → G1 → G2. Every dimension
narrows: capability, resource, World, Project, Task, Model, time, budget and
delegability. Ancestor revoke/expiry invalidates descendants; shared consumption
counts against ancestor and applicable Rules budgets. A lower Rule may limit depth;
Basic Rules impose no universal maximum depth.

A requests B to work; B uses B's own Authority to accept and execute. The request
does not transfer a permission A lacks. Provenance preserves request, authorization,
review, execution and acceptance separately.

## Responsibility and consequences

`R = f(Shared History, Ω, applicable Project Rules)`. Existing work-assignment tables
remain compatibility indexes. Responsibility queries retain action-time Rule versions
and causal links instead of treating Task ownership as the entire chain.

A named adopted rule may define a consequence. The mechanism requires actual
Authority, attributable source acts and a completed review of the exact proposed
consequence. It emits a Consequence record and ΔΩ; runtime Authority checks consult
effective rule-defined restrictions. No default punishment or automatic reputation
economy is installed. Resource/environment pressure can be recorded without
inventing provider quota or cost observations.

## Human and runtime boundary

Production Human delivery uses native/protocol/authenticated non-browser routes.
Browser automation, browser visibility, CAPTCHA and UI fallback are ineligible
as transport or Presence. Missing non-browser dependencies produce truthful blocked
state. Console is a Human application surface; opening it is not runtime Presence.
Uncertain effects are reconciled against original IDs, never blindly replayed.

## Explicitly future, not R1

R1 includes versioning and consequence hooks for future research. It does not
implement autonomous World/Basic Rule evolution, a cellular automaton, political
evolution, a universal collateral/punishment scheme or an autonomous D/E contradiction
elimination engine. Future negentropy research concerns unexplained contradiction;
it does not require uniform cognition or removal of disagreement.

## 2026-10-08 Codex 独立审核补充

reviewPolicy 的实际治理来源是已采纳的精确 parent version；提案中的 reviewPolicy 用于其子级，不能选择自己的采纳程序。Rules RPC、Human Console、冲突恢复均遵守这一来源。reviewerCount 表示所需的最少机器审阅主体数；多个 Task 不会把同一主体变成多个 reviewer。选择 AuthorizedOperator 时必须是 Operator；required / optional / none Human involvement 按适用 policy 接线，optional 不排斥真实 Human 采纳。

机器采纳的 Project Rules 可以在实际有效的 Human 采纳祖先边界内提供 standing authorization。Grant provenance 指向已存在的真实 HumanSemanticAct；没有祖先授权、祖先版本不再 current、撤销或过期时不能继续有效。这不创造新的 Human act，也不把机器结论当成 Human 批准。

Gateway 必须执行 canonical MCP 的参数 schema，不能因为内部直接调用 handler 而跳过拒绝未知字段。D/E 的 caller-selected Node selectors，包括值为 null 的 selector，均拒绝；D/E 仍以 Node 本地 current pair + CAS 为唯一语义事实。

Gateway ingress 的 listener / public reachability、Host exact locator health、Authority、exact Chat Presence、prepared return route、真实 delivery 分别报告。协议健康观察和历史 UI_ROUTE_VERIFIED 不构成 exact Presence。按需 Host 重探只能更新基础设施观察，不能创建新的 Agent turn 或重放 uncertain work。
> 2026-10-08 Codex final correction: 首个 World 采纳使用 versioned bootstrap procedure；后继 World 提案把 current World 自动固定为 governanceVersionId 并纳入 exact object digest。已采纳 World.policy.worldReviewPolicy 决定后继 World 的 reviewers、独立性、self-review、count 和 Human involvement；policy.reviewPolicy 继续治理子级。缺省才回退 bootstrap，提案不能用自己的新 procedure 审查自己。未采纳提案的治理版本过时则拒绝；已有 receipt 仅由原采纳主体幂等读取。机器 World 必须收窄治理祖先 boundary，Authority 追溯实际 Human 祖先。没有加入 autonomous Rule Evolution 生成器或元胞自动机。

> OAuth R1 使用 S256 PKCE + Node-bound rotating refresh。已注册客户端有两条明确路径：confidential client（`clientSecret`）与显式 `publicPkceOwnerApproval` 的 public client（token auth method `none`）。后者没有 client secret，公网 `/authorize` 不会自动签发 code，必须由 Human 在仅监听 127.0.0.1 的本机确认页核对客户端 / Node / 回调 / 核对码并点击批准，之后才以一次性、PKCE / redirect / client / scope 绑定的方式签发 code；没有 resource-owner authentication 的 public client 仍拒绝签发 Node credential。Gateway 要求 sidera.mcp scope，空 scope bearer 返回 403。OAuth authentication 与 Sidera Grant / Human adoption 分开。最终验收范围见 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md 与 SIDERA_R1_EXISTING_CONNECTOR_OAUTH_REPAIR_RESULT.md。

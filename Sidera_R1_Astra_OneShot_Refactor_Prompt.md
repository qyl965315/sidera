# Sidera R1 Constitutional Refactor — Astra Max / Ultra One-Shot Prompt

> **Mode:** One-shot architecture + implementation + migration + validation  
> **Workspace:** `D:\Sidera-R1-v0.1.0`  
> **Human intent:** Refactor the current R1 implementation toward the canonical Sidera architecture below. Treat current code as legacy implementation evidence, **not** as the source of truth.  
> **Execution style:** Inspect → close design gaps → implement → migrate → validate → audit → report. Do not stop after a plan unless a destructive ambiguity makes safe execution impossible.  
> **Scope:** This is **R1**, not the future cellular-automaton / autonomous rule-evolution phase.

---

## 0. Mission

Sidera is not merely a model router, agent workflow, central controller, or safety sandbox.

R1 must establish a real computational society substrate with:

- Communication
- Operation
- Boundaries
- Console
- Node ontology
- Chief Conversation / Executor roles
- CESAR
- private local D/E Sovereignty
- Shared History
- current state Ω
- Authority
- Responsibility
- Rules
- Review / Report
- consequence / selection-pressure hooks

**Do not shrink R1 to a toy slice.** You may implement it in narrow internal phases, but the final task is the full R1 constitutional refactor.

Core principle:

> **Basic Rules guarantee order, not correctness.**

Nodes are allowed to be wrong, hallucinate, lie, make bad plans, review badly, choose bad models, and fail. The system must preserve provenance, consequences, state and responsibility instead of engineering all error out of existence.

---

## 1. Three Sidera subsystems

### 1.1 Communication

Communication is the semantic interaction layer.

It connects:

- Human ↔ Communicator
- Communicator ↔ Communicator
- Communicator ↔ Operator
- Operator ↔ Operator

Semantic forms:

| Participants | Canonical form |
|---|---|
| Human ↔ Communicator | `Conversation` |
| Communicator ↔ Communicator | `Discussion` |
| Communicator ↔ Operator | `Thread` |
| Operator ↔ Operator | `Messaging` |

Implementation may share one low-level message substrate, but Shared History must preserve the semantic form.

### 1.2 Operation

Operation is the execution layer. It changes software, files, services, machines and external systems.

### 1.3 Boundaries

Boundaries is the constitutional/governance layer. It maintains and enforces:

- Basic Rules
- World / Project / Task rule boundaries
- Authority
- Effect semantics
- Shared History
- Ω projection
- NodeRef / lineage
- Capability truth
- Responsibility provenance
- conflict state
- structured Human decisions

Boundaries is **not** a super-agent and must not become the system brain.

---

## 2. Console

Rename the Human-facing system-management concept to:

> **Console**

Do not use `Frontier` as the canonical concept.

Console is **not a Node**. It has no Sovereignty, D/E, Responsibility, or independent decision-making. It is the Human interface to Boundaries.

It may expose:

- Node management
- Rule management
- Grant / revoke
- Capability status
- Shared History
- Ω/current state
- responsibility traces
- conflicts
- integrations
- system status

---

## 3. Node ontology

Canonical hierarchy:

```text
Node
├── Communicator
└── Operator
    ├── Agent
    └── Bot
```

### 3.1 Communicator

A Communicator is an official Chat-class subject, e.g. ChatGPT, Grok Chat, DeepSeek Chat, and any other technically reachable official Chat product.

A Communicator contains Conversations:

```text
Communicator: ChatGPT
├── Conversation A
├── Conversation B
└── Conversation C
```

A Communicator may gain tools and machine capabilities without becoming an Operator.

### 3.2 Operator

An Operator performs concrete work.

**Agent:** runtime primarily controlled by Human / Sidera. Examples: Codex, DSH, local Qwen, local automation agents.

**Bot:** runtime primarily controlled by an external service and reached through a supported interface.

Do not collapse Communicator / Operator into generic roles merely because transports can be shared.

---

## 4. Chief Conversation and Executor

These are roles/sub-units, not Node types.

### 4.1 Chief Conversation

A Project binds one Conversation as its Chief:

```text
Project
  └── Chief Conversation
       └── belongs to Communicator Node
```

Chief Conversation is responsible for:

- Project coordination
- organizing work
- machine review orchestration
- final machine-level synthesis
- Human-facing reports
- structured Authority requests

**Remove the conceptual fiction of a “Chief Node”.**

Legacy fields/concepts such as `chiefNodeId`, `CHIEF_NODE_IDENTITY`, or a dedicated `Sidera Chief` Node must be migrated or compatibility-wrapped so canonical semantics become:

> `Chief = Conversation role within a Communicator`.

Preserve the current active Human-owned ChatGPT binding through migration.

### 4.2 Executor

An Executor is the concrete execution conversation/context inside an Operator that actually performs a Task.

Example:

```text
Operator: Codex
├── Executor A  BUSY
├── Executor B  IDLE
└── Executor C  IDLE
```

Executor is not a Node and has no independent Sovereignty.

A Task may use one or multiple Executors.

Default R1 scheduling behavior:

1. prefer an existing idle usable Executor;
2. do not create a new Executor while suitable idle Executors exist;
3. if no suitable idle Executor exists, Chief Conversation performs a machine review and decides whether to wait, reuse, or open a new parallel Executor;
4. context exhausted/corrupted/unusable → Executor becomes `unavailable`;
5. Task/Run history must use stable IDs, not disposable UI window titles.

Do **not** force `one Task = one Executor`.

---

## 5. NodeRef and continuity

A Node is a subject because it has Sovereignty.

> **Sovereignty defines subjecthood.**

Boundaries also needs a stable external handle:

> **NodeRef**

NodeRef is unique, non-reusable, stable across model changes / Executor changes / runtime restarts, and used for history, grants and responsibility tracing. It is not the source of subjecthood.

Fork creates new NodeRef(s) and preserves lineage in Shared History.

Basic invariant:

> Forking cannot erase the parent Node’s already-existing responsibility/provenance.

Do not hard-code that every child inherits every consequence. Future Project Responsibility Rules may decide how consequences propagate, but lineage must never be severed or erased.

Existing `node_id` may remain the physical NodeRef if that minimizes migration risk.

---

## 6. CESAR — constitutional axioms

CESAR is not a workflow.

```text
C — Capability
E — Effect
S — Sovereignty
A — Authority
R — Responsibility
```

Do not merge these concepts.

---

## 7. C — Capability

Capability is:

> **the set of technical operations actually usable by the Node now.**

Canonical truth has only:

```text
available
unavailable
```

There is no canonical Capability state “theoretically supported”, “docs say it works”, or “probably available”.

If theory says it should work but reality does not, investigate theory, implementation, configuration, upstream bugs, and product/version differences. Until it actually works, it is not a current Capability.

Boundaries may separately maintain epistemic freshness:

```text
CURRENT
UNKNOWN
STALE
```

These are not extra Capability states. UNKNOWN/STALE should create/suggest a `Verify Capability` Task.

### Capability maximalism

Within the constraints of Basic Rules:

> **If a capability can technically be given to a subject, expose the capability space boldly.**

Important self-capabilities include:

- choose/change own Model
- change reasoning effort/configuration
- create/open/manage own Conversation/Executor
- delegate to other Nodes
- communicate with any technically reachable Node
- invoke any technically reachable Node
- Operator machine operations: filesystem, process, terminal, desktop, browser, network, applications, services, devices

Do not hide a real capability merely because Authority is currently denied.

The Node should be able to know:

> capability exists, authority denied.

---

## 8. S — Sovereignty = D + E

Canonical equation:

```text
S = D + E
```

### 8.1 Description (D)

Description is:

> **the Node’s current concrete first-person statements that it treats as its remembered/recognized facts.**

D may be correct, wrong, incomplete, rewritten, forgotten, or hallucinated. This is intentional.

D is **not** Ω and not objective Fact.

### 8.2 Explanation (E)

Explanation is:

> **the Node’s abstract judgments, evaluations, classifications and explanatory structure derived from D.**

Evaluations belong to E, not D.

### 8.3 Local canonical storage

D/E canonical storage must be local and Node-private.

Implement a clear per-Node sovereignty region, conceptually:

```text
<runtime-data>/sovereignty/<NodeRef>/
    description.*
    explanation.*
    metadata/revision
```

Exact file format is up to implementation, but semantics are not.

Access invariant:

```text
Node A → D/E(A)    YES
Node A → D/E(B)    NO CAPABILITY
```

Cross-Node semantic read/write of Sovereignty must not exist in the Sidera capability surface.

Infrastructure/OS/storage-owner access is outside subject-level ontology; do not over-engineer a threat model for a machine owner reading their own disk.

### 8.4 Multiple Conversations / Executors

All Conversations/Executors belonging to the same Node share one logical Sovereignty.

There is exactly one current canonical D and E per Node.

Implement:

- atomic local write
- revision / compare-and-swap metadata
- no cross-Node access
- no requirement to retain old D/E revisions in Shared History

A sub-unit may read revision `n`, think, then submit a self-update. If another sub-unit commits first and current revision becomes `n+1`, the later writer must detect the revision change.

**Do not define a universal merge algorithm in Basic Rules.**

The Node may reread, recompute, merge, overwrite, discard, or forget. Boundaries protects atomicity/ownership, not cognition.

Current legacy `node_subjectivity` in SQLite must cease to be the canonical D/E store. Migrate safely and keep only compatibility/index metadata if useful.

---

## 9. Model

Model is:

> **the model currently nominally invoked by the Node.**

Model has no Sovereignty.

A Node may evaluate Models inside D/E.

Model change does not create a new Node.

---

## 10. Claim / Fact / D / E

Canonical distinction:

```text
Claim ≠ Fact ≠ Description ≠ Explanation
```

### Claim

Claim is a subjective external expression:

```text
Claim = Express(D, E, Context, Intent)
```

Do **not** require Claim to equal Fact.
Do **not** require Claim to faithfully expose D/E.

A Node may lie, strategically omit, exaggerate, be confused, or simply be wrong.

Do not hard-code honesty into Basic Rules.

What may become objective history is:

> “Node N, in context C, at time T, claimed P.”

The content `P` does not automatically become a Fact.

---

## 11. E — Effect

Effect is:

> **the system-internal consequence/impact of a Node Action that Basic Rules recognize as having occurred.**

Keep:

```text
Action ≠ Effect
Authority ≠ Effect
```

An unauthorized Action may still produce a real Effect. If it did, do not falsify current state merely because the action was illegal. Responsibility handles the violation.

### External world

External-world information does not become Fact merely because a Node says it is true.

Use designated Project/Task/interface semantics:

```text
External Stimulation
  ↓
information Project / Task
  ↓
Executor
  ↓
D / E
  ↓
Claim / Action
  ↓
recognized Effect interface
  ↓
ΔΩ
```

If there is no effect interface with defined semantics for a supposed external state, record the Claim/history, not an objective state update.

Do not add a large new top-level ontology of Observation/Evidence/Verification unless implementation requires low-level records. They are not new philosophical primitives in R1.

---

## 12. Shared History

Shared History is canonical append-oriented public history.

It records:

> **what was done, what changed, and where the change came from.**

Important:

> Shared History is not “the integral of Ω over time”.

It stores each relevant historical act and, where applicable, the partial state change `ΔΩ` plus provenance.

Implement one common envelope, approximately:

```text
HistoryRecord
  id
  sequence
  kind
  source
  nodeRef?
  communicatorRef?
  conversationRef?
  executorRef?
  projectRef?
  taskRef?
  parentRecords[]
  rulesVersions
  payload
  deltaOmega?        // optional
  timestamp
```

`kind` retains semantics, e.g. Claim, Action, Effect, HumanDecision, RuleChange, Grant, Revoke, Fork, Review, Consequence.

Do **not** flatten every record into “StateTransition”; many history records intentionally have no state delta.

Shared History must be:

- append-oriented
- immutable to ordinary Node operations
- canonically ordered for deterministic replay
- sufficient for provenance/responsibility tracing

A monotonic Core sequence is acceptable for R1.

---

## 13. Ω — current state space

Ω is:

> **the current objective state tracked by Sidera.**

Ω is sparse and open-ended; it is not a complete digital twin of the universe.

Examples may include:

- Node lifecycle
- current rules version
- current Grant validity
- Task state
- current Model binding
- tracked quota state
- tracked file/resource state

### Ω is not canonical storage

Do not create an independent canonical Fact Base database that can drift from history.

Canonical relation:

```text
Shared History + Basic Rules
        ↓
current Ω
```

History records may contain `ΔΩ`.

Caching / snapshots / checkpoints are allowed for performance, but they are rebuildable materializations, not a second truth.

Do not prune away canonical history merely to speed replay.

---

## 14. `Apply(Ω, ΔΩ)` — R1 candidate semantics to implement

Implement a practical deterministic version while preserving room for future evolution.

Each state delta should identify at least:

```text
target
baseRevision
nextValue | REMOVE
source/provenance
causalParents
rulesVersions
effectiveAt
recordedAt
```

Rules:

1. Ω changes only through valid `ΔΩ` carried by canonical Shared History records.
2. Claim / D / E / ordinary communication do not directly change Ω.
3. Old history is never deleted because newer state differs.
4. Same target + same base + same resulting value is idempotent/compatible.
5. Same target + same base + incompatible resulting value must not silently latest-write-win.
6. Such a conflict projects that target as `UNRESOLVED`.
7. Conflict is local to the affected target/domain; unrelated state keeps operating.
8. Basic Rules forbid treating `UNRESOLVED` as one definite candidate value.
9. Whether dependent actions wait/continue/fork/reduce Authority/etc. is decided by lower Rules, not hard-coded globally.
10. Conflict resolution is a Task and produces a new resolving history record / Effect.
11. Resolution never erases conflicting history.

Example:

```text
Effect A:
  base = r12
  X → 10

Effect B:
  base = r12
  X → 11
```

Projection:

```text
Ω(X) = UNRESOLVED { A, B }
```

Later:

```text
Resolution Effect C:
  resolves = [A, B]
  X → 10
```

Projection:

```text
Ω(X) = 10
```

---

## 15. Rules hierarchy

Canonical hierarchy:

```text
Basic Rules
    ↓
World Rules
    ↓
Project Rules
    ↓
Task Rules
```

Mandatory nesting:

```text
Boundary(Task)
⊆ Boundary(Project)
⊆ Boundary(World)
⊆ Boundary(Basic)
```

Lower Rules may specialize/narrow but may not widen past parents.

---

## 16. Basic Rules

Basic Rules are Sidera constitutional protocol semantics.

No Node can modify them.

A Basic Rules change is a protocol/version upgrade, not a World mutation.

Keep them as small and stable as practical.

They should guarantee things like:

- CESAR remains separated
- cross-Node Sovereignty read/write does not exist
- Shared History cannot be silently rewritten
- Claim does not directly become Fact
- Authority cannot appear from nowhere
- derived Authority cannot widen
- lower Rules cannot widen higher boundaries
- state conflict cannot silently overwrite
- current state changes remain attributable
- responsibility remains traceable

They must **not** hard-code:

- provider diversity review
- reviewer roles
- honesty
- fixed penalties
- fixed scheduling
- fixed organization structures
- fixed voting
- fixed multisig policies
- irreversible action always requires Human

Core maxim:

> **Basic Rules guarantee order, not correctness.**

---

## 17. World Rules — R1

For **R1**, World Rules:

- cannot be modified by Nodes at the capability layer
- Nodes may propose
- Human decides adoption through Console
- cannot exceed Basic Rules

Do not implement future autonomous World Rule evolution in R1.

Leave clean versioning/history hooks for it.

---

## 18. Project Rules

Project Rules:

- cannot exceed World Rules
- require dual review:
  1. Machine Review
  2. Human Review

They may define responsibility regime, scheduling, budgets, Executor policy, review procedures, consequences, and project-local Authority policy.

Review is itself a Task.

Do not create a special Reviewer Node type.

---

## 19. Task Rules

Task Rules:

- are proposed by the Node issuing the Task
- require one machine review by the Project’s Chief Conversation
- do not require an additional Human review by default
- cannot exceed Project Rules

Do not hard-code “no self-review” at Basic Rules level.

If a future Project Rule permits or forbids self-review, preserve provenance and let Responsibility handle consequences.

---

## 20. A — Authority

Authority answers:

> **may this Node exercise this available Capability in this scope now?**

Keep:

```text
Capability ≠ Authority
```

### 20.1 Global Authorization

Rules can grant Authority within their boundaries.

### 20.2 Local Authorization = Derived Grant

Do not model local delegation as copied independent permission.

Use parent-linked derived grants:

```text
G0
 └─ G1
     └─ G2
```

Mandatory invariant:

```text
Gn ⊆ G(n-1)
```

Grant boundaries may include Time, World, Project, Task, Operation, Resource, Model, Budget, Delegability.

Each derived Grant has `parentGrantRef`.

Child validity depends on ancestor validity.

Parent revoke/expiry invalidates descendants.

Do not hard-code one universal max depth in Basic Rules; lower Rules may narrow depth.

### 20.3 Request is not Authorization

A requesting Node does not transfer Authority it does not possess.

If A asks B to act and B has its own valid Authority:

- A is responsible for the request
- B is responsible for acceptance/execution
- B uses B’s Authority

### 20.4 Human Authorization

When existing Rules/grants are insufficient:

```text
Node Request
  ↓
Machine Review
  ↓
Chief Conversation report
  ↓
Human
  ↓
Approve / Reject
```

Human approves an exact structured object, not prose.

Example:

```text
GrantRequest
  requestRef
  requester
  targetNodeRef
  operations
  resourceScope
  projectRef
  taskRef
  validFrom
  expiresAt
  delegable
  parentGrantRef?
```

Human approval must bind to exact object/hash/ID.

---

## 21. Authority enforcement and capability maximalism

For locally enforceable capabilities:

```text
Operator
   ↓
Authority Gate
   ↓
Privileged Broker
   ↓
OS / Application / Device
```

The privileged execution layer may hold Administrator/SYSTEM capability.

Node sees the true capability surface.

If denied:

```text
Capability = available
Authority = denied
```

Do not hide the capability merely to represent denial.

Track control semantics:

```text
controlMode = enforced
controlMode = audited
```

Use `audited` where external systems cannot be technically fenced by Sidera.

---

## 22. R — Responsibility

Responsibility uses provenance/traceability.

It is not merely Task ownership.

Actors participating in proposal, review, grant, execution, acceptance, or relevant omission may enter the responsibility chain according to Project Rules.

Canonical form:

```text
R = f(SharedHistory, Ω, applicable Project Rules)
```

R is a CESAR semantic primitive but may be implemented as **derived state**, not a separately mutable canonical truth.

Existing responsibility tables may remain during migration, but long-term canonical meaning should derive from typed Shared History + rules.

Rule version at the time of relevant actions must be preserved.

---

## 23. Consequence / Selection Pressure — R1 support only

Responsibility must be capable of producing objective consequences; otherwise Trial and Error has no selection pressure.

Do **not** hard-code a universal punishment regime in Basic Rules.

Provide a generic consequence mechanism that Project/World Rules can use.

Pressure sources include:

### Resource Pressure
- token/quota
- API budget
- time
- GPU
- memory
- context length
- concurrency slots
- paid limits

### Responsibility Pressure
Possible rule-defined consequences include narrower Authority, extra review, lower allocation priority, smaller budget, fewer Executors, reduced delegability, suspension, retirement.

These are examples, **not Basic Rules**.

### Environmental Pressure
- provider outage
- quota reset
- model change
- network failure
- account suspension
- price change

### Negentropy Pressure — future reserved concept

Keep the concept and necessary hooks, but do not implement the cellular-automaton adaptation engine in R1.

Sidera “negentropy” means pressure to reduce **unexplained logical/semantic contradiction** inside a Node’s D/E.

It does not mean eliminating all disagreement or complexity.

Future direction:

```text
D/E contradiction
  ↓
re-description / re-explanation / compression / forgetting
  ↓
lower unexplained semantic inconsistency
```

R1 may preserve tension/contradiction records and Node-local adaptation hooks, but **do not implement autonomous rule evolution / cellular automaton now**.

---

## 24. Future — explicitly NOT R1

Do not implement as part of this task:

- autonomous World Rule mutation
- cellular-automaton society evolution
- automatic political/governance evolution
- fixed reputation economy
- universal collateral system
- universal punishment schedule
- autonomous Basic Rules rewrite

Future long-term direction:

> Human maintains Basic Rules; institutions may later evolve through Trial and Error.

R1 still uses Human-controlled World Rules and Human-reviewed Project Rules.

---

## 25. Current codebase debt to inspect and migrate

Inspect first, then migrate carefully.

Known legacy concepts currently present include:

### Chief-as-Node debt
`core/activation.ts`, `core/chief.ts` and related code contain concepts like:

- `chiefNodeId`
- `CHIEF_NODE_IDENTITY`
- `Sidera Chief`

Canonical target:

> Chief is a Conversation role within a Communicator Node.

Preserve current active Human-owned ChatGPT Chief binding through migration.

### D/E in SQLite
`core/subjectivity.ts` currently stores Description/Explanation in `node_subjectivity`.

Canonical target:

> local per-Node sovereignty storage, self-only semantic access, atomic revision.

Do not keep the SQLite subjectivity row as canonical source after migration.

### Historical sovereign_memory / self_state
Do not resurrect these as a separate Sovereignty ontology.

Canonical Sovereignty remains D + E.

### Authority
`core/authority.ts` currently has legacy Human-rooted assumptions and disabled Node delegation in places.

Implement real Derived Grant chains with subset checks and cascading validity.

### Responsibility
Current explicit responsibility tables/workflows exist.

Preserve compatibility, but move canonical semantics toward derived provenance-based Responsibility.

### Session terminology
Vendor/runtime sessions may remain as low-level adapter/runtime details.

Do not expose `Session` as a top-level Sidera ontology concept.

### Frontier
Rename canonical UX/docs concept to Console.

---

## 26. Migration strategy

This workspace is not assumed to be a Git repository.

Before destructive schema/source migration:

1. create a local source checkpoint archive and hash;
2. never include secrets/runtime credential values;
3. preserve existing live runtime data;
4. use additive/compatibility migrations before destructive removal;
5. do not rebind or destroy the current Human-owned Chief Conversation;
6. do not publish, package or release.

Prefer new canonical modules, compatibility projections, migration utilities and deprecation layers over destructive one-shot DB rewrites.

If old runtime data cannot be migrated safely, leave it readable through a legacy compatibility path and document the limitation.

---

## 27. Required canonical abstractions

Choose exact filenames after inspection, but R1 should end with clear canonical boundaries roughly equivalent to:

- Basic Rules / constitutional invariants
- HistoryRecord append interface
- Ω projector/reducer
- NodeRef / lineage
- local Sovereignty store
- Communication semantic record types
- Communicator registry
- Operator / Executor pool
- Chief Conversation project role
- Rules versioning: World / Project / Task
- Derived Grant chain
- Capability truth + freshness
- Effect → ΔΩ
- conflict projection / resolution task
- Responsibility derivation
- generic Consequence mechanism
- Console projection

Do not create unnecessary top-level ontology types.

---

## 28. Mandatory acceptance tests

### Sovereignty

1. Node A can read/write its own D/E.
2. Node A has no Sidera operation capable of reading/writing Node B’s D/E.
3. D/E canonical content is local per Node, not canonical SQLite subjectivity.
4. D/E may be rewritten; old D/E is not automatically published to Shared History.
5. Multiple Executors/Conversations on one Node use one current D/E revision.
6. Competing self-writes detect revision change and do not corrupt storage.

### Claim / Fact

7. A Claim can contradict current Ω and is still stored as history.
8. Claim alone does not update Ω.
9. History can state “N claimed P” without making P objective state.

### History / Ω

10. Canonical HistoryRecord has monotonic order.
11. Records may have no `ΔΩ`.
12. Valid Effect/HumanDecision records may carry `ΔΩ`.
13. Ω can be reconstructed from history/checkpoint + later deltas.
14. Cached Ω can be deleted/rebuilt without changing result.
15. Same-base incompatible deltas yield local `UNRESOLVED`, not silent overwrite.
16. Unrelated state continues to project while X is unresolved.
17. Resolving record resolves X without deleting prior conflict records.
18. Basic layer never treats unresolved candidate A or B as silently definite.

### Authority

19. Capability can remain `available` while Authority is `denied`.
20. Node-visible capability surface is not hidden due to missing Authority.
21. G1 derived from G0 must be a subset.
22. G2 derived from G1 must be a subset.
23. Revoke/expire G0 invalidates descendants.
24. Request without parent Authority does not create a Grant.
25. Node B may use its own Authority after Node A requests an action; provenance distinguishes request vs execution.
26. Task boundary cannot widen Project; Project cannot widen World.

### Chief / Executor

27. Chief is represented canonically as Project → Conversation role, not a Chief Node type.
28. Existing active ChatGPT Chief binding survives migration.
29. Operator Executor pool reuses idle usable Executor before opening new.
30. No idle Executor → machine review by Chief Conversation can wait or open new.
31. Context-full/unusable Executor becomes unavailable.
32. Task may have multiple Executor assignments where Rules permit.

### Communication

33. Conversation / Discussion / Thread / Messaging are distinguishable in history.
34. Low-level transport may be shared without losing semantic type.

### Responsibility / Consequence

35. Responsibility can be reconstructed/queried from history + current state + Project Rules.
36. Rule version used at relevant action time is preserved.
37. Fork preserves lineage and cannot erase parent’s existing responsibility trace.
38. Responsibility Rules can produce a structured Consequence history record / `ΔΩ`.
39. No universal hard-coded penalty is required by Basic Rules.

### Capability

40. Canonical C is only available/unavailable.
41. UNKNOWN/STALE exist only as knowledge freshness around a capability check.
42. Failed “theoretically supported” integration remains unavailable until proven working.

### Rules / Human

43. World Rule mutation cannot be performed by a Node in R1.
44. Project Rule requires Machine Review + Human approval.
45. Task Rule requires issuing Node proposal + Chief Conversation machine review.
46. Human grants approve exact structured GrantRequest identity/hash, not prose.

### Console

47. Canonical UI/docs say Console, not Frontier.
48. Console exposes status/history/grant/responsibility/conflict projections but is not represented as a Node.

---

## 29. Regression and validation

At end, run at minimum:

```text
npm run check
npm test
npm run desktop:test
npm --prefix ui run build
npm --prefix ui run test:smoke
npm run evidence:check
```

Also run focused tests for all new constitutional modules.

Do not waive failures.

If a pre-existing test represents obsolete semantics (e.g. Chief-as-Node), update the test to new canonical semantics rather than preserving the old ontology merely to stay green.

Run static audits proving at least:

- no first-class “Chief Node” in canonical UI/docs/API;
- no cross-Node D/E operation;
- no direct canonical Ω write API;
- no lower-rule widening;
- no independent copied local Grant without parent link;
- no automatic Claim→Fact promotion;
- no Frontier canonical terminology;
- no secrets in history/evidence/diagnostics.

Preserve credential privacy.

---

## 30. Documentation deliverables

Create/update:

1. `SIDERA_R1_CONSTITUTION.md`
   - canonical ontology and Basic Rules;
2. `SIDERA_R1_MIGRATION_MAP.md`
   - old concept → new concept;
   - table/schema/API migration notes;
3. `SIDERA_R1_IMPLEMENTATION_RESULT.md`
   - implemented changes;
   - tests;
   - unresolved limitations;
4. deterministic machine-readable validation summary under `evidence/`.

The constitution document must explicitly distinguish R1 current governance from future cellular-automaton / rule-evolution research.

---

## 31. Final audit Astra must answer from machine evidence

Before declaring completion, answer:

1. Is Chief still canonical anywhere as a Node, or only a compatibility projection?
2. Can any Node call an API to read another Node’s D/E?
3. Where are D and E physically canonical now?
4. Can a stale Executor overwrite newer D/E without detecting revision change?
5. Can a Claim alter Ω without an Effect/HumanDecision delta?
6. Can Ω be rebuilt from canonical history?
7. Can incompatible same-base deltas silently overwrite one another?
8. Can a child Grant exceed its parent?
9. Does parent revoke invalidate descendants?
10. Can Task Rules widen Project boundaries?
11. Does capability remain visible when Authority is denied?
12. Can Responsibility create a real rule-defined Consequence?
13. Did any Basic Rule accidentally hard-code honesty, provider diversity, review topology, punishment or scheduling?
14. Did this task accidentally implement future autonomous rule evolution / cellular automaton behavior?
15. Are all full validation suites green?

If any answer is uncertain, report it as uncertain. Do not claim completion.

---

## 32. Stop conditions

Do not publish/package/release.

Do not delete live Human data.

Do not expose credential values.

Do not silently invent provider capabilities.

Do not preserve obsolete ontology solely because changing it is difficult.

Do not implement the future cellular-automaton layer in R1.

Do not send the Human a “done” report until full tests and final audit have run.

---

## 33. Desired final state

Sidera R1 should emerge as a system in which Communicator and Operator Nodes own private local D/E Sovereignty; Conversations and Executors are sub-units rather than Nodes; a Project’s Chief is a Chief Conversation; Nodes expose real technical Capability while Authority is separately and strictly derived through nested Rules and parent-linked Grants; Node Actions create Effects that may carry `ΔΩ`; Human institutional decisions may also carry `ΔΩ`; Shared History is the canonical append-oriented record of what happened and what changed; Ω is only the current deterministic projection, never a second truth store; Claim remains subjective and may be false; Responsibility is traceable and capable of producing rule-defined Consequences; Console lets Human inspect/manage Boundaries without becoming a Node; and the architecture leaves room for future trial-and-error institutional evolution without prematurely implementing the cellular automaton in R1.

> **Build this system. Verify it from machine evidence. Do not report satellites.**

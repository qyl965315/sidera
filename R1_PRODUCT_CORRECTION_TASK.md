# Sidera R1 Pre-Release Product-Level Correction

Context: this is NOT R2. We are doing one final product-grade correction pass on the unpacked R1 Windows release at D:\Sidera-R1-v0.1.0 before public publication.

Human product diagnosis:
- We already have a frontend, but too many normal Human/admin operations still require PowerShell.
- Human/admin intent should be expressed through product UI wherever safe and semantically honest.
- A Human confirmation may be a button or explicit typed confirmation in the UI, but must remain a real Human action. Models/Nodes must not be able to self-authorize.
- CLI remains for advanced/recovery use, not as the normal product path.

Architectural method for this pass:
1. Enumerate actual product functions and interfaces.
2. For each function, identify ONE canonical implementation/operation. UI/CLI/MCP should reuse it rather than duplicate business logic.
3. Remove redundant wrappers, duplicate pathways, legacy fallbacks, and pass-through layers that add no independent semantic invariant.
4. Prefer A→B over A→B→C→D where C/D only forward data.
5. Do NOT remove layers with real semantic responsibility: Node identity, Session context, Authority, Effect knowledge, Human admission, exact routing, uncertainty/no-replay.
6. No abstraction without a semantic invariant.
7. Do not add defensive fallback behavior that guesses success, reroutes silently, retries uncertain effects, or invents Presence.
8. Do not optimize by weakening safety semantics.

## Product functions that should be normal frontend flows
At minimum audit and, where safe, move these into the frontend:
- first-run bootstrap / minimal runtime config
- config validation
- Human principal creation
- Human authority statement review/admission
- provision approved grants
- Node/Host inventory and health
- adding/removing/configuring a Node/Host where this can be safely represented
- Chief conversation binding / handoff
- return-route status
- Core/Gateway/frontend health
- starting/stopping local Core where safe
- viewing Tasks/Responsibilities/Supervisions
- Human task submission / intent entry
- safe reconciliation requests where the canonical backend already supports them
- permission profile review/apply
- explicit error/uncertain resolution guidance

Do not expose an operation in UI merely because a CLI command exists. Each UI mutation must preserve the same Human/Authority/Effect semantics.

## Required deliverables

### A. FUNCTION_INTERFACE_MAP.md
Create a full function inventory table:
- Human-facing function
- current entry points (UI/CLI/MCP/internal)
- canonical backend implementation
- whether duplicated
- keep/merge/delete decision
- reason
- product owner (Human/System/Node)

Flag:
- one function with multiple implementations
- interfaces that only forward data
- legacy fallbacks
- CLI-only normal-user operations
- missing product flows

### B. PRODUCT_FLOW_R1.md
Define the Human mental model and end-to-end flows:
1. Install / first run
2. Setup
3. Add/connect a Node/Host
4. Bind Chief
5. Submit work
6. Monitor work
7. Resolve blocked/error/uncertain states
8. Stop/restart local runtime
Show each as a short flow diagram. Keep flows minimal.

### C. ARCHITECTURE_DIET_R1.md
Audit the current code architecture:
- abstractions with independent semantic invariants: keep
- pass-through abstractions: merge/remove
- duplicated transformations/projections: consolidate
- repeated data movement between layers: simplify
- legacy compatibility paths not required for R1 release: remove or isolate
- identify any data that is transformed repeatedly across Core -> RPC -> integration -> frontend.

Do NOT perform a large rewrite just to reduce file count. Changes must reduce conceptual and interface duplication.

### D. Implement product corrections
Build a proper local Setup/Admin experience in the frontend.

Normal Human flow should become:
Unpack package -> start one local launcher -> browser opens/points to Sidera -> setup wizard -> ready -> project/task Home.

PowerShell should not be needed for ordinary setup after the launcher is started.

Add a visible "设置 / Setup" area with:
- bootstrap/config state
- Human identity/authority
- Node/Host setup
- Chief binding
- health/readiness
- advanced/manual recovery section with CLI commands only as fallback

Human confirmation:
- For high-trust acts like Human authority admission, UI must display exact scope and require explicit confirmation.
- It can be a typed confirmation or a strongly labeled confirm action depending on the canonical backend contract.
- Browser action must be local-only, same-origin, and server-mediated.
- Nodes/models cannot invoke Human-only endpoints through MCP.

### E. One local launcher
Provide one ordinary local start path for Windows, e.g. a script/launcher that:
- ensures minimal runtime bootstrap exists
- starts Core
- starts frontend
- prints/opens the local UI address
- does not silently create Human authority, bind a Chat, log into Hosts, or replay Effects
- handles already-running processes honestly

Do not build a fake installer; a reliable launcher is enough for R1.

### F. Security/API rules
- loopback only for local admin/setup APIs
- same-origin checks
- no generic shell/command endpoint
- no arbitrary file path input
- no arbitrary RPC method input
- secrets never returned to React
- no auto-retry of uncertain operations
- no silent fallback to demo/mocks
- stable error codes for setup/admin operations

### G. Validation
Run:
- npm run check
- npm test
- UI build
- UI smoke
- setup/admin tests
- clean-install simulation from a fresh temp copy
- verify ordinary first-run requires no PowerShell after launching the one launcher
- verify Human-only authorization cannot be silently triggered
- verify no secrets leak into browser responses
- verify unavailable return route remains blocked, not green
- verify existing 243 backend tests remain green or explain exact intentional test changes

Write R1_PRODUCT_CORRECTION_REPORT.md with:
- what was removed/merged
- what remains CLI-only and why
- final Human first-run flow
- final architecture map
- release blockers, if any

Important: preserve R1 ontology. Do not introduce R2 multi-Session/subject-continuity redesign in this pass.

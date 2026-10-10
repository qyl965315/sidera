# Sidera R1 G2 — Four-party bounded convergence charter (2026-10-10)

## Authority and scope
User directed GPT + Codex + DSH + Grok collaboration on G2. This file is a TASK WORKING CHARTER, NOT adopted Basic/World/Project Rules. GPT coordinates; models provide source-backed proposals and bounded implementation/review, not Human authorization. G1 isolated acceptance is frozen at `g1-stage/project`. G2 isolated working tree is THIS checkout. Git baseline: `692efd5` copied from accepted G1. No writes to production `D:\Sidera-R1-v0.1.0`, credentials, production database, D/E, Rules, Node/Grant, live services, or G1. No public deployment.

## G2 contract (from working plan, section 6)
Converge Final Gate, Attempt, Host loss, Reconciliation, and Adapter Inspect/Probe/Recover. Inject tests for (1) Host timeout, (2) TCP jitter, (3) stream close, (4) confirmed Host exit, (5) response loss, (6) power-loss snapshot, (7) duplicate message, (8) old credential migration, (9) token reuse. Each may-have-effect operation must never be resent without exact no-effect proof; unknown outcome stays UNCERTAIN.

## Nonnegotiable invariants
- Sidera Identity/NodeRef/Rules/Human-rooted authority and Shared History remain authoritative; Claim is not Fact.
- Configuration, reachable transport, authenticated ingress, exact chat presence, and return route cannot be confused.
- A timeout / stream ending / transport close is NOT evidence of Host physical termination, must not create irreversible resource-loss fence.
- LossProof must bind exact owner/session/generation/receipt and cannot be synthesized by model output or stale observation.
- Final Effect boundary and all attempts must be inspectable; no replay of uncertain actions, no silent privilege escalation or hidden Host start during Inspect.
- Only explicit authorized Recover can create or resume Host resources. Independent reviews cannot approve Human-only decisions.
- Keep compatibility only with explicit retirement conditions. Do not invent second scheduler, history, Ω or service.

## Four-party division
- GPT: integration owner, code/evidence review, final engineering decision; only GPT authorizes transitions among model tasks.
- Codex: implementation lead after approval of a bounded plan, owns `core/reconciliation.ts`, `core/runtime.ts`, `core/host-health.ts`, `core/launch.ts`, `core/continuations.ts` and new scoped tests. No write to other files without specific instruction.
- DSH: independent design reviewer; check Host lifecycle/safeguards and read-only review of final patch.
- Grok: adversarial fault-injection designer/reviewer; initially read-only, no source edits.
- Each model must label observations as VERIFIED, CLAIM, UNRESOLVED. No 'PASS' without logs and exit codes.

## Workflow
1. READ-ONLY initial review: Codex proposal, DSH lifecycle review, Grok fault matrix, each separate report.
2. GPT synthesizes, resolves design conflicts and issues bounded implementation scope to Codex; tests first when feasible.
3. GPT runs repeatable isolated tests; Grok independently critiques fault tests; DSH reviews final result.
4. Preserve complete output, checks, hashes, disputed issues and G2 gate verdict; if material issues remain do not claim G2 accepted. Do not enter G3 or production.

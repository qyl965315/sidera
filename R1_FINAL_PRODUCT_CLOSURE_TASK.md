# Sidera R1 Final Product Closure — Phase 2

This continues the pre-release product-level correction in D:\Sidera-R1-v0.1.0.

The previous pass already performed the requested first-principles review:
- FUNCTION_INTERFACE_MAP.md maps actual Human-facing functions to canonical implementations and flags MULTI/FWD/LEGACY/GAP.
- PRODUCT_FLOW_R1.md aligns implementation with the Human mental model and minimal end-to-end flows.
- ARCHITECTURE_DIET_R1.md explicitly applies “one semantic implementation, no pass-through abstraction without an invariant, prefer A→B to A→B→C→D, no redundant fallback.”
Do NOT repeat the same audit from scratch. Use those documents as constraints.

Current product status is HOLD for three explicit gaps:
1. ordinary UI lacks bounded setup for executable/API Hosts and real return-route installation;
2. active Session handoff / Node retirement / safe Host reconfiguration remain advanced-only;
3. corrected public package has not been rebuilt/sanitized.

Goal: close as much of these as can honestly be closed in R1, without R2 ontology changes and without weakening Authority/Effect/exact-routing semantics.

## 1. Productize concrete Host setup — no generic JSON editor
Implement bounded adapter-specific setup flows only for Hosts whose required parameters can be safely modeled from existing R1 contracts.

At minimum evaluate and, where viable, implement setup UI for:
- Codex app-server
- DSH harness ACP
- Grok Build ACP
- Antigravity/Gemini Agent
- ZCode/GLM
- OpenAI-compatible / DeepSeek API
- external MCP client

Rules:
- one adapter = one typed form/schema backed by the existing canonical Host factory options;
- no arbitrary options JSON in normal UI;
- no arbitrary executable/file picker that weakens trust. Where a path is necessary, discover from known supported installed locations or require explicit Human selection through a bounded field and validate it;
- credentials must remain local/server-side and use environment/reference semantics where the adapter already supports them;
- never return credentials to React;
- Host sign-in stays in the owning Host if Sidera cannot officially perform it;
- distinguish configured / discovered / authenticated / reachable / Presence;
- do not label a Host ready from configuration alone.

If an adapter cannot be safely productized for R1, leave it advanced and document the exact reason. Do not invent support.

## 2. Node/Session lifecycle UI
Audit existing canonical operations for:
- Session bind/handoff
- Node retirement
- safe Node rename
- Host reconfiguration / replacement
Implement UI only where an existing canonical operation already preserves identity/history/open work.
Do NOT implement lifecycle by editing/deleting RuntimeSpec rows.
If Human authority is required, use local Human setup ingress with exact reviewed statement and explicit confirmation, then call the canonical operation.
If the operation is Node-authorized and Human cannot legitimately impersonate the Node, leave advanced and explain why.

## 3. Chief / return-route product flow
Improve Setup so it can:
- bind/handoff the exact Human conversation;
- detect supported frontend route types from existing FrontendAdapterRegistry;
- configure a bounded mcp-http route when the Human provides an exact endpoint plus secret reference (secret stays server side);
- configure native codex-app-tools only when the real installed bridge/context exists;
- clearly state that binding != Presence != return route.
No browser automation as production return.
No guessed current Chat URL.
If current ChatGPT product cannot supply detached proactive return, present that as an accepted R1 limit, not a setup failure that blocks local product use.

Define two readiness levels if useful:
- LOCAL_READY: Sidera local runtime usable/monitorable
- FULL_ROUTE_READY: executable work + authenticated exact Human return route available
Do not collapse them.

## 4. Normal Human task entry
Move ordinary task submission out of Setup into a first-class product surface (e.g. Home/New Work) once setup is locally ready.
Setup should configure the product; Home should operate it.
Keep literal Human intent and one-shot submission semantics.
No auto retry.

## 5. Remove obvious remaining product/architecture smells
Using the existing audit, implement only high-confidence reductions:
- merge duplicated option/schema validation if currently repeated;
- remove stale hard-coded developer paths/fallbacks;
- remove dead UI affordances that can never work in R1;
- isolate legacy diagnostics from ordinary product paths;
- avoid adding a second projection or second admin API stack.

Do not churn semantically meaningful layers or rewrite for aesthetics.

## 6. Public package closure
Create a sanitized release candidate directory from the corrected code:
- exclude .sidera-dev
- exclude test runtime databases
- exclude correction-evidence/before checkpoints, logs, JSONL task logs, local screenshots unless intentionally public
- exclude node_modules unless the Windows package intentionally vendors dependencies; if vendored, justify and verify no private state
- include Start-Sidera.cmd, README with Chinese quick-start first, frontend dist, package manifests, release notes, setup docs
- include no private IDs, current Chat URLs, usernames, local absolute dev paths, tokens, cookies, API keys
- run a privacy/secret/path scan over the final candidate
- unpack the candidate into a fresh temp directory and validate first-run from there

Do not overwrite the existing archived v0.1.0 release ZIP yet. Produce a new candidate under:
D:\CodexProjects\Sidera-Releases\candidate-r1-product-correction\
with hashes and a candidate manifest.

## 7. Acceptance
Required:
- npm run check
- full npm test
- setup/admin tests
- UI build + smoke
- clean install test from final candidate
- one-launcher -> setup without PowerShell
- Human-only confirmation cannot be triggered silently
- local ready state reachable without fake external return
- full-route-ready remains false unless real evidence exists
- no secret leakage
- no blind replay
- original 249 tests remain green unless there is a clearly documented intentional replacement

Write:
- R1_FINAL_PRODUCT_CLOSURE.md
- updated R1_PRODUCT_CORRECTION_REPORT.md
- candidate manifest + SHA256SUMS under candidate directory

Final verdict must be one of:
- RELEASE_READY
- RELEASE_READY_WITH_EXPLICIT_EXTERNAL_LIMITS
- HOLD
with exact reasons.

Do not publish to GitHub yet; only prepare the final candidate.

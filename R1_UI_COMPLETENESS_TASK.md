# Sidera R1 Final UI Completeness Pass

Human product decision:
**Every ordinary Human-accessible tool/capability should be represented in the Sidera frontend.**
CLI is recovery/automation/diagnostic fallback only. The frontend is the Human control plane.

This does NOT mean dumping raw MCP tools as buttons. It means every Human-meaningful operation has an intentional UI surface, with the same canonical backend implementation and safety semantics.

Use the existing FUNCTION_INTERFACE_MAP.md, PRODUCT_FLOW_R1.md, ARCHITECTURE_DIET_R1.md, and R1_FINAL_PRODUCT_CLOSURE.md. Do not re-audit from scratch.

## Product principle
- Human-facing capability => frontend surface.
- Node-only/internal capability => visible in Advanced/System catalog if useful, but not exposed as a Human mutation unless Human is a legitimate actor for that operation.
- One capability -> one canonical implementation.
- UI can be simple; semantics cannot be weakened.
- No raw generic RPC/MCP console in normal product UI.
- No arbitrary JSON options editor in normal UI.
- No arbitrary shell execution.
- No fake ready state, fake Presence, silent retry, or fallback.

## Required frontend structure

Add/complete these Human product surfaces:

1. **Home / Work**
   - New Work / submit intent
   - current projects/tasks
   - review outputs
   - blocked/uncertain guidance

2. **Nodes**
   - inventory of all configured Nodes
   - add/configure supported Host adapters via typed adapter-specific forms
   - show configured/discovered/authenticated/reachable/Presence as distinct states
   - rename where canonical Human path exists
   - lifecycle actions only where canonical actor semantics permit
   - for actions that remain Node-authorized, show them visibly with explanation and exact reason they are not Human-executable; do not hide them.

3. **Connections / Routes**
   - Chief conversation bind/handoff
   - return route configuration and health
   - MCP HTTP route setup
   - native route setup only when supported context exists
   - external Chat edge inventory

4. **Authority / Permissions**
   - Human principal
   - permission profile review/apply
   - current grants
   - revoke where existing Human canonical operation exists
   - show exact scope before changes

5. **Effects / Recovery**
   - uncertain effects
   - sourced reconciliation
   - original request/result identifiers
   - no replay
   - Node-only reconciliation actions displayed but gated with actor explanation

6. **System**
   - Core start/stop
   - Core/MCP/UI health
   - runtime config
   - adapter/tool inventory
   - capability catalog
   - version/build identity
   - local readiness vs full-route readiness

7. **Tools / Capabilities catalog**
   Create an explicit frontend catalog that enumerates all canonical Sidera operations/tool capabilities, grouped by:
   - Human operations
   - Node operations
   - Read-only inspection
   - Advanced/recovery
   For each:
   - name
   - what it does
   - actor allowed (Human / Node / System)
   - current availability
   - route/source (canonical operation)
   - whether executable from UI
   - why not, if not executable
   This ensures no capability is hidden merely because it is CLI/MCP-only.

## Host setup
Productize as much as possible for:
- codex-app-server
- dsh-harness-acp
- grok-build-acp
- antigravity-cli-headless
- zcode-native-service
- openai-compatible-api
- deepseek-api
- external-mcp-client

Use bounded typed schemas/forms. If a real login or provider-owned action is required, UI must launch/guide to the owning Host only through supported mechanisms and then re-check state. Never fake login.

## Lifecycle
For Session handoff, Node retire, Host replacement:
- surface the capability in UI.
- if Human cannot legitimately execute it under R1 semantics, show it as unavailable to Human with actor requirement and exact canonical operation.
- do not create a parallel Human impersonation path.
This satisfies frontend completeness without breaking authority.

## Validation
- npm run check
- full npm test
- setup/admin/tool-catalog tests
- UI build/smoke
- clean-install candidate test
- verify every function in FUNCTION_INTERFACE_MAP.md has a frontend location or a visible Advanced catalog entry
- verify no Human-ineligible Node operation becomes executable
- verify no secret leakage
- verify no generic command/RPC console
- update FUNCTION_INTERFACE_MAP.md with final frontend location column
- write R1_UI_COMPLETENESS_REPORT.md
- update R1_FINAL_PRODUCT_CLOSURE.md verdict.

Final verdict target:
RELEASE_READY_WITH_EXPLICIT_EXTERNAL_LIMITS if every Human-meaningful capability is surfaced and remaining non-executable items are correctly actor-gated/external-limited rather than missing product flows.

Do not publish yet. Prepare final candidate only.

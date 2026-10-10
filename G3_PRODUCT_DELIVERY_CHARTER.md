# Sidera R1 G3 — Product implementation contract (2026-10-10)

Status: engineering charter, not Basic/World/Project/Task Rules. Human explicitly approved implementing latest R1 design and forbade generic "AI-style" UI aesthetics. Scope: isolated G3 Git checkout only; original production directory/state/credentials remain untouched pending separate integrated release validation. Baseline commit efe1ace is G2 accepted.

## Canonical source precedence
- Ontology/authority: SIDERA_R1_CONSTITUTION.md (2026-10-08), not the 2026-10-07 Review Draft PDF.
- Systems convergence/acceptance: SIDERA_R1_BACKEND_CONVERGENCE_WORKING_PLAN.md (2026-10-09).
- Normal desktop workflow/visual hierarchy: R1_DESKTOP_UX_PRIMARY_SURFACE_ADDENDUM.md and R1_DESKTOP_UX_HIERARCHY_TASK.md / report (2026-10-06).
- R1_NO_CONSOLE_ADDENDUM.md rejects terminal/PowerShell as HUMAN interaction; it does not prohibit graphical Console as Boundaries interface.
- Product core owns identity/authority. UI doesn't create Node identity, Presence, consent, Effect or Host completion.

## Finished-product targets
A. Work is foreground: project/task chronology with real state, results, traceable evidence and next input. A saved-intent revision is never claimed as a delivered Agent turn.
B. Communication is a subsystem: Conversation (Human <-> Communicator), Discussion (Communicator <-> Communicator), Thread (Communicator <-> Operator), Messaging (Operator <-> Operator). Project Chief is a role within a specific Conversation, not Node. The desktop Chat must show truthful exact-bound Conversation status and real messages; must NOT fabricate model responses or fake a send endpoint. Send/receive only through an existing or newly legitimate typed canonical Core/Frontend path with validated Human/Node identity, Authority, Effect, exact binding, transport and durable correlation; otherwise show disabled and explain why. External ChatGPT/Grok frontends remain valid; integrated Chat may be another client, never sovereign identity.
C. Console is a Human Boundaries UI: public ontology, Rules/Authority, History/Ω, responsibility, conflicts and diagnostics, with actor-gated reviewed mutations. It never becomes a decision-making Node.
D. Operation/Backend: single owned Core/Gateway lifecycle, truthful health/Presence/return, stable recovered state, real Host handshake and end-to-end task evidence. Do not restart live production or modify Basic Rules, model sign-in or credentials as part of UI refactor.

## Visual direction explicitly chosen by Human
Professional Windows desktop productivity/control software; quiet utilitarian styling, not "AI aesthetic".
- Information architecture: narrow tool/navigation rail; compact title/tool strip; structured work list, details, status tables/timeline and diagnostics; Console discoverable but not splash/default home. Chat uses conversation-list + substantive message transcript + composer when authorized.
- Matte off-white/neutral grays, deep charcoal text, single conservative **blue-gray** emphasis (use #355e78 or similar). Semantic error/warning only where necessary. Flat surfaces with clear 1px borders, modest radius <= 6px (dialogs <= 8px), no hovering soft-card grid, no giant pill-shaped composer, no glass/backdrop blur, no neon, no lavender/purple AI gradient, no playful floating assistant avatar, no glow/pulse/hero marketing.
- Functional typography: Segoe UI / Microsoft YaHei and system fallback, 13-14px body, measured compact spacing, accurate readable contrast, tabular data alignment; keyboard focus visible, no forced animation, respect reduced motion.
- Responsive Windows 1024x768, 1280x850, 1440x900; no horizontal overflow or hidden critical controls. Default Chinese, English switch retained. Show authentic status, timestamp/freshness, blockers; never fake progress percentage or online badges.
- Graphical controls replace ordinary CLI. Developer/Recovery details remain under Advanced.

## Work plan and hard evidence
P1: bounded desktop/UI correction based on existing layout, preserve all Human admin operations, introduce distinct useful Communication surface only if backed by real canonical data. Run UI typecheck/build/smoke, backend tests, screenshot/layout review at three widths. Compare a frozen existing screenshot with the new one. Keep limitations explicit.
P2: canonical Communication + external client first live path; authenticate already registered Human Chief + Codex, execute and verify one exact task from ChatGPT through Sidera to Operator and result back, or report the precise external blocker. No Human prompt-courier workaround.
P3: release candidate: isolated clean-start and crash/restart integrity, three cold starts, live error/fault behavior, long-running observation >=24h before production stable signoff; versioned migration and rollback; build portable/installer without shipping secrets or .sidera-dev.
Allowed labels: FIXED / ACCEPTED_LIMITATION / HUMAN_REQUIRED / UNRESOLVED, each tied to original evidence. No G3 or production PASS with material unresolved problems. Avoid new vendors/fake agents or secondary state stores. Take incremental local Git commits; retain previous G2 frozen checkout.

## Immediate instruction to implementer
Implement P1 first. Prefer modifying existing ProductApp, Console, product.css; do NOT rewrite Core/ontology/rules to suit visual style. If a true Chat input lacks canonical backend authority, build a truthful navigation/read-only Communication surface first, explicit unavailable composer; document missing transport and follow up P2 in the next bounded implementation pass. Don't label that read-only shell as finished Chat.

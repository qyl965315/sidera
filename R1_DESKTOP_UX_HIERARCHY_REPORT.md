# Sidera Desktop UX Hierarchy Review

Date: 2026-10-06
Verdict: **UX_HIERARCHY_READY_WITH_LIMITS**
Publication: **Unpublished. No GitHub push, release, or upload performed.**

The desktop now opens a Work surface rather than a Home dashboard. Its primary object is a goal with progress, outputs, participants, attention, and a bottom instruction composer. Secondary functions sit behind a narrow icon rail. This is a local Windows UX candidate, with the functional and evidence limits below.

## Implemented hierarchy

- The permanent rail is 64 CSS pixels wide and contains Work, Nodes, Integrations, Status, and Settings. Each icon has an accessible name and tooltip. Home and Permissions are absent from the primary navigation.
- Work has a secondary pane containing New Work, Pinned, and Recent. The pane is 232 pixels wide, or 212 at the smaller desktop breakpoint. It can be hidden and reopened. Pinning and pane preferences persist locally.
- Startup after setup restores the last visible Work when available, otherwise the newest canonical task, otherwise the empty composer. Canonical inspection supplies tasks in descending creation order. Fresh profiles still enter the required setup guide; that guide ends in Work.
- The empty surface asks “想让 Sidera 完成什么？” above a large text input and one primary “开始” action. Save goal and revise saved goal are secondary options. Identity is implicit for a single local Human and appears as a selector only when multiple Humans exist.
- A selected Work presents title/goal and one state indicator, progress and compact participants, outputs, relevant blockers, and a bottom composer. Exact task/run/effect evidence stays in collapsed Advanced details. The input preserves literal wording.
- The Integrations card wall is replaced by a compact product list and one selected detail surface. One obvious action opens a focused configuration dialog. Product recognition uses existing letter marks; no decorative assets were fetched.
- Nodes retain compact rows with Open chat, Detect again, and Settings. Raw IDs, actor/session details, and technical restrictions are collapsed into Advanced details.
- Settings contains General, Security/Permissions, Updates, Data/Diagnostics, and Advanced. Security provides the existing reviewed permissions flow. The compatibility `/permissions` route remains reachable there.
- Status retains focused health, runtime controls, attention, and service rows. Exact records and diagnosis are collapsed. It is a secondary destination rather than the default canvas.
- Neutral surfaces, typography, spacing, and separators establish hierarchy. Status chips use one monochrome treatment. A restrained green accent identifies primary actions. Warning/success/error copy no longer introduces multiple text colors.

## Work instruction behavior and authority

`core/local-setup.ts` now exposes a read-only `taskIntentLinks` projection: same-world `task_bases` joined to the exact originating `intent_revisions`. The UI resolves that stable intent to its current revision owned by the selected Human. It does not guess from a similar title, goal text, or the first stored intent.

For linked work, the bottom composer appends the literal follow-up wording to the current saved goal and invokes the existing `intent-revise-review` / `confirm` flow with the exact parent revision. Review and native confirmation gates remain intact. Duplicate activation is locked, including cancelled or uncertain submission, until an intentional navigation starts a new input context. For legacy work without a recorded link, an explicit compact saved-goal selector is required.

**Limit:** This backend operation revises a saved intent. It does not dispatch a new turn to a running Node, automatically continue execution, or claim that an Agent has consumed the new instruction. The UI therefore labels the action “更新目标”. No new continuation backend was invented during this UI revision.

Progress is the current canonical progress/next-step projection, and participants are recorded assignments. Outputs use available records. This candidate does not invent a percentage, event timeline, delivered result body, or active Host state when the backend has not supplied it. Detailed run history remains available under Advanced.

## Visual acceptance

Evidence directory: `desktop-evidence/hierarchy/`.

The final Electron source build generated 18 screenshots, covering each of the six required surfaces at the requested CSS viewport sizes. Windows DPI scaling means PNG raster dimensions may be larger than the CSS viewport dimensions.

| Surface | 1024×768 | 1280×850 | 1440×900 |
| --- | --- | --- | --- |
| Empty Work | empty-work-1024x768.png | empty-work-1280x850.png | empty-work-1440x900.png |
| Active Work, pane expanded | active-expanded-1024x768.png | active-expanded-1280x850.png | active-expanded-1440x900.png |
| Active Work, pane collapsed | active-collapsed-1024x768.png | active-collapsed-1280x850.png | active-collapsed-1440x900.png |
| Nodes | nodes-1024x768.png | nodes-1280x850.png | nodes-1440x900.png |
| Integrations | integrations-1024x768.png | integrations-1280x850.png | integrations-1440x900.png |
| Settings | settings-1024x768.png | settings-1280x850.png | settings-1440x900.png |

All 18 were inspected in the contact sheet. Empty Work and the constrained-width active/utility surfaces were also opened individually at larger resolution. The review found the Work title and input dominant, subordinate navigation, a visibly wider canvas with the pane hidden, no dashboard/card-wall or first-field identity form impression, clean normal Chinese labels, and no multicolor status text. Automated checks found no horizontal overflow at any required viewport and no renderer errors.

The screenshots use explicitly intercepted, read-only layout fixtures. They are **visual acceptance evidence, not proof of real model execution or result delivery**. Production contains no fixture switch. `visual.json` records this boundary. Packaged smoke separately exercises real local endpoints with an isolated profile and synthetic native approval responses.

![All required visual states](desktop-evidence/hierarchy/contact-sheet.jpg)

## Validation

| Check | Result | Evidence |
| --- | --- | --- |
| Backend TypeScript | PASS | `npm.cmd run check` |
| Unchanged backend test suite | **266/266 PASS** | `desktop-evidence/hierarchy/backend-tests-elevated.txt` |
| Unchanged desktop test suite | **13/13 PASS** | `desktop-evidence/hierarchy/desktop-tests.txt` |
| UI typecheck + production build | PASS | `npm.cmd --prefix ui run build` |
| UX behavioral smoke | PASS | `desktop-evidence/ux-localization.json`; `ui/scripts/ux-smoke.mjs` |
| Localization AST coverage | PASS; **369 paired literal calls, 54 dictionary keys** | `desktop-evidence/ux-localization-coverage.json` |
| Electron visual smoke | PASS; 18 screenshots, no overflow/errors | `desktop-evidence/hierarchy/visual.json` |
| New packaged candidate smoke | PASS | `desktop-evidence/hierarchy/packaged/packaged-smoke.json` |
| Initial package privacy scan | PASS; zero findings | Candidate manifest |

The UI smoke retains the six-step setup, typed review gate, seven service dialogs, zh/en navigation, default-view technical-disclosure checks, exact Advanced evidence, denied/empty/unavailable read boundaries, and one-shot uncertain intent lock. It now also checks pane hide/reopen, pin persistence, and exact linked follow-up intent, parent revision, and literal content. Assertions for the retired dashboard/card navigation were updated to the new hierarchy; backend and desktop test files were not altered.

Ordinary surfaces are checked against UUIDs, PowerShell, canonical operations, and implementation terms. Advanced still exposes exact IDs and records. Human-authored names/goals/outputs remain literal. Canonical permission approval statements remain exact. Startup before the product UI loads remains Chinese; persisted English applies when the UI loads.

The first restricted Electron attempt failed because Windows sandbox ACLs denied the Electron AppContainer access. The visual and packaged checks succeeded under normal Windows execution without disabling Electron sandboxing or modifying ACLs. The restricted backend run was interrupted after the complete normally executed suite passed; its partial log is retained and is not counted as a pass.

## CLI-to-control reachability

See `UI_ACTION_MAP.md` for the full preserved mapping.

| Ordinary semantics | GUI route/control |
| --- | --- |
| admit / identity | Setup → Confirm identity; Settings → General → Add identity; exact reviewed act confirmation |
| provision | Settings → Security/Permissions → Manage permissions → Apply approved permissions |
| config-check | Status → Check configuration |
| start / stop | Status → Start Sidera / Stop Sidera |
| add/configure service | Integrations → select product → Set up service → focused dialog |
| bind / handoff | Nodes → Settings → Connect / Switch main chat → reviewed dialog |
| health | Nodes / Integrations / Status → Detect again; MCP dialog → Check connection |
| add MCP | Integrations → MCP → Set up service → Add MCP |
| enable / disable | MCP service dialog → switch |
| reconcile | Status → Resolve issue → sourced reviewed reconciliation |
| update | Settings → Updates → Check updates / Download and verify / Stop and install |
| save / submit / revise intent | Work composer → Start; More options → Save goal; selected Work → Update goal |

No ordinary route requires entering PowerShell. Unsupported installation or session replacement remains explicitly blocked under the owning product/Node authority rather than represented as an available action.

## Packaged candidate and limits

Candidate: `candidates/desktop-ux-hierarchy-20261006/portable/`.
Entry point: `Sidera.exe`. Keep all adjacent resources. This is an unsigned Windows x64 portable candidate, not a new installer release.

The candidate was packaged only after visual review. Packaged smoke copied it to a fresh temporary application directory, restricted PATH to Windows system tools, and created an isolated data profile. It verified bundled Core startup, stopped-Core setup availability, renderer isolation, native confirmation denial, no renderer secrets, exact chat-open interception, active-turn exit/update refusal, preserved Core ownership, graceful stop, and restart recovery into Work. There were no UI errors.

Remaining limits:

1. Same Windows machine, not a clean VM/fresh OS. No installer execution or publisher signing is certified.
2. Third-party authentication, live model cooperation, actual external navigation, and result return are not certified. FULL_ROUTE_READY remained false in the packaged test.
3. Native approval responses, an open turn, and updater downloads were explicit synthetic test-driver fixtures. They do not constitute Human approval, real Agent execution, or a public updater feed.
4. GLM/DSH installation remains the prior owning-product limitation. The UI exposes the truthful blocked path and exact Advanced evidence.
5. Work follow-up revises the saved goal; autonomous execution of that revision requires a separately supported backend continuation path.
6. Canonical read projection has limited progress/result-body detail. The Work surface preserves that uncertainty rather than displaying invented history.

These limits support **UX_HIERARCHY_READY_WITH_LIMITS**, not an unrestricted external end-to-end or release verdict. No GitHub publication occurred.

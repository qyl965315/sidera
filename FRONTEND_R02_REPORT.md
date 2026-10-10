# Sidera frontend R0.2 report

Date: 2026-10-05. Scope: frontend and local read integration only. No backend source changed; no mutation enabled; no R2 multi-session semantics introduced.

## Result and current acceptance boundary

R0.2 implements a real R1 read path and an editorial visual system while preserving the accepted project/task-first architecture, Chinese default, persistent English switch, Attention, parallel demo groups and Advanced/System.

The currently running backend was successfully read at 12:05 UTC and again at 12:09:53 UTC: 63 project projections, 84 Tasks, 10 Nodes, `truncated=false`. Core `runtime.status` returned `ready=true`; Gateway `/healthz` returned HTTP 200. These are independent read/transport observations, never task-completion evidence.

During final verification the configured Core 8765 and Gateway 8787 no longer had listeners. Final live smoke correctly failed its availability assertion and the adapter returned `R1_READ_UNAVAILABLE` with empty live collections. We did not restart backend, replay work, retry transport automatically, or replace unavailable live data with demo content. Initial live PASS is historical evidence, not a claim of present availability.

Interactive computer-use could not be performed: inventory returned zero browsers, and opening iab returned `Browser is not available: iab`. Automated real Chromium validation succeeded before backend became unavailable. Native browser 125%/200% zoom remains unverified; CSS zoom validation is explicitly identified below.

## Read integration and security boundary

`ui/src/data/backendAdapter.ts` remains the only UI data seam. Default mode is live. Explicit demo mode is available through the footer selector or `?mode=demo`. Existing normal/empty/denied/error/loading preview scenarios remain demo-only.

`ui/integration/live.mjs` installs a server-side Vite dev/preview endpoint, GET `/api/r1/snapshot`. It opens bounded loopback JSONL RPC connections and allows only `world.inspect` and `runtime.status`. Gateway `/healthz` is an independent unauthenticated transport read. Request bodies cannot select methods, credentials, Node or ports. Non-GET receives 405; non-loopback Host and cross-origin requests receive 403. Responses use no-store. There is no polling/retry/replay; the browser's one-second freshness display only updates local elapsed time.

Credentials come from the existing local runtime-spec server-side and are never bundled or returned. No SQLite imports, backend imports, config responses, raw result bodies, logs or Host locators enter React. Projection is an allowlist. Known runtime credentials and common bearer/key text patterns are redacted from the serialized projection. This is not a general-purpose DLP engine for arbitrary backend prose.

Configuration, server-side only:
- `SIDERA_RUNTIME_SPEC`: default `D:/CodexProjects/Sidera/.sidera-dev/sol/data/runtime-spec.json`.
- `SIDERA_READER_NODE`: default existing configured Chief Node. Its existing participant permissions apply; this does not grant Human-wide access.
- `SIDERA_WORLD_ID`: optional explicit authorized world.

Run from `ui`: `npm run dev -- --port 4176 --strictPort`. `npm run preview` also installs the local integration middleware. A static dist-only host cannot supply live reads without this integration server; it must not be represented as a standalone live deployment. Current local development address: http://127.0.0.1:4176/.

## Live fields and limitations

| UI field | Authoritative read / rule | Limitation |
| --- | --- | --- |
| Project ID, title, scope, state | visible Responsibility; `responsibility:<id>` | Projection, not a new backend Project object; Responsibility state and child counts are independent |
| Project Task membership | exact Task provenance responsibilityId | Never grouped by title, Node, scope similarity or presumed lineage |
| Standalone project | `task:<taskId>`, one Task | Missing/invisible Responsibility produces a standalone work item, not guessed membership |
| Task title | canonical Task ID | R1 inspection has no task display title; no generated title from message body |
| Task goal, next step | linked visible Supervision goal / nextAction; otherwise run execution state or unknown | Some goals are unknown because Supervision is Supervisor-visible |
| Task state | canonical Task state; working also requires authoritativeRunning | Host acceptance alone never maps to completed; unknown state maps to uncertain |
| Progress | state-only | No invented percentage or denominator |
| Assignment | executingNodeId / workerNodeIds | Per-assignee runtime state unknown; live assignments display uncertain. Worker lists do not prove concurrency, so live parallel is false. Explicit demo parallel groups preserved |
| Result | finalResult message ID and deliveryState, only if taskCompleted | Task completion and result delivery remain independent. No raw body displayed |
| Run / dependency | runId, sessionId, turnOpen, checkpointOutcome, parentRunId, childTaskId | Session is the R1 pinned identity; array sequence is display order, not a new canonical round |
| Node | canonical Node ID/display name and Session records | ModelBinding/Host ID/locator absent from inspection are unknown/unavailable, not inferred from adapter or model names |
| Node health | last recorded Session health state / observedAt / meaning | Historical Host observation, not present live Presence or current execution |
| Core / Gateway health | authenticated world.inspect, runtime.status.ready; HTTP healthz status | Transport readiness is not task outcome or dispatch Authority |
| Attention | projected uncertain/error Tasks | Error details/review not supplied by inspection remain unavailable |
| Error code | `R1_TASK_<STATE>` | Stable UI-derived code from canonical Task state, not an invented backend exception code; category canonical-task-state. Independent review remains unknown |
| Read failure code | `R1_READ_<CODE>` | Backend code retained as category; timeout/closed read is uncertain; denied and unavailable distinguished |
| Events | canonical recentProgress event metadata | No invented effect attestation; payload omitted |
| Effects/resources/connections/tension | unavailable | Additional canonical surfaces not integrated. System explicitly explains absent evidence; empty collections do not certify absence |

All counts are caller-visible and may be truncated at 200 records per collection. The UI shows scope and TRUNCATED when supplied. Unknown and denied are not completion. Reads are point-in-time, not atomic cross-surface snapshots. Freshness age is read-request age; after 60 seconds it is visibly STALE. Source freshness of Node health remains its own observedAt timestamp.

## Visual direction

A working journal: warm olive-black ink, parchment text, a restrained apricot accent, serif identity and italic project folio numbers. Large heading typography, ruled separators, staggered project blocks and asymmetric detail columns introduce composition and rhythm. Status colors remain restrained and carry text labels. No stock art or 3D assets.

Long canonical IDs wrap; mobile layout stacks task information, detail columns and monitoring rows. Focus outlines, skip link, semantic navigation, language controls, disabled controls and reduced-motion support remain. Motion is limited to subtle page entrance and hover transitions. This is visual/browser QA, not a formal accessibility certification.

## Control / monitoring

Monitoring remains primary. Task detail includes disabled intent/reconciliation affordances with a clear Authority / Effect / no-replay freeze explanation. They have no event handlers and call no backend method. Dispatch, revise, cancel, grant, reconcile and replay remain blocked. No operation names are proposed as frozen backend mutations.

System shows Core read evidence, independent Gateway transport evidence and Node historical Session evidence, with exact timestamps. Advanced views retain canonical IDs and run/dependency correlations.

## Validation evidence

- `npm run build` in ui: PASS, TypeScript and Vite production bundle (final build).
- `npm run test:smoke` in ui: PASS, accepted R0.1 behavioral coverage retained, including persistent bilingual switch, all routes, parallel demo group, uncertainty/no-replay, independent effect fixture evidence and preview failures.
- `node ui/scripts/live-smoke.mjs --projection-only`: PASS, local fixtures validate exact membership, standalone boundary, Host acceptance not completion, unknown assignment concurrency, independent result delivery, and read-only method allowlist. This is not live evidence.
- `npm run test:live`: initial real R1 PASS at 12:09:53 UTC; final run FAIL because backend unavailable. The test intentionally fails when live state cannot be read.
- `node capture-r02.cjs`: automated installed Chromium PASS against real live projection before final outage. Four routes at 1440 × 1000, CSS zoom 100%/125%/200%, no horizontal overflow, no pageerrors, disabled task controls, bilingual persistence and 720px layout.
- `evidence/frontend-r02/browser-check.json`: exact automated QA metadata, including explicit native zoom/interactive limitations.
- `home-1440.png`, `project-1440.png`, `task-1440.png`, `system-1440.png`: real live captures. `demo-home-1440.png` is explicitly demo. Additional `*-zoom-1.25.png` and `*-zoom-2.png` show CSS zoom.
- Home/task screenshots visually inspected. Final System enhancement adds activity Session health rows; live recapture was blocked by the backend outage, so existing System screenshot predates that final enhancement.

Remaining gates: restore external backend availability for final live rerun; interactive native browser zoom QA; Human visual acceptance; any future mutation freeze with canonical Authority/Effect/no-replay semantics. No deployment/publication performed.

# Sidera R1 G3 Product P1 Result

Date: 2026-10-10

Scope: isolated G3 checkout only. Baseline is `efe1ace` (accepted G2). No production directory, live service, credential, Node identity, Rule, Grant, Effect, or deployment was changed.

Verdict: **P1 source implementation verified; G3 Product is not passed.** The remaining items below are deliberately retained as `UNRESOLVED` or `ACCEPTED_LIMITATION`; this result is not a P2 bilateral integration, release, or production signoff.

## Changes

### FIXED — Work-first desktop frame and professional utilitarian visual system

- Work remains the default and dominant surface, with the existing project/task chronology, outputs, attention, exact advanced evidence, recent/pinned work pane, and guarded intent actions preserved.
- The permanent navigation rail now has a distinct Communication destination while keeping Nodes, Integrations, Status, and Settings subordinate. The graphical Console remains reachable at Status and is still the Human Boundaries view rather than a Node.
- `ui/src/product.css` now uses compact Windows-oriented layout, matte neutral surfaces, blue-gray `#355e78` emphasis, 1px borders, small radii, status tables and rows. It removes the prior rounded soft-composer treatment, shadows, blur and glow. The product mark is a restrained CSS monogram rather than a decorative asset.
- Responsive layout rules retain the 1024px-wide desktop floor and avoid horizontal expansion in the existing visual smoke assertions.

### FIXED — Dedicated canonical read-only Communication surface

- `/communication` is a separate Communication workspace, not an alias for Work or Console.
- It reads only data already exposed to the desktop: the authenticated canonical snapshot freshness/read status and the Console's public Shared History projection. It displays the real, currently projected Chief Conversation relationship count plus recorded `Conversation`, `Discussion`, `Thread`, and `Messaging` entries.
- It does not invent a transcript. Shared History intentionally carries public provenance/references rather than message bodies, and the UI explicitly tells the Human that bodies are not present in this projection.
- The composer and Send button are disabled. The normal UI and Advanced explanation both name the precise integration gap: the current desktop API does not expose a typed Conversation send/receive operation that proves a Human identity, current Authority, exact conversation binding, auditable transport, durable correlation, and result/receipt semantics together.
- The UI smoke now supplies an explicit canonical-read fixture and verifies all four semantic tabs, the recorded-row view, and that both composer and Send are disabled.

### FIXED — renderer and local evidence verification defects discovered by P1 gates

- `ui/index.html` and `ui/tsconfig.json` establish the missing Vite renderer entry and explicit automatic JSX configuration. The requested production build can now compile this isolated checkout.
- The launcher returns a valid minimal PNG only as a static fallback for the existing `/sidera.png` contract when no packaged image exists. The visible UI does not rely on it; it uses the CSS monogram. This restores the existing native-boundary static-resource assertion without changing any authority or transport path.
- Generator-owned evidence files were regenerated from the deterministic local fixture to remove CRLF-only drift. `evidence:check` now passes.

## Acceptance evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| UI typecheck | PASS | `npm.cmd --prefix ui run typecheck` |
| UI behavioral smoke | PASS | `npm.cmd --prefix ui run test:smoke` — read-only Communication, four forms, disabled Send, existing safety checks |
| UI production build | PASS | `npm.cmd --prefix ui run build` |
| Backend typecheck | PASS | `npm.cmd run check` |
| Backend suite | PASS | `npm.cmd test -- --test-concurrency=2` — 381 passing tests |
| Evidence gate | PASS | `npm.cmd run evidence:check` |
| Source hygiene | PASS | `git diff --check` after staged scope review |

## Remaining G3 blockers

### UNRESOLVED — P1 visual review and frozen screenshot comparison

The required Electron visual script, `node desktop/hierarchy-visual.mjs`, cannot launch in this isolated checkout. The exact missing prerequisite is `desktop/node_modules/electron/dist/electron.exe`; the script exits with Playwright `Process failed to launch` before a window or screenshot exists. No Electron dependency was installed because this bounded P1 explicitly avoids adding dependencies.

The G2 UX report references frozen screenshots under `desktop-evidence/hierarchy/`, but those files are absent from this isolated checkout and are not tracked in baseline `efe1ace`. Therefore no truthful pixel/screenshot comparison could be performed. The script was updated so that, once Electron is supplied, it will capture the new Communication surface at 1024x768, 1280x850, and 1440x900 together with the existing Work and utility surfaces, assert no horizontal overflow, assert no normal-surface technical leakage, and assert the disabled composer/Send controls.

### ACCEPTED_LIMITATION — no integrated Chat send/receive path

P1 intentionally does not add a transport or synthesize replies. The current public reads provide canonical state and public communication provenance, but not message bodies. The setup endpoints also do not constitute a Conversation transport. P2 must provide and validate a legitimate typed path with authenticated Human ingress, exact Conversation binding, current Authority, controlled final send, durable correlation, receive/result evidence, and no-replay reconciliation before the composer can be enabled.

### HUMAN_REQUIRED / UNRESOLVED — P2 and P3 gates

- P2 requires the registered Human Chief and Codex external client path, real login/authority, one exact bilateral task, and observed return to the originating conversation. None was attempted or claimed here.
- P3 still requires the isolated clean-start/crash/restart and 24-hour observation work, rollback/package validation, and separate release decision.

No label in this report means Human approval, external delivery, model execution, exact Chat presence, or production readiness unless that event has its own canonical evidence.

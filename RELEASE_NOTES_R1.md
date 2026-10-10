# Sidera R1 — v0.1.0

Release date: 2026-10-05

Sidera R1 is the first end-to-end release candidate of the local multi-Node runtime and Human-facing workbench.

## What is in R1

- Stable Node identity separated from model, Host, Session, Task and Run.
- Responsibility, Task, Run, Supervision and event-driven WAIT/resume lifecycle.
- Exact Session routing and explicit Session handoff.
- Authority/Grant checks before side effects.
- Explicit Effect knowledge, including preserved `uncertain` outcomes and no blind replay.
- Durable resource/artifact handoff.
- Unified MCP Gateway with a small stable surface and canonical operation registry.
- OAuth support for remote MCP edges.
- Host adapters for Codex, DSH, Grok Build, Antigravity/Gemini Agent and ZCode/GLM paths.
- Read-only retained-result retrieval for an authorized Chief interaction when direct presentation is unavailable.
- Chinese-first, bilingual Human frontend organized around Project -> Task -> assigned Node(s).
- Live read-only projection of R1 Core/Gateway state into the frontend.
- System monitoring for Core/Gateway/Node evidence and freshness.

## Release truth

Backend closure result: **PASS-WITH-EXPLICIT-LIMIT**.

Validated before packaging:

- TypeScript check: PASS.
- Full backend test suite: 243/243 PASS.
- Chief focused tests: 6/6 PASS.
- Canonical per-Node MCP principal verification: 9/9 PASS through cold recovery.
- Frontend build: PASS.
- Frontend smoke test: PASS.
- Frontend live projection: PASS against the local R1 runtime.
- No uncertain provider Effect was replayed during release closure.

## Explicit R1 limits

### GLM / ZCode

R1 does not promise reliable provider completion for the GLM/ZCode Host path. Historical uncertain provider effects remain preserved as UNKNOWN where exact application cannot be proven. Scheduling state may be reconciled separately without rewriting provider-effect truth.

### Exact current ChatGPT Conversation return

The detached Core does not claim a verified proactive machine push into the exact current external ChatGPT Conversation when no authenticated native executor route is available.

R1 instead preserves the result durably. A later authorized interaction from the bound/current Chat can retrieve retained root results through the supported read surface. This is not recorded as delivery or Human observation until those events actually occur.

### Frontend controls

The R1 frontend is live for monitoring and read projection. Mutation controls remain disabled until each operation can preserve the same Authority, Effect and no-replay guarantees as the backend.

## Local start

Requirements:

- Windows 11 x64
- Node.js 24+

Backend:

```powershell
npm ci
npm run check
npm test
npm run dev
```

Frontend, in another terminal:

```powershell
cd ui
npm ci
npm run dev -- --port 4176 --strictPort
```

Then open:

`http://127.0.0.1:4176/`

A clean checkout does not contain private Host accounts, credentials, runtime databases, exact Human Chat binding, or admitted external identities. These remain local and must be provisioned through the supported Human/Host onboarding paths.

## Security / data boundary

- `.sidera-dev/`, local SQLite files, credentials and runtime logs are not release artifacts.
- Browser automation is validation tooling only, never production Presence or recovery infrastructure.
- Connected transport is not Authority.
- Host acceptance is not Task completion.
- Delivery is not Human observation.
- `uncertain` is not `failed` and is never an automatic retry instruction.

## Next

R1 is frozen as the baseline. New ontology work — including the broader multi-Session / multi-Host subject model — belongs to R2 and does not retroactively redefine R1.

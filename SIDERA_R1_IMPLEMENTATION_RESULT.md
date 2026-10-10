# Sidera R1 Constitutional Refactor — implementation result

Date: 2026-10-08 (Asia/Shanghai). Workspace: `D:\Sidera-R1-v0.1.0`.

**Implementation and local data migration delivered; final Human acceptance pending.** Human requested fewer tests and explicitly took over final checking. No additional verification runs were started after that instruction. The already-running final suites had completed when they were collected. No package, installer or release was produced.

## Source identity and recovery

This source distribution is not a Git checkout. Commit/HEAD is **not available**, not fabricated.

- Source checkpoint: `D:\Sidera-R1-checkpoints\constitutional-20261007\source-before.zip`
- SHA-256: `57471C1C4FF40FC4EDA144DC53B8207F090943EFEBCD1F1D49372B18C1258E50`
- Checkpoint excludes runtime credentials and live database/private regions.
- Implemented runtime source digest: `23c9c38a305cc9ed0f2899e31350120d7f4340eb92ad3673075798c4f9b3bb9b`.
- Machine evidence: `evidence/r1-constitutional-validation.json` and `evidence/r1-constitutional-static-audit.json`.

## Implemented changes

| Area | Actual implementation and connection |
|---|---|
| Ontology / Chief | `core/ontology.ts`; Project → Chief Conversation → Communicator; existing physical NodeRef and binding retained. Operator Agent/Bot classification is independent from Host. Compatibility `chiefNodeId` names refer to the role-owning Communicator. |
| Executors | `core/executors.ts`, Scheduler, Runtime, Continuations, Activation and Effect gate share exact admitted context selection. Reuse idle; no-idle needs completed Chief review. Additional assignments require Rules. Context exhaustion makes that Executor unavailable. |
| Sovereignty | `core/sovereignty-store.ts` and `core/subjectivity.ts`; private per-Node `current.json`, atomic whole D/E replace, revision CAS, private receipt reconciliation. Source/Peregrine APIs cannot read another Node's region through path aliases. |
| Shared History / Ω | `core/history.ts`; immutable typed append records, deterministic reducer, real INSERT/UPDATE/DELETE adapters, monotonic order, explicit local conflicts, exact completed-Task resolution with Authority. Claim has no Delta. |
| Rules | `core/rules.ts`; immutable proposals, object hashes, current-version projection, nested boundaries and real completed review provenance. World adoption is Human-only; Project requires Machine + Human; Task requires issuer + Chief Conversation. |
| Authority | `core/authority.ts`; parent-linked Derived Grants, transitive limits, ancestor revoke/expiry, inherited budget and constraints, Model/World/Project/Task dimensions. Rules can supply exact standing Authority. No global depth cap. Selected disclosure Grants also check their ancestry. |
| Responsibility | `core/consequences.ts`; history/lineage/rules-at-action provenance; named, reviewed adopted-rule Consequence changes Authority locally. No default punishment. |
| Capability | `core/capability-truth.ts`; available/unavailable, independent CURRENT/UNKNOWN/STALE knowledge. Actual adapter observation updates C; pure Authority denial preserves C. Declared support alone is not availability. |
| Console / MCP | Console exposes public ontology/history/Ω/conflicts/grants/responsibility and Rules proposals. Exact Rules confirmation reuses native Human admission. Canonical MCP exposes typed operations and read-only review-object preparation, never arbitrary Δ setters. |

### Integration defects fixed during implementation

- Active-only guards rejected explicitly admitted parallel Executors. Exact admitted contexts now flow through dispatch, receive, continuation and final result.
- Open standalone turns appeared idle. Pool occupancy now includes canonical standalone Effect state.
- Project/Task-limited Grants lost context before and at the final Effect gate. Context now derives from the canonical source Message and Task; target execution uses its own parent Task when continuing.
- A separate valid message Grant could conceal revoked disclosure ancestry. The chosen disclosure Grant now checks its entire active parent chain.
- Equivalent same-base History revisions could create a false conflict on the next update. The reducer now preserves equivalent revision aliases.
- Generic machine review previously risked accepting an unrelated completed Task. Rules, Consequence and conflict closure bind the original command, exact object hash, completed Run and canonical result.

## Local migration performed

Used the existing Core owner graceful-stop interface, then `node scripts/constitutional-migrate.ts --apply` with Core stopped. The migration includes its own data-preservation assertions; this was not a new provider/E2E test. A source runtime restart was requested through `core/launch.ts` in a hidden process. Following Human's instruction, no further runtime health or E2E checks were added.

- Preserved: **2 Nodes, 0 Tasks, 0 Runs, 1 Grant, 0 Messages**.
- Both private D/E documents preserved; legacy current SQL D/E cleared only after fsynced file verification.
- Additive History migration: 9 records, 8 Ω targets at the migration boundary.
- Database integrity and migration reopen idempotency passed inside the migration command.
- No Task, Grant, provider inference or browser launch created by the migration.
- Exact active binding retained:
  - binding: `cf6b0d22-e4ec-41e1-8ad1-5176fc0f0cf3`
  - Project: `local-project`
  - Communicator: `ba3cb7ac-b601-4706-920d-d540960c3b4f`
  - Conversation: `https://chatgpt.com/c/6ac50f7f-4a6c-83ee-81ad-1e359d31c4b9`

Private canonical path: `.sidera-dev/sol/data/sidera.sqlite.sovereignty/<NodeRef>/current.json`. Legacy identifiers unsafe as directory names use a stable hashed directory segment. SQL stores metadata and locking only. Old archived artifacts are not new canonical stores.

## Validation already completed

These runs started before Human's final instruction to stop further checking. All observations below concern this source and isolated fixtures; they are not external Host E2E claims.

| Command | Recorded result |
|---|---|
| `npm run check` | PASS |
| `npm test` | **329/329 PASS**, no skipped or cancelled tests |
| `npm run desktop:test` | **16/16 PASS** |
| `npm --prefix ui run build` | PASS |
| `npm --prefix ui run test:smoke` | PASS; includes Console Rules preview without adoption |
| `npm run evidence:check` | PASS; generated fixture documentation matches |
| `node scripts/audit-constitution.ts` | 7 bounded static checks PASS |

Logs are under `D:\Sidera-R1-checkpoints\constitutional-20261007`: `check-final.log`, `core-tests-final.log`, `desktop-tests-final.log`, `ui-build-final.log`, `ui-smoke-final.log`, `evidence-final.log`.

New focused tests cover Sovereignty migration/CAS/private access, History replay/conflict/Claim, parent Grant derivation/revocation, Rules/Human adoption, Chief/Executor selection, Console and Capability. The routing tests exercise actual loopback Core RPC → Authority → Effect → isolated adapter → reverse delegation → WAIT → event continuation → original Session return. They do not use production providers or browser automation.

## Final 15-question audit

| # | Answer from implementation and recorded evidence |
|---|---|
| 1 | Chief is a canonical **Conversation role**. Old field names and historical reports remain compatibility data, not a new Node type. |
| 2 | No semantic cross-Node D/E API is exposed; RPC target selectors and private-region filesystem broker paths are rejected. This is an application boundary, not OS isolation from the machine owner. |
| 3 | D/E are canonical in the per-Node local `current.json` region above. |
| 4 | A stale Executor revision is rejected by CAS; whole D/E update is atomic. |
| 5 | Claim cannot carry ΔΩ or alter Ω. |
| 6 | Ω is rebuilt by deterministic reduction of canonical Shared History; no independent cache truth is required. |
| 7 | Incompatible same-base candidates stay locally UNRESOLVED; unrelated targets continue. |
| 8 | Child Grants must narrow the complete parent chain. |
| 9 | Ancestor revoke/expiry blocks descendants, including selected disclosure grants and existing reservations. |
| 10 | Task Rules cannot widen the currently applicable Project/World boundaries. |
| 11 | C remains visible and can stay available while A denies an action. |
| 12 | Yes: an adopted named Project rule plus exact completed review produces a Consequence Effect and real scoped Authority restriction. |
| 13 | Basic constants add no honesty, provider-diversity, review topology, punishment or scheduler policy. R1 review requirements live in explicit institutional governance. |
| 14 | No autonomous rule evolution / cellular automaton behavior was implemented. |
| 15 | All six required suites listed above completed green. Final product acceptance is now reserved to Human. |

## Explicit remaining boundaries

1. **External production E2E is NOT RUN in this refactor.** Current Host login, tunnel health, exact live Chat Presence and final Human delivery are not implied by isolated tests or a preserved binding. No `/readyz` or external model re-test was performed after the final Human direction.
2. For registered operational index targets such as `grants/*` and `operator_executors/*`, generic conflict selection is deliberately unavailable. The owning adapter must reconcile actual state; arbitrary candidate selection would split Ω from the effective authorization/execution index. Universal automatic recovery for these targets is not implemented.
3. Opening a new provider context remains the owning Host adapter's operation. A Chief's `open` decision does not fabricate a context; admission needs the actual registered locator and non-browser verification. Adapters requiring fresh context on each wake block an unreviewed replacement.
4. Existing projects lacking adopted constitutional Rules retain an explicit `legacy-unadopted` compatibility context. Migration does not invent Human approval, standing Authority or new Grants.
5. Source changes are not in the old installer candidate. No packaging, publishing, purchase or credential migration was performed. The workspace has no Git commit to report.

## Independent DSH review + revision (one shot)

A later independent review reproduced four findings against this source and live
runtime and fixed them in place. Full evidence, classification and the remaining
blockers are in `SIDERA_R1_DSH_REVIEW_REVISION_RESULT.md`.

| Finding | Change |
|---|---|
| P0-A Gateway operation registry was built from a duplicated `STABLE_OPERATION_GROUPS`/`GATEWAY_OPERATIONS` list, so Core `history.list`, `omega.inspect`, `rules.*`, `executor.*`, `chief.conversation_role`, `node.ontology`, `consequence.*`, `conflict.*` returned `UNKNOWN_OPERATION` northbound. | `buildOperationRegistry` now derives every operation from the canonical MCP registration; the hand list is deleted. Discovery groups are derived from the operation namespace. |
| P0-B `stableSurface` was restated in `mcp-gateway-cli.ts` without `sidera_read`. | One canonical `GATEWAY_TOOL_NAMES` list; CLI profiles/`check`/startup read it. The live server already advertised `sidera_read`; the product connector still needs its own schema refresh. |
| P0-C/OAuth edge refused an expired token as HTTP 500 `server_error`, hiding the product's re-authorization path. | `verifyAccessToken`/code exchange raise SDK `InvalidTokenError`/`InvalidGrantError`; an expired or unknown token is a 401 `invalid_token` challenge with resource metadata. |
| Reviewer topology was hardcoded to World=Human, Project=Machine+Human, Task=exact Chief Conversation. | Reviewer selection, independence, self-review, reviewer count and Human involvement now come from the adopted parent Rule's `policy.reviewPolicy`, falling back to the versioned `sidera-r1-bootstrap-governance/1` policy. Parent-boundary, exact object/digest/version binding, real completed review and record immutability stay Basic. |
| `subjectivity.get/revise` only rejected `nodeId`/`targetNodeId`/`nodeRef`. | Every caller-selected subject selector is refused before any read. |
| `chief.status` merged Core-initializing with edge reasons; a stopped Core was reported with a return-route reason. | `chief.status` carries an explicit `separation` block (Core readiness, edge transport, exact Presence, return route, Operator Host health, Worker Authority, bootstrap governance); Core readiness is its own layer. |

Live recovery performed: Gateway restarted to load the revised registry (OAuth
state preserved, binding untouched); Core restarted after it exited independently.
Codex Host and exact Chat Presence remain blocked and are classified, not faked.

Final acceptance status: **PENDING HUMAN REVIEW**. These boundaries are part of the delivery, not silently waived tests.

## 2026-10-08 Codex 独立复核后的修订

DSH 的实现结果是历史交棒记录。Codex 直接复核源码和 live loopback RPC / MCP 后，修正了：Gateway schema 绕过及 operation 命名 / node.rename 回归；reviewer policy 在 Console、多个 reviewer、optional Human、Reviewer 类型和冲突恢复中的未完整接线；机器采纳 Project 的真实 Human ancestor provenance；Chief 的 canonical Project scope；粘滞 Host health 和混入 Authority 的 Host 状态；历史 UI Presence；实际 Gateway ingress；缺失 Codex updater executable 的受限自动 re-pin。

Core READY 与真实跨 Node 工作闭环继续分开判断。恢复 executable、读到 model/list、获得 MCP bearer 或完成本地测试，都不能证明隔离账户登录、精确 thread 可恢复、Human adoption、跨 Node Authority、ChatGPT connector schema 刷新或 exact Chief return 已完成。

本轮修改、live E2E 阻碍和唯一一次统一验收的最终结果，以 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md 为准。
> 2026-10-08 Codex 轮次最终状态：本文件中早先的全绿结论属于历史轮次。本轮唯一完整验收为 FAIL；失败项已做必要定向修补，未重跑六套完整验收。补修包括 World successor governance exact pin、多 reviewer / optional Human、真实 Human ancestor、Gateway / D/E / ingress / Presence / Host health 和 OAuth credential boundaries。最终修改、live E2E blocker 和 focused validation 以 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md 为准。

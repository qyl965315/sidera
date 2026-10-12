# Sidera R1 全局工程收敛结果 · 2026-10-12

本轮完成隔离候选的真实集成、跨入口修复、源码对标和合成回归。**真实 ChatGPT 原 Conversation → Sidera → Operator → 原 Conversation 结果回收仍为 HOLD；M0、M0+、M1 均未宣告通过。** 本报告覆盖并更新随源分支带入的早期局部结果报告。

## 唯一候选与可恢复边界

- 原工程：`D:\Sidera-R1-v0.1.0`，不是 Git 仓库；没有向其覆盖候选代码。
- 唯一集成树：`D:\Sidera-R1-v0.1.0\.sidera-dev\convergence\r1-chatfirst-integration\project`，分支 `r1-chatfirst-integration`。
- 起点 Contract：`d80e936b456052cf5bd4179065ab75837f1f08bd`。
- 集成 Core：`e528e2364381f9516a89ba7970790d95b67493e6`；Edge：`d322cb468cc9469feaaac2b3b62b8180e7fc8a55`；Runtime doctor：`741761e2d0e3a3fced60ed36d946cd540cd31a7b`。源分支历史保留在合并父链中。
- 集成代码提交：`d9d93cd2ca5533a5a61ebd597f6571a286af1304`，四父合并保留以上 Contract/Core/Edge/Runtime 历史；本轮修复与可复现实验已在同一代码提交。
- 修改前树为 clean。恢复包：`D:\Sidera-R1-checkpoints\global-convergence-20261012-074702\integration-before.zip`，SHA256 `79B6F9BD80F39BE370119B17A16F1E7400D44E561EB51AAF045BC83A09FE66D6`。同目录保存 HEAD、分支、工作树、dirty/untracked 检查和依赖信息。
- 使用现有 Node `v24.18.0` 和现有 dependency junction；没有安装外部调度框架或修改依赖锁。所读 Human 文档和锁文件哈希见 [inputs.json](evidence/global-convergence-20261012/inputs.json)。

机器可读验收：[validation.json](evidence/global-convergence-20261012/validation.json)；代码提交时已测工作树文件摘要：[source-manifest.json](evidence/global-convergence-20261012/source-manifest.json)；原始证据摘要：[evidence-manifest.json](evidence/global-convergence-20261012/evidence-manifest.json)。证据单独提交，并用精确 `-text` 属性保留原始换行/哈希；该证据提交不再改变运行代码。

## Problem & Solution

| 产品级问题 | 集成后的实际修复 | 验证与限制 |
|---|---|---|
| Gateway 已有作用域处理，但原生认证 HTTP MCP 没有走相同入口证明路径 | `captureTools` 复用一个认证 around wrapper；Gateway/native HTTP 只在已认证 SDK callback 中形成 ingress；`configuredChiefIngressScope` 统一验证 Human 配置 | 真 loopback Streamable HTTP MCP → RPC → Core → 合成 Host → exact result pull。配置本身、工具参数和任意 `_meta` 不产生 ingress/Authority；外部原 Chat 未验证 |
| 同一 Chief 多 Project 时，初始化和 frontend prepare 仍可能尝试单一绑定而失败 | `prepareFrontend`、绑定/交接事件和前端启动显式选择 binding；模糊调用拒绝 | 两 Project、三前端的实际 `startLocalService` 冷启动/关闭/重启测试，原结果绑定保留；全部使用临时数据与合成 Host |
| 原 Chat 结果边界可经 Artifact、Context、Resource、Run basis、Work inspect 等路径绕过 | 复用 `ChiefDispatch.requireTaskScope`，对有 Chief route 的 Task 及所有关联来源检查；Resource 同时检查 task/run/artifact，幂等去重包含上下文 | 同 Node 不同 Chat/Project、内部 Host、关联混合投影和 retiring binding 负向测试；独立 Node 任务及合法共享资源保持原有权限规则 |
| 只读 Host probe 会经事件回调唤醒已有合法 queue | `probeHostHealth` 标记 `observationOnly:true`；Runtime 对这种诊断事件不调用 observation wake；既有交接/恢复/工作事件路径保留 | 红→绿实测：4 次 probe 的 stub Agent turn 从 1 降至 0；随后工作事件唤醒 1 次，重复 wake 不重派；没有新 Scheduler 或 Planner |
| 合并后的工具目录少了已有只读结果工具；测试隐含依赖构建产物及 Windows 文本转换 | 补齐 `chief_result_get` 的只读目录项；桌面边界测试自备临时静态资源；生成文档固定 LF | 没有新增产品前端功能，没有放宽认证/桌面确认断言；保留首次失败日志，见下表 |

独立复核覆盖：认证包装、完整结果投影路径、资源关联去重、同 Node 合法共享以及诊断事件/交接恢复边界。修复未改变 NodeRef 主体、Authority/Grant、Effect Gate、History 权威存储，也没有把 Session 或 Host 当成主体。`UNCERTAIN` 保留原 Task/Run/Message/Attempt，不能依据超时、探测失败或新执行器重新发送。

诊断修复范围仅为 `host.health.observed` 且 `observationOnly === true` 的 probe 事件。只有重复 probe 变绿、没有新工作事件/授权交接/显式恢复时，旧 queue 有意保持 queued；本轮没有新增自动恢复或声称所有诊断事件均不会唤醒模型。独立复核要求的“真实工作事件自身先唤醒，再验证重复 drain 幂等”断言已补齐。

## 源码对标与协调成本

参见 [SIDERA_ORCHESTRATION_REFERENCE_AUDIT.md](SIDERA_ORCHESTRATION_REFERENCE_AUDIT.md)。Symphony、Gas City/Gas Town、Magentic 均固定 Commit，只读源码和测试；没有运行上游测试、启动其平台或复制其实现。选择既有确定性调度、持久任务/依赖/事件去重的 REUSE，以及已复现的诊断 no-wake 小幅 ADAPT。没有证据支持 REPLACE 当前 Scheduler。

可复现实验：`node scripts/orchestration-cost-experiment.ts`。同一账目归并任务、4 个可用 Operator、相同精确答案与至少 1 次独立核验门槛。使用生产 Core/Continuation/MessageBus/Authority/Effect 与离线 stub Host；每个实际 invoke 都有 canonical Attempt，完成结果经原合成 CC Session 观察。逐次 Task/Attempt/invoke 和完整定义见 [orchestration-cost.json](evidence/global-convergence-20261012/orchestration-cost.json)。

| 场景 | 策略 | invoke / Effect 边界激活 | Operator 激活 / 空闲 | CC 额外协调 / 结果回执 | 本地执行 ms |
|---|---|---|---|---|---|
| 正常 | A 固定 1 产出 + 3 核验 | 8 / 8 | 4 / 0 | 0 / 4 | 170.654 |
| 正常 | B 稀疏 1 产出 + 1 核验 | 4 / 4 | 2 / 2 | 0 / 2 | 81.088 |
| 正常 | C 仅异常额外协调 | 4 / 4 | 2 / 2 | 0 / 2 | 80.357 |
| 一次执行前拒绝 | A | 9 / 8 | 4 / 0 | 0 / 4 | 163.786 |
| 一次执行前拒绝 | B | 5 / 4 | 2 / 2 | 0 / 2 | 97.053 |
| 一次执行前拒绝 | C | 7 / 6 | 2 / 2 | 1 / 3 | 122.978 |

六格各 1/1 通过公共验收，产出工作重工 0、Operator 间 turn 0、运行中新增 Human semantic act 0。故障格各有一次 `confirmed_no_effect` 失败和一次补派；这是一次 Task 执行前明确拒绝，**不是 Host 永久失联或 UNCERTAIN 自动重试**。A 的冗余审核是明示实验政策，不代表所有固定组；B/C 健康路径相同。C 在这个确定性可处理故障上多出 1 次 triage + 1 次回执，没有质量改善证据，故不把该实验策略并入生产。

脚本是实验驱动，不是第二个生产 Scheduler。CC 判断由 stub 固定决策，不能验证模型规划能力；每格只运行一次，耗时排除共同初始化，不排序生产速度。真实模型 Token、实际费用和生产质量成功率均为 `UNKNOWN`，激活数不能换算成费用。

## 验证证据

命令均在唯一集成树执行；完整回归使用 `tests/fixtures/private-loopback.ts`，让临时 LocalSetup 使用临时空闲端口，避免与现有 P5 实例相互作用。

| 证据 | 结果 | 分类 |
|---|---|---|
| `npm run check` | PASS，`typecheck-final.log` | 真实 TypeScript 检查，含最终实验脚本 |
| 首次全量回归 `full-serial.log` | 429 项，427 通过，2 失败 | 保留原始失败，不用局部绿替代整体验证 |
| 首次失败分类 | desktop fixture 缺 `ui/dist` 导致 `UI_BUILD_REQUIRED` 503；生成文档 CRLF/LF 字节差 | 均为可复现测试环境/checkout 依赖；修复测试隔离与精确 EOL |
| `core-scope-baseline-red.log` / `core-projection-baseline-red.log` | 修复前真实预期拒绝失败 | 合成记录上的真实 RPC 漏检 |
| `core-scope-tests.log` | 31/31 | ingress、投影、资源边界 |
| `native-edge-tests.log` | 12/12 | 真实本机协议栈 + 合成 Host |
| `diagnostic-wake-baseline-red.log` → `diagnostic-wake-regression.log` | 1 个错误启动 → 0；49/49 回归通过 | 真实 Core 调度 + 合成 Host，不是真模型账单 |
| `orchestration-cost.log` / `.json` | 六格公共验收及 Attempt/回执/无悬挂状态断言通过 | 确定性离线实验，真实模型质量和费用 UNKNOWN |
| 最终全量 `full-serial-final.log` | **431/431 PASS**，0 fail/cancel/skip，126.724 秒 | 整个合并候选，真实本机代码/协议 + 明确 fixture；不是 live ChatGPT E2E |
| 最终 `npm run evidence:check`，`evidence-check-final.log` | PASS | canonical fixture 字节一致性 |

## 当前真实链路：逐段保留 HOLD

本轮有界观测时间在各 JSON 中。它们是当时的观察，不是永久状态。详见 [live-doctor.json](evidence/global-convergence-20261012/live-doctor.json)、[runtime-boundary.json](evidence/global-convergence-20261012/runtime-boundary.json)、[connector-observation.json](evidence/global-convergence-20261012/connector-observation.json)。

| 链路 | 实际观察 | 裁决 |
|---|---|---|
| 原 Core 8765、native MCP 8787、Gateway 8788、consent 8791 | 当时拒绝连接；doctor 未启动服务 | BLOCKED |
| 已配置公网入口 | 有界请求超时 | UNKNOWN；不是 OAuth 失败证明 |
| 当前 Codex 的已安装 Sidera capabilities connector | 调用一次，返回 `-32603 Internal error`；没有重试 | 不是原 ChatGPT 的相关调用证据 |
| 原 Project/Chief 元数据 | 在哈希验证的生产 DB **副本**中读取到一个 active binding；Gateway 未配置 exact conversation/binding/provider correlation | 已存记录，不证明当前认证或原 Chat Presence |
| 真实 Operator 和结果回收 | 本轮没有真实 dispatch、执行回执或原 Chat 观察 | HOLD |

原数据库有 WAL。未对生产 DB 打开 SQLite 连接，而是复制固定 DB/WAL/SHM 后验证原文件前后与副本哈希一致，仅读取副本的公开 binding/session/计数。副本观察到 Task=0、open turn=0、uncertain run/message/attempt=0、Shared History=10；这些计数不能代替以后恢复时的当前检查。原始副本保存在 checkpoint 外部目录，不进入 Git；公开摘要和哈希在 `production-copy-metadata.json`、`production-copy-hashes.json`。

完整回归结束后再次对原 DB/WAL/SHM 计算哈希，三者与修改前相同，见 [production-final-hashes.json](evidence/global-convergence-20261012/production-final-hashes.json)。

## 尚未达成的整体验收

- **M0 HOLD**：缺现有原 ChatGPT 的真实认证调用、实际授权 Operator 执行和原 Chat 对结果的工具观察。候选已具备局部端到端协议测试，不能以此关闭 M0。
- **M0+ HOLD**：统一 Task 合同和合成替代/空闲/阻塞可以测试，但没有第二种真实异构 Operator 及真实多 Operator 协作数据。
- **M1 HOLD**：真实重复任务、故障后人工介入、运行耗时/质量/费用统计未取得；跨 Conversation 的授权恢复没有现场验收。
- 当前 `supervision.maxRounds`、Grant 使用计数、共享祖先预算和 Rules 边界不等于完整的跨模型 Token/费用硬预算。`budgetRef` 也不是已兑现的计费 enforcement。真实费用仍 UNKNOWN，不能把换 Node 当作预算绕过途径。
- 本轮没有增加自动专业技能匹配器、外部运行时或定时模型巡检；Node/Executor 现有发现与 admission 可复用，其真实可替代性仍需 M0 后验收。

## 下一步已收敛到一次具体 Human 授权

请求批准的动作是：**把本报告记录的、测试通过的确切候选版本部署到现有 `D:\Sidera-R1-v0.1.0` 运行环境，按现有所有者生命周期恢复已确认缺失的 Core/MCP/Gateway，并为现有 Chief binding 补齐已批准的原 Conversation 入口作用域，随后继续同一个真实 P0。** 这是候选部署与生产配置/状态写入授权；当前没有执行。

可审阅范围：

1. 复核现有进程所有权和 open/UNCERTAIN 原记录，制作包含 dirty/untracked、配置与 DB/WAL 的恢复点。来源不明或已运行的进程不停止；不自动重放旧请求。
2. 部署限于本轮已审核源代码；保留原数据库、Shared History、私有 D/E、Node/Session/Authority、现有 OAuth client/Token/账号、原公网地址及其安全策略。
3. 配置现有绑定 `cf6b0d22-e4ec-41e1-8ad1-5176fc0f0cf3`，Project `sidera://project/local`，Chief `ba3cb7ac-b601-4706-920d-d540960c3b4f`。其 conversationRef 必须对应 Human 批准的原 Chat；副本仅记录摘要，不能自封认证。native/frontend 与 Gateway 使用相同确切作用域合同。provider session 仅在原 Chat 的真实认证相关数据可得且经批准后配置，不猜测 `_meta`。
4. 复用现有 launcher/lifecycle 和入口，不创建新 Chat、账号、Tunnel 或常驻调度器。确需重新 hosting 现有 Tunnel 或 Human PKCE 时，按现有所有者与 Human 专属流程完成；不得由模型代点批准。
5. 原 Chat 提交一项有明确验收的真实任务；使用固定 requestId，并收集 binding、Task、Run、Effect、Host receipt、History、结果 message ID 和原 Chat tool pull。任何不确定返回保存原 ID 并 reconciliation，不再发送一个新请求蒙混过关。

具体已有命令、生命周期与 PKCE 边界见 [HEADLESS_DOCTOR_RECOVERY.md](HEADLESS_DOCTOR_RECOVERY.md)。候选所有无需 Human 的集成与验证先完成，授权不被当作工程选择咨询。

需要这项授权的直接依据是用户原任务第七节：“未经额外明确批准，不得……直接把候选分支覆盖到生产环境”，以及生产 SQLite/Shared History、身份和公网安全的明确限制。不是额外发明的审批流程。

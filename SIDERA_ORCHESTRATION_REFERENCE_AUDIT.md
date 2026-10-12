# Sidera orchestration reference audit — 2026-10-12

本轮结论：复用 Sidera 既有 Task / Run / dependency / History / Effect 与事件续行。没有证据支持整体替换 scheduler，也不引入第二队列、第二身份判定或常驻模型巡检层。

集成代码提交：`d9d93cd2ca5533a5a61ebd597f6571a286af1304`；最终合并候选全量回归 431/431、TypeScript 与生成文档检查 PASS。完整边界见 [工程结果报告](SIDERA_R1_GLOBAL_CONVERGENCE_RESULT_20261012.md)。

原 ChatGPT → CC → Operator → 原 ChatGPT 的真实 P0 仍为 **HOLD**。下列源码结论、SYNTHETIC 实验和本地测试均不能替代该产品验收。真实模型 Token 与费用为 **UNKNOWN**。

## 证据范围与固定版本

| 项目 | 固定 commit | 许可证 | 本轮证据边界 |
|---|---|---|---|
| Gas City | `79721d6ed394a66bc07ef7de59418b17c565819b` | [MIT][gc-license]，2026 Gas City Contributors | 已读取实际实现与测试源码；上游测试未运行。 |
| Gas Town | `649b832b7672bc7a2dbef26f5983aba6198b819b` | [MIT][gt-license]，2025 Steve Yegge | 已读取实际实现与测试源码；上游测试未运行。 |
| OpenAI Symphony | `be10a1b79df723d6d7612b5651c8522704dafb2e` | [Apache-2.0][sy-license]，另有 [NOTICE][sy-notice] | core_review 读取实际实现与测试源码；本文件复核本地 commit/许可证；上游测试未运行。 |
| Microsoft Agent Framework / Magentic | `fd52de71579162a888fb2dd7510c57c6014dcdfc` | [MIT][ma-license]，Microsoft | integration_audit 读取 Python/.NET 实现及测试；本文件复核 commit/主要源码位置；上游测试未运行。 |

只读快照：`D:\Sidera-R1-checkpoints\orchestration-reference-20261012\` 下的 `gascity`、`gastown`、`symphony`、`agent-framework`。各研究者检查结束工作树 clean。未安装、构建、启动或部署上游项目；未复制外部代码，未新增运行依赖。本文件是源码研究归口，不是新架构计划。

## 文档 D / 代码 C / 测试 T 不混用

| 项目 | D：文档声称/设计 | C：固定源码实际行为 | T：证据能支持什么 |
|---|---|---|---|
| Symphony | [SPEC][sy-spec]描述持续处理 Tracker issue、隔离 workspace、重启恢复。 | `running/claimed/retry` 为内存 GenServer 状态；恢复重读 Tracker/workspace，SPEC 7.4 明确无 durable orchestrator DB，不能推导外部 Effect 恰好一次。 | [core_test][sy-test]检查本地调度/runner 行为；本轮仅阅读，未执行，不证明远端无重复 Effect。 |
| Magentic | [官方文档][ma-doc]描述动态选择 agent、ledger/停滞处理；10 rounds/3 stalls/2 resets 是显式示例配置，文档使用 consecutive stalls 表述。 | [默认值][ma-default] round/reset 为 None；[stall 代码][ma-stall]坏轮 +1、好轮 -1（下限 0），严格 `> max_stall_count` 才重规划，不能读成连续 3 次停滞即触发。 | [fake/RecordingChatClient 测试][ma-test]检查硬限、checkpoint、manager 调用；非真实模型质量/成本证据，本轮未执行。 |
| Gas City | 有确定性 controller 与新 reconciler 的设计。 | [v2 门控][gc-v2]表明当前默认 legacy，v2 常规启用被拒，开发/预发 override 才能试运行。 | [门控测试][gc-v2-test]可读，不能因存在测试或设计就宣称 v2 成熟默认运行。 |

## 横向判断

REUSE＝使用既有机制；ADAPT＝有界适配；REPLACE＝替换既有机制；REJECT＝不符合本任务边界；DEFER＝证据或现实需求不足。本轮 **REPLACE 为无**，只有一项新 ADAPT，已取得本地红→绿证据，详见后表。

| 外部机制与证据 | Sidera 实际机制 | 真差距 / 判定 | 实施成本 | 产品验收贡献 | 预计协调成本及证据 |
|---|---|---|---|---|---|
| Gas City 无模型控制 worker：`prompt_mode=none`，执行 `gc convoy control --serve --follow`；[配置][gc-control]、[实际 drain/wake][gc-dispatch]、[事件合并测试][gc-wake-test]。 | [Continuations.pump](core/continuations.ts#L364) 已有单泵、dirty 合并、持久依赖及固定 resume identity。 | 没有第二 scheduler 的缺口；**REUSE**。 | 无新增模块；验证真实调用路径。 | 等待不依赖 Human 中转，终态事件使原 Task 续行；仍须真实返回验证。 | 父 WAIT 期间不需模型巡检；不是所有 Node 永久零调用。[WAIT 边界](core/continuations.ts#L524)有源码依据，Token 节省未测。 |
| Gas City Beads 持久任务/依赖与原子认领；[Claim 实现][gc-claim]、[冲突/故障测试][gc-claim-test]。 | SQLite Task/Run/dependency、Grant reservation、Effect Attempt、History 已存在。 | **REUSE** 原持久链；**REJECT** 另建 Beads 权威队列。 | 引入上游存储将增加双写、迁移与恢复一致性成本；本轮不实施。 | 保留原请求、预算、结果关联，是 P0 正确性的基础。 | 确定性认领不需模型决策；没有证据表明换存储可减少 Token。 |
| Gas City pool 上下限、scale_check 与探测并发上限；[配置][gc-config]、[并发执行][gc-pool]；[就绪扫描测试][gc-ready-test]检查 file leg 零 bd 子进程。 | 已授权 Operator discovery、Session admission 与 Task dispatch。 | 未发现当前 P0 需要弹性池；**DEFER**。Agent template/池槽不能直接成为 NodeRef。 | 新池会增加容量、drain、角色配置与维护状态。 | 当前缺的是原 Chat 返回与授权部署，不是更多 worker。 | 可减少无用进程/查询；零子进程测试不等于零模型 Token，不外推费用。 |
| Gas City session/runtime/conversation epoch 与 incarnation fence；[lifecycle][gc-lifecycle]。 | NodeRef 独立于 Session；[session-strategy](core/session-strategy.ts) 经 Registry CAS 和授权 Host handoff。 | **REUSE** 既有世代隔离；**REJECT** 以 Session/assignee 替代主体或铸授权。 | 无新增身份层；Host 适配仍需逐个验证。 | Host 替换后仍是原 Node/Task，旧身份不能继续执行。 | 确定性 fence 无需额外协调推理；不能推定切 Host 会节约模型成本。 |
| Gas City runtime 无法观察不是已消失；[错误语义][gc-runtime]。backstop 有持久退避及 busy/unknown hold；[测试][gc-backstop-test]。 | Condition UNKNOWN、[Host probe / authorized recovery](core/host-health.ts)、Effect UNCERTAIN。 | **REUSE** 未知态与原证据；**REJECT** 把 drain/recycle/reopen 当成旧 Effect 未发生证明。 | 不引入恢复循环；真实恢复仍有 Human/Authority 最后一步。 | 防重复执行、保留预算与原始关联，避免“恢复成功”伪证据。 | 退避能降低探测/nudge；未知态下盲目重派反而增加调用和外部副作用。 |
| Gas City session store 故障时前置 claim fence 可放行到后续 claim；[代码][gc-failopen]。closed dependency 的未知/空 outcome 可满足依赖；[代码][gc-dependency]。 | Authority/Effect 最后门与 correlated terminal evidence；[不 replay uncertain](core/continuations.ts#L504)。 | **REJECT** 迁入授权或任务完成判据；不是声称上游所有校验都被绕过。 | 不实施。 | metadata 不铸权限；closed/accepted 不冒充 completed。 | 不能以少检查或自动重试换取表面调用减少。 |
| Gas Town Witness 启动模型巡检与 nudge poller；[manager][gt-witness]。redispatch 持久冷却/次数后调用 `gt sling --force`，可升级模型；[实现][gt-redispatch]、[状态测试][gt-redispatch-test]。 | CC 已是当前 Frontend Node 的角色；确定性运行控制在 Core。 | **REJECT** 新增 Mayor/Witness/Deacon 模型协调层和未知 Effect 自动重派。 | 会增加常驻角色、配置、状态与维护成本；本轮不实施。 | 不解决现有原 Chat scope/返回链路阻塞。 | 源码能确认模型被唤醒巡检，不能推定频次与账单；Token/费用 **UNKNOWN**。 |
| Gas City 新 v2 reconciler 默认不可用：`v2EffectsReal=false`；只有 developer skeleton/staging overrides 可开；[门控][gc-v2]、[拒绝测试][gc-v2-test]。 | Sidera 已有可测试的 Core scheduler/continuation。 | **DEFER**；不把开发代码当成熟默认执行路径，不 **REPLACE**。 | Go/Beads/runtime provider 及 legacy/v2 迁移负担高。 | 无当前 P0 验收贡献。 | 无已验证的协调调用对比。 |
| Symphony 纯代码按优先级/slots 选 issue，派工前重读 Tracker；[orchestrator][sy-dispatch]。运行/claimed/retry 是进程内状态，重启靠 Tracker/workspace 重建。 | [executors](core/executors.ts)、[continuations](core/continuations.ts) 和持久 Effect Gate 已覆盖确定性 admission/续行。 | **REUSE** 现有调度；**REJECT** 用 Tracker/内存 claim 替换 Task/Effect 权威。SSH worker host 是同一 adapter 的容量选择，不证明异构 Operator 能力。 | 引入 Elixir/Tracker/workspace runtime 成本高；不实施。 | 对就绪调度有参考，不能补原 Chat 返回能力。 | 选 worker 不新增模型判断；实际工作与 continuation 仍调用模型，无 Sidera 节省实测。 |
| Symphony max_turns 仅限一次 runner；正常退出仍排 1 秒 continuation，异常退避重试；[runner][sy-runner]、[退出处理][sy-retry]、[测试][sy-test]。token 累加是观测而非硬预算。 | 已有 Grant uses、Supervision maxRounds 与持久 Effect Attempt；UNCERTAIN 需原 Attempt reconciliation。全局 Token/费用 hard enforcement 尚未验收。 | **REJECT** 把单 runner 上限当任务总预算、把 worker 重启当安全 Effect 重试；usage 记账 **DEFER**。 | 不增加恢复循环；后续 usage 接入只可落现有 Run/History。 | 保持既有使用次数/轮次约束与不重发语义。 | 累计 token 可观测但不是授权或硬限；本轮真实 Token/费用 **UNKNOWN**。 |
| Magentic facts/plan + progress ledger 是模型判断；每次 _complete 新 session；[manager][ma-manager]、[循环/硬限][ma-loop]、[fake tests][ma-test]。默认 maxRounds/maxResets 为 None；checkpoint 保存 workflow 状态。 | Supervision/Continuation、事件幂等与原 Task/Effect 已有。 | **REUSE** 结构化进展问题和有界计数；**REJECT** 每个诊断/response 加 manager-loop、第二 ledger、reset 代替 UNCERTAIN reconciliation；框架接入 **DEFER**。 | 新依赖与模型角色都增加维护面；不实施。 | 可启发异常时提问，不直接提升原 Chat P0 可用性。 | 源码计数：manager Agent.run 为 `2 + Σa_i + 2R + F`，progress 的 a_i=1..3；正常无重试/重规划，W 次 worker 响应通常 manager=W+4。一次 worker 成功通常为 5 manager+1 worker=6 个 Agent.run 入口；不是 provider HTTP 次数或账单。 |

## 本轮唯一新 ADAPT 与 SYNTHETIC 证据

改动：`probeHostHealth` 产生的 `host.health.observed` 增加内部 `observationOnly:true`；Runtime 只对此精确事件组合跳过隐式 `wakeObservations()`。未标记的授权 handoff receipt 与显式 drain 保持原行为；不推广为屏蔽所有 diagnostics。

已确认根因：原 [runtime.onEvent](core/runtime.ts#L124) 在事件入队筛选后广泛调用 wake，诊断探测可顺带 drain 先前已排队的工作。修复只收窄这个触发点；诊断证据仍写入原 History/health。`host.health.changed` 与 `host.health.observed` 不混为一种事件，标记也不产生 Authority。

| 本地回归 | 实际路径/断言 | 结果与证据 |
|---|---|---|
| 红基线 | 预存一条 durable observation，4 次真实 `probeHostHealth` 经现有 Runtime/Continuation/Effect 边界；外部 Host 为 stub。 | stub invocation **1**，期望 0，断言失败；[baseline log](evidence/global-convergence-20261012/diagnostic-wake-baseline-red.log)。 |
| 修复后 | 同前提和 4 次 probe。 | stub invocation **0**；原 observation 仍 queued，Task 数 0；[测试](tests/mesh-activation.test.ts#L118)。 |
| 正向/幂等 | 后续真实 Core `human.message` 事件先自动 drain 原 queue 并断言，再显式调用 wake 两次；另测授权 handoff receipt fixture 和显式 recovery/drain。 | 原队列执行 **1** 次且不重复，原 event→Task identity 保留；handoff/drain 各 1 次；[测试](tests/mesh-activation.test.ts#L147)。 |
| 相关边界回归 | mesh activation、condition、continuation、trust effect、host control。 | **49/49 PASS**；[regression log](evidence/global-convergence-20261012/diagnostic-wake-regression.log)。 |

上述计数是实际 Core 调度到 stub 的调用，不是真实 LLM。单 fixture 的 1→0 不能外推节省比例、日调用量或模型费用；授权 handoff fixture 也不是一次真实 Host 创建。

独立 A/B/C 为工作分配政策实验，**不是诊断修复的三个版本**。所有组共用四个初始 IDLE Operator 与一个 synthetic Communicator CC 替身；任务是整数账目整合，已知正确答案且至少一名独立 Operator 核验。实际导入 Core Runtime/Continuation/Authority/Effect，Host 输出用确定性离线算法。

| 政策 | 明示工作分配 | 正常 invoke / crossing | pre-effect 故障 invoke / crossing | 故障额外协调 |
|---|---|---|---|---|
| A | 固定四人：1 producer + 3 independent verifiers，刻意冗余核验政策。 | **8 / 8**：Operator 4 + CC receipt 4。 | **9 / 8**。 | 0 triage；1 次安全补派。 |
| B | 稀疏：1 producer + 1 independent verifier。 | **4 / 4**：Operator 2 + CC receipt 2。 | **5 / 4**。 | 0 triage；1 次安全补派。 |
| C | 正常同 B；仅确认 pre-effect 故障后另建一次 CC triage Task。 | **4 / 4**，同 B。 | **7 / 6**：Operator 2 + CC triage 1 + CC receipt 3。 | 1 triage；1 次安全补派。 |

故障注入为首 producer 的一次 Task 在 `boundary.cross` 前拒绝，Core 记录 **confirmed_no_effect** 后才允许有界新补派；不是持续 Host 失效或 UNCERTAIN 自动重试，原 Operator 后续仍可核验其他 Task，不证明真实 Host 替代。六个单次 case 均通过同一 oracle+至少一次独立核验（6/6）；A 三次核验全部成功另属所选政策满足。已执行工作重做 0，Operator→Operator turns 0；未测试网状互协作。A/B/C 剩余 IDLE Operator 为 0/2/2，两场景相同；全部 CC receipt turn 均计入。

精确命令：`node scripts/orchestration-cost-experiment.ts`；[脚本](scripts/orchestration-cost-experiment.ts)、[结构化实际调用/Task/Effect 日志](evidence/global-convergence-20261012/orchestration-cost.json)、[stdout](evidence/global-convergence-20261012/orchestration-cost.log)、[最终 tsc 验证](evidence/global-convergence-20261012/typecheck-final.log)。core_review 执行，本文件已核对六组实际指标；integration_audit 独立重算 JSON 与复核代码，无 P1。这里的独立核验指不同 Node 及与 producer 不同算法，所有 verifier 共用确定性算法，不是独立模型判断。

A 的额外调用来自明确选定的冗余核验政策，不是全分布式架构的普遍下限；C 正常与 B 相同，故障时更多，不能宣称 C 更优。验收只针对确定性账目 fixture，不能证明真实模型质量等价。单次本机耗时无 provider latency，不作性能排名；invoke/crossing 不是 Token 或账单，真实模型 Token/费用 **UNKNOWN**。

验收边界：红绿回归确认诊断无意唤醒消除、正向唤醒仍可达；A/B/C 展示复用既有 Core 可测的政策成本。不得绕 Authority/Effect 或改变独立 Node Task 共享，也不以本地结果宣告原 Chat P0 通过。独立代码审查结论由主 agent 的集成结果归口。

## 维护成本与本轮边界

- Gas City 当前 [go.mod][gc-mod] 要求 Go 1.26.9，依赖 Beads v1.3.1、packs、存储/runtime 适配；Gas Town [go.mod][gt-mod] 要求 Go 1.26.2。整体接入会带来本项目目前没有的运行栈和维护面。
- 上游测试源码可证明作者意图和断言覆盖，不能证明这些测试在本机、此部署或真实模型链路通过。本文无上游 PASS 声明。
- 本轮没有复制外部实现、没有新运行依赖、没有第二 scheduler。唯一新适配是本地已有事件入口的诊断触发收窄。
- 生产 scope/凭据/身份/tunnel 不因本审计改变；原 ChatGPT P0 仍 HOLD。候选生产部署与启动原代码是不同授权对象，不从本地测试推导部署批准。

## 固定官方源码与测试索引

[gc-license]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/LICENSE
[gt-license]: https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/LICENSE
[gc-control]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/bootstrap/packs/core/agents/control-dispatcher/agent.toml
[gc-dispatch]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/dispatch_runtime.go#L436
[gc-wake-test]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/cmd_convoy_dispatch_test.go#L9236
[gc-claim]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/beads/native_dolt_store.go#L2110
[gc-claim-test]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/beads/native_dolt_store_claim_role_test.go#L62
[gc-config]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/config/config.go#L3492
[gc-pool]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/build_desired_state.go#L301
[gc-ready-test]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/dispatch_control_ready_test.go#L318
[gc-lifecycle]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/session/lifecycle.go#L24
[gc-runtime]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/runtime/runtime.go#L97
[gc-backstop-test]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/execution_backstop_test.go#L521
[gc-failopen]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/cmd_hook.go#L612
[gc-dependency]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/internal/beads/beads.go#L754
[gt-witness]: https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/witness/manager.go#L270
[gt-redispatch]: https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/deacon/redispatch.go#L218
[gt-redispatch-test]: https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/deacon/redispatch_test.go#L77
[gc-v2]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/reconcile_mode.go#L32
[gc-v2-test]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/cmd/gc/reconcile_mode_test.go#L92
[gc-mod]: https://github.com/gastownhall/gascity/blob/79721d6ed394a66bc07ef7de59418b17c565819b/go.mod
[gt-mod]: https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/go.mod
[sy-license]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/LICENSE
[sy-notice]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/NOTICE
[sy-dispatch]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/lib/symphony_elixir/orchestrator.ex#L781
[sy-runner]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/lib/symphony_elixir/agent_runner.ex#L88
[sy-retry]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/lib/symphony_elixir/orchestrator.ex#L208
[sy-test]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/test/symphony_elixir/core_test.exs#L1022
[ma-license]: https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/LICENSE
[ma-manager]: https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py#L597
[ma-loop]: https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py#L1062
[ma-test]: https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/orchestrations/tests/test_magentic.py#L418
[sy-spec]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md#L280
[ma-doc]: https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic
[ma-default]: https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py#L480
[ma-stall]: https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py#L1122

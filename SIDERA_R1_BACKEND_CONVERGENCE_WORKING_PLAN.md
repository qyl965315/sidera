# Sidera R1 Backend Convergence — Working Charter
**版本**：2026-10-09 / GPT 初始设计裁决 / 尚未成为 Sidera Basic、World、Project 或 Task Rules。
**Codex 咨询结果**：独立 Codex Thread `01a120d0-dc62-79b1-b2fe-570ed45eae4d` 已提出部分意见并检查源码，但只读模型会话在模型服务超时后无最终报告，已于 21:41（北京时间）按限定时长停止。不得报告为正式双审/一致结论。Codex 过程事件保存在用户 Temp 下的 `sidera-convergence-codex-20261009-events.jsonl`。
**修改范围**：本文是唯一当前工作总纲；本轮没有修改生产代码、数据库、连接器凭据、Node/Rules/Grant 或服务进程。
**证据定位**：既有 `SIDERA_R1_CONSTITUTION.md`、`ARCHITECTURE_DIET_R1.md`、`SIDERA_R1_MIGRATION_MAP.md` 与 2026-10-08 的 DSH 历史审查仅作为仓库事实，非架构投票；本轮决策只采用 GPT 与 Codex 可确认的意见。

## 一、收敛的定义
目标不是再增加一个上层平台，不是减少代码文件的数量，也不是尽量让状态面板变绿。目标是：**对每类受 R1 管理的事实、授权、运行状态与 Effect，只有一个具有明确身份和证据要求的判定路径；任何跨模块操作都能追溯决定与结果；局部网络故障不改变 Sovereignty 或被错误升级为全局不可逆结果。**

优先级（词典序）：宪法/权限与 Effect 安全 > 因果与事实一致性 > 可恢复性 > 兼容性 > 运维复杂度与实现简洁。不能为了降低进程数量突破身份或凭据隔离。

### 不能改变的主体规则
NodeRef 是永久、不可混同的 Communicator 或 Operator 身份；Agent/Bot 属于 Operator；Chief 属于指定 Project 的 Conversation role；Executor 非独立 Node；Console 非 Node。S=D+E 在 Node 私域 CAS，不跨 Node 语义读写。Shared History 为公有被承认的 Action/Effect 来源，Ω=Apply(History,Basic Rules)；Claim≠Fact≠Description≠Explanation。Rules 的审阅制度来自有效父级；Human-only 决策不可由程序代理批准。未证实的外部 Effect 不得重放。Basic Rules 保证秩序不保证正确。

## 二、八项逻辑责任（不要求八个新服务）
| 责任域 | canonical 所有权 | 不得僭越的边界 |
|---|---|---|
| Identity / Sovereignty | NodeRef、私有 D/E 与修订 | 不能用 PID/Host/登录改变身份 |
| Rules / Authority | adopted Rule、Human-rooted Grants 的有效判定 | 不得把可达、能力或模型主张当批准 |
| Shared History / Ω | 可归责 Action/Effect + 确定性派生 | 运行缓存/HTTP 状态不是第二个 Fact Base |
| Communication | 显式 Envelope、ACK、交付关联与 Conversation scope | MCP inbound 不证明指定云端 Chat 可回程 |
| Operation / Effect | Task/Run/Attempt、唯一最终发送门与原件对账 | 只有具证明的资源丢失才能触发不可逆 fence |
| Evidence / Conditions | 带对象、代际、来源、TTL 的观测及派生判定 | 不发起 inference、不赋予 Authority、不决定 Task 终局 |
| Hythe / Transport Adapters | 厂商协议能力、实物 Host/Session 与低层事件 | 不自行声明全局 LIVE、Consent 或业务完成 |
| Local Product Lifecycle | 唯一启动入口和所有子进程真实 owner | 无权读取私人 Sovereignty、补签审批或重发任务 |

这八项是**职责**，可以落在既有 Core、Gateway、Workbench；禁止再做八个并行服务/定时器。

## 三、统一状态语义与执行合同
1. `Configured` 仅证明注册。 `TransportReachable` 仅证明可到达指定接入服务。`AuthenticatedIngress` 仅证明某边界 credential/Node 发起真实调用。`ExactConversationPresence` 需要厂商可核对的精确对象与来源。`ReturnRoutePrepared` 需要该对话的真实可用路由。彼此不可互推。
2. `Inspect` = 纯读取现有快照；`Probe` = 显式有界基础设施观测、只产生诊断证据；`Recover` = 有授权并可能创建进程/Session 的生命周期动作。`locate()` 若会启动 Codex/DSH，不得再作为无副作用的 Inspect。
3. 观察 `UNKNOWN`、`STALE`、`SUSPECT`、`CONFIRMED_LOST` 按对象/代际分别派生。`CONFIRMED_LOST` 需要实物 owner termination、精确 Session terminal/not-found、显式退休或其它足以排除“暂时不可达”的终止证据。两次超时仍不能单独证明物理销毁。
4. 所有动作基于 exact Node + Session/Executor + Capability + 当前 Authority + 当前可用性 + Effect Gate。操作经过 `PREPARED`→`MAY_HAVE_EFFECT`→`ACCEPTED`→`COMPLETED/FAILED/UNCERTAIN` 的证据单调状态机；任务开销/时间与模型返回的自述不等于 Host 完成。
5. `Host receive stream ended` 只说明通信流结束；确认 Host 自身终止前不得调用 resource-loss fence。`Probe timeout` 只落日志/Condition，不触发不可逆 Effect 处理。
6. 断电或 Gateway/Host 恢复必须先以原 Attempt/Host receipt 对账。明确 no-effect 之前可以安全重新安排，已跨 Effect 边界且无确切回执只能保留 UNCERTAIN，不可转成“失败后自动重做”。
7. 长期健康观测应由既有生命周期/传输职责有界管理，而非 `Activation` 一次启动刷新、Gateway 独立事实源、session_health 永不检查新鲜度。Core 本地就绪与特定操作是否可派发要分开评估。

## 四、统一问题与错误语义
原有五类 `denied/not_found/conflict/unavailable/uncertain` 保留为向后兼容的抽象结果类别。新增版本化 Problem Code Registry 只给**具体原因**稳定编码，不作为新判定真相：
- `SID-LIFE-1xxx` 本机生命周期；`SID-OBS-2xxx` 观察/时效；`SID-EDGE-3xxx` MCP/OAuth/公网；
- `SID-HOST-4xxx` App Server/ACP/Host；`SID-AUTH-5xxx` Rules/Human/Grant；
- `SID-EFF-6xxx` Task/Attempt/Result；`SID-DATA-7xxx` History/Ω/D-E；`SID-COMP-8xxx` 协议版本与厂商限制。
Problem 包含 `code, baseCategory, subjectRef, evidenceRef, occurredAt, retryObservationAllowed, effectReplayAllowed, humanAction, correlationId`。其中 `effectReplayAllowed` 默认为 false，不能由 HTTP 503 或 429 自动推导为 true；原因与条件（如 HUMAN_REQUIRED、INGRESS_ONLY、STALE）不得都作为异常抛出。HTTP/MCP/ACP/Console 文本从同一注册表转换，错误详情要脱敏。

## 五、按语义责任替换旧路径，不按文件逐个打补丁
| 旧局部路径 | 必须替换成的全局合同 | 退役条件 |
|---|---|---|
| Activation 30s stale cache、Gateway ingress poll、session_health 无 TTL | Evidence+Condition 的单一判定和分对象有效性 | 不再有任何业务组件直接将缓存旧值当权威状态 |
| external-mcp-client.locate = locator 字符串相等 | binding 配置与真实 Presence 明确分离 | 旧 boolean 不再决定 exact Presence |
| host-health timeout → reconcileResourceLoss；receive stream close → resourceLost | Observation 只供判定，Operation 仅消费 LossProof 后执行 fence | 所有 resource-loss 调用者都通过证据边界验证 |
| OAuth mode/refresh/audience/legacy 各自演进 | Gateway credential lifecycle 原地收口，兼顾人类认可和断线容错 | 旧 Token 迁移有明确过渡/重授权规则，没有静默扩权 |
| 单独 CLI/脚本启动 Core、Gateway、Tunnel | Workbench 一入口 + 原有 Core Owner witness 的统一生产生命周期 | 原服务依赖、用户自有进程与数据迁移通过后再淘汰旧入口 |
| Codex/DSH locate/创建 Session/接收逻辑交叉 | Adapter 纯 Inspect、受限 Probe、有界 Recover 三语义 | 各 Host 的实际版本、Session ID、收发原始回执均可验证 |
| 多处裸 SideraError/SetupError 字符串 | domain Problem Registry + 兼容投影 | 同一问题跨 Core/CLI/MCP/UI 错误码一致 |

所有旧路径必须有完成条件，且同一 canonical 事实不能长时间新旧双写。允许短期只读 shadow 对比；完成某门槛后停止旧路径，不保留永久“临时兼容”。

## 六、四个有限门槛（未通过即止步）
**G0 / Contract Freeze（本轮进行中）**：提出统一的核心数据/状态/错误合同、全部合法转换与回滚表；备份及比对现有 SQLite、History、两个 Node 私有 D/E 修订指纹和 Gateway 凭据边界；固定测试与不可变体；保留源代码可追溯版本。没建立前不得重构 live code。
**G1 / Truth & Observation Convergence**：把新 Evidence/Condition 作为唯一健康、Presence、可用性判定接口，消除配置伪在线与失效缓存全局误判。迁移测试：精确 Chat 未知不被声称 LIVE；本地 Core ready 不因外部 Edge stale 失去读写可用性；单次 timeout 不产生 Effect fence。
**G2 / Effect & Recovery Convergence**：收敛 Final Gate、Attempt、Host loss、Reconciliation 和 Adapter Inspect/Probe/Recover。做至少 Host timeout、TCP 抖动、流关闭、Host 确认退出、响应丢失、断电快照、重复消息、旧凭据迁移与 Token 重用等故障注入；每个疑似有副作用的操作不得重复，无法对账保持 UNCERTAIN。
**G3 / Product & Live Integration**：仅一个选择性开机启动入口、Core/Gateway/可选公网 Tunnel 的所有权可检验；三次冷启动与恢复、连续至少24h观测、真实 ChatGPT 已认证入站与至少一个已合法登录/授权的 Operator 完整原始结果回收；DSH/Codex 的能力边界有明确信息，未实现的主动 Cloud Chat 回程以 ACCEPTED_LIMITATION 明示，不得为绿灯伪造 E2E。

每项 `FIXED / ACCEPTED_LIMITATION / HUMAN_REQUIRED / UNRESOLVED` 标记必须附来源、源码版本、原始测试与观察记录。存在 material UNRESOLVED 时不得宣布 R1 Backend Convergence。

## 七、本轮必须阻止的外扩
不新建并行 supervisor 体系，不重新发明第二 History/Ω，不扩展新厂商与产品套餐代理，不加入元胞自动机或自主 Rule Evolution，不绕过 Human 登录/审批，不以临时 PowerShell/GPT 自动任务作生产关键路径，不认为重写整个源码或压缩文件数等于整体最优。

## 八、Codex 初步反馈与本轮裁决
Codex 在已记录的独立咨询中提出：单机模块化内核、证据范围/有效期、进程恢复不等于 Session 恢复、UNCERTAIN 不重发；它还指出 Codex `locate()` 会启动 app-server，DSH 宿主发现也可能触发进程行为，因此只读 Inspect 与 Recover 必须拆开。以上为**实际收到的中间意见**，不是它正式审核同意本文件。
GPT 裁决：采用上述整体边界与四个 Gate；可变的是模块内接口，不能变的是身份、主权、历史、授权与 Effect 不变量。“整体最优”只针对限定的 Windows 单机 R1 产品目标，无法声称对所有未来场景绝对最优。

**状态**：G0 设计草案已建立；独立 Codex 正式报告因模型工具超时尚未取得；没有运行正式修订或 Gate 测试。下一动作是对 G0 数据保护/回滚/验收清单完成审查，之后才进行 G1 的一次性语义替换。

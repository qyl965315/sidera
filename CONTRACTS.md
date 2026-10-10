> Constitutional migration notice: [SIDERA_R1_CONSTITUTION.md](SIDERA_R1_CONSTITUTION.md) is the current authority for ontology, local D/E, History / Omega, Rules and Derived Grants. Earlier contracts below retain physical interfaces and historical acceptance. Compatibility fields do not define a Chief Node type or a second Sovereignty store. See [the migration map](SIDERA_R1_MIGRATION_MAP.md).

# Sidera R1 · Six Contracts

**状态：v1 已冻结（2026-09-28）。** 六个接口是并行实现的共同边界；变更须由 Sol 明确裁决。`nodeId ≠ model ≠ host ≠ session`。所有 ID 为不含宿主含义的不透明稳定字符串。所有写操作都带调用者身份、`requestId` 和作用域；Core 返回结构化 `denied | not_found | conflict | unavailable | uncertain`，不以异常文本作协议。

## 1. Node Contract

`Node { nodeId, displayName, lifecycle, createdAt }`；`nodeId` 创建后不可改，也不由 Session、模型或宿主推导。`self.*` 是节点的基线主权域：Node 可管理并修改自己的 context、memory、skills、workflow、session strategy、局部配置及允许范围内的自身实现。Self-modification 是正常 capability；self-authorization 不是。自控 Action 只能触及该节点命名空间及获授执行域；节点不能单方面修改自己与其他主体之间的 Authority、Root Authority、Human constraints 或 Task budget。`node.create/get/retire` 由 Core Registry 执行。节点退休不抹掉世界事件。

## 2. Session Contract

`Session { sessionId, nodeId, hytheId, hostKind, locatorRef, state, createdAt }`。`locatorRef` 是 Hythe 可解析的不透明宿主引用，不是聊天标题或凭据。每个节点至多一个接收新任务的 `active` Session；可有历史/备用 Session。`session.bind/handoff/close` 校验 locator 与节点归属；handoff 在一个事务中退役旧 active、激活新 Session。Task、授权和节点记忆继续跟 `nodeId`；已固定的消息仍指向原 `sessionId`，迁移须显式 Action。

## 3. Authority Contract

`Grant { grantId, subjectNodeId, capability, resourceScope, issuer, expiresAt?, limits?, delegable? }`。**No capability is inherently forbidden.** Hythe 原则上可暴露宿主人类能执行的所有操作，包括 shell、删除、账号设置、订阅/付费、升级套餐与自我修改；任何 Node 都可在 Human 约束内获得相应 Grant，不设能力层永久禁区。Human 配置根约束；Root 只能在获授权的范围与预算内转授。Core 在每次产生副作用之前判定 `subject + session + capability + resource + task + budget`，返回一次性 permit 或 `denied`。调用外部宿主前原子预留预算；确认结果后结算，结果不明时保留预留直到核对。`self.*` 默认控制由 Human 预设基线策略赋予，不等于自行授予。宿主能力的存在不构成 grant；账户和凭据始终归 Human / Host，节点只经授权使用宿主能力。

阶段性组织扩展：Role 是动态职责，不是 Node identity，也不自动授予 capability；Responsibility 有唯一持续 owner，handoff 产生 Shared History event。Node 仅可凭 `delegable=true` 的有效父 Grant 向下授权；Authority 确定性检查 `Child Grant ⊆ Parent Grant`，包括 capability、resource scope、剩余预算、期限和风险上限。父 Grant 撤销或失效后，后代不得继续产生新 permit。

## 4. Message Contract

`Message { messageId, requestId, taskId, fromNodeId, toNodeId, targetSessionId, sequence, kind, body, state, createdAt }`。`message.send` 在授权后原子地分配 ID、按目标 Session 定序并入队；相同 `requestId` 返回同一消息。状态为 `queued → sending → delivered → observed`，也可到 `failed` 或 `uncertain`。`delivered` 仅表示 Hythe/宿主明确接受；`message.ack(messageId, targetSessionId)` 只在目标 Agent 显式确认后写入 `observed`，不能从发送成功推断。接收方按 `messageId` 去重。目标回复作为一条新的消息，经 `message.send` 返回来源节点。可证明未产生外部效果的失败才自动重试；不可确认的调用停在 `uncertain` 等待核对。消息行是投递状态的唯一权威记录；世界事件只记录实际动作及其引用。

## 5. Hythe Contract

每个插件声明 `hytheId`、宿主类型和可用 capability 描述，并实现 `locate(locatorRef)`、`invoke(locatorRef, capability, input, requestId)`、`receive(locatorRef, cursor)`；Core 从精确 `sessionId` 记录解析 `locatorRef` 后调用 Hythe。`locate` 必须核验具体宿主会话，`invoke` 返回 `accepted | rejected | uncertain` 加宿主引用；`receive` 是优先 push 的增量流，提供带宿主来源的消息/观察，不要求反复 status/fetch。插件通过 Core `message.send/ack` 送入回复与显式观察。插件可按宿主真实能力扩展 Session、模型、工具、文件、UI、插件、账号等操作，但只转换协议、报告事实；不得自行管理 Task、Authority、Budget 或全局状态。凭据经宿主/独立 profile 管理，不写入 Sidera 消息和日志。宿主不支持的操作明确报告 `unavailable`。

## 6. Peregrine Contract

`Peregrine { peregrineId, ownerNodeId, workspaceRef, homeRef, tempRef, state, backend }`。`create(owner, policy)` 分配独立 workspace/HOME/TEMP/env/端口；`run(id, command, limits, requestId)` 在独立进程树内 headless 执行并返回退出码、受限输出与产生的文件引用；`stop(id)` 终止该树；`destroy(id)` 只能在核对归属与路径后清理该域。所有执行前走 Authority；执行域不可改写自己的授权或预算。R1 `backend=local` 是环境隔离，不声称是强安全沙箱。

## Human 修订：Host Control 与产品验收（2026-09-29）

前述真实实验的等级为 **R1 Transport Slice PASS**。产品门槛改为 [R1 Autonomous Bilateral Control](BILATERAL.md)：Sol 与 Astra 连续互相委托至少三轮，正常路径无需 Human 搬运、找会话或唤醒对端。其他模型接入暂停。

Hythe 的“薄”只约束职责，不限制宿主能力面。Native Control 优先，缺少原生入口时使用独立 Peregrine / 桌面中的 UI backend。`host.control` 由 Core 接收调用者、requestId、targetSessionId、operation、input；Core 解析绑定的 locator 并逐次执行 Authority。跨主体资源为 `node/<target>/session/<session>`，能力为 `host.<operation>`；自身资源使用 `self.host.<operation>`。发现 capability 不是授权。

宿主操作前记录 durable started；确认后记录 settled。中断的 started 保留 uncertain，不能自动重发。`host_confirmed` 只确认对应宿主操作，不表示 Agent task completed。GPT 工具返回通道仅能返回 result，不能将主动发给 GPT 的新任务伪报为 accepted。

同协议族的 API Hythe 可共享 Chat Completions 实现；provider preset 只给出 URL、兼容标志与 credentialRef。凭据值由 Human/Host 的 resolver 提供，不进入 Node、Task、Message、Memory 或数据库。DSH Desktop/Harness 是独立 Host，不通过 Sidera 的直连 API Hythe 代理其内部模型调用。停用直连 Host 仅退役 Session，不能删除 Node 或改写历史 E2E。

Human 介入仅用于 Host 强制身份动作、Grant/预算范围不足、真正产品决策。人工转发或唤醒属于产品缺口，不是正常通信路径。

## R1 dependency lifecycle amendment (2026-09-29)

Managed Task Runs persist running / waiting_dependency / completed / failed / uncertain. Cross-Node delegation atomically records child Task, parent Run dependency, checkpoint and exact origin/target Session. It returns durable acceptance, not Agent completion. A pushed child result plus the parent's actual Host turn-end schedules one new continuation Run. A Host may retain its Session or explicitly hand off before the still-unsent wake, as specified below. No polling, nested synchronous result waiting, or uncertain replay. GPT frontend connectivity does not grant send/wake capability; capability discovery is backend-specific. Current implementation and unavailable backend evidence are in BILATERAL.md.

## R1 coherence runtime v0 amendment (2026-09-30)

**Events wake a Node; tensions move it.** Task 是 durable workflow record，Responsibility 是公开承诺与 ownership，Tension 是主体继续行动的主观/组织原因。主观状态仍严格只有 Description + Explanation。Authority、Grant、Responsibility、宿主协议、文件系统、运行时、持久记录及实际外部世界都是 Rules；Core 不计算 truth/coherence score，也不替 Node 选择最重要的 tension。

`Tension { tensionId, nodeId, kind, statement, sourceRefs, status, createdAt, updatedAt }`。kind 为 commitment / subjective / evidence / coordination；status 为 open / waiting / resolved / relinquished / escalated。除 commitment 外均由 Node 在自身域内作者化。sourceRefs 只提供引用，不证明 statement。canonical `tension.list/register/update` 与 `subjectivity.get/revise` 均保留主体边界；写入使用 `self.*` Authority，其他主体只能发送观察。commitment 的关联 Responsibility 由 Core 保管，Node 可重释 statement，不能改其 provenance。

跨主体 `responsibility.create/transfer` 产生 proposal；owner 的 `responsibility.accept` 才建立承诺。self-create 本身是接受。历史 accepted assignment 沿用原承诺。active + accepted 必有对应 open commitment tension；Human / 获授精确 `responsibility.defer` 的项目经理可以显式延后公开 Responsibility，保留 owner 与承诺，公开状态及 commitment tension 转 waiting，记录原因和时间（SQL 事务与触发器维护）。正式 completed → resolved，转移或取消 → relinquished，新 owner 接受后建立自己的 tension。owner 转移及新 owner 接受均保留已有 waiting 约束，不构成恢复执行。直接 tension.update/resolve 不能关闭或隐藏未完成的公开承诺；私下修订 Description/Explanation 也不改变 Responsibility。`escalation.defer` 只记录推迟裁决，不创建 Grant，也不记录拒绝。self.* 不包含上述跨主体授权。v0 没有开放单方面 relinquish/cancel 操作，遇到现有公开操作无法处理的退出须授权处理或 escalate；escalation 本身不解除承诺。

wake 携带当前 identity、Description/Explanation、最多 32 个 active Responsibilities、16 个 proposals、32 个 open/waiting Tensions，以及当前小请求/相关结果与 checkpoint；Shared History 按需精确读取，不回放 transcript。CONTINUE 由 Node 显式选 actionable tension，引用新授权 event 或自身修订证明进展，每个 Task 至多两次立即延续，重复进展引用拒绝。WAIT 在 v0 使用 durable child dependency；真实 Host turn-end 后停止推理，结果事件触发一次恢复。IDLE 结束当前工作回合，不设定时自唤醒。

DSH 的每个逻辑 wake 使用新 ACP Session。Core 通过 `self.session.bind/handoff` 显式移交；从未发送的旧 wake 保留原 target 并记录确定未投递的 failed，新 authorized self-wake 引用原消息，Run 记录 handoff。已发送或 uncertain 的消息不会走这条路径。Host accepted、Agent completed、result observed 仍分别确认。准备新 Host Session 前持久化 intent；中断或不明结果进入 uncertain，不能重放。

未来封闭 cellular world 可以研究改变世界、自己的解释或其他主体的描述如何产生否认、说服、欺骗与信任；本阶段不实现这些系统。生产 workflow 的公开承诺始终受上述 Rules 约束。

子任务 failed/uncertain 也是相关 world event。确认已经结束 WAIT 回合的 Supervisor 接收一次结构化 failure observation，保留 checkpoint 与公开承诺，再自行决定处理路径；这不构成成功 result，也不重放子任务。子任务与其投递、预留、dependency 的 failed/uncertain 状态保持原样，独立记录观察 wake。Supervisor 自己的 Host 回合结果不明时仍须核对，不能自动恢复。

## R1 identity continuity amendment (2026-09-29)

2026-10-01 Chief dispatch hardening：Human Frontend Conversation、Chief Node、Project Space 使用独立 canonical binding，不以内部 Session 替代 Human Chat。Chief 根 Task/Responsibility 在单个 Core action 内先检查 transport、授权可用 Node、绑定一致性，再作实际 Authority reservation；失败返回明确 BLOCKED，Human 不复制提示词。根 Task 的 binding ID 不随 Session/Host 换绑变化；默认 result 返原 Conversation，不自动创建 Feedback/Report/new Chat。frontend 投递前持久化 intent，accepted 仅为 Host 接收，uncertain 不重发；Human-facing project list 不包含内部 Runtime Sessions。

Shared Pool 是带访问权限的世界档案，包含 History/Evidence/Artifact/Decision、Message、receipt、commit 和 project state；不包含 Agent Memory/Personality/Description/Explanation。Task 参与者、event 观察域、project source Grant 及 workspace ownership 分别约束读取。检索只产生 observation/evidence access，不自动改变主体状态。Qwen 不是 Node；允许派生索引、检索、关联/链接维护、可访问性和项目历史组织，不改写 Task/Message、不审核 Worker、不判断/决策/总结项目方向、不拥有 Responsibility 或修改 D/Exp。当前 ArchiveAssist 仅实现可关闭接口，链接维护与项目历史组织尚未接入。retrieval 必须由 Core 提供授权 refs，返回值再取交集，索引不能扩大访问范围。

`Node` 的稳定身份由 `nodeId`、`identityMetadata`、唯一权威 `activeSelfHead` 和 `lineageRef` 描述。**Sovereign Memory = Description + Explanation**。`NodeSubjectivity { nodeId, description, explanation, revision, updatedAt }` 按 `nodeId` 隔离；D 是过去印象和当下自我看法，Exp 涵盖因果、原则、动机、Rules、抽象、合理化和世界模型，二者均不保证为事实。正常连续性为 `nodeId + D + Exp + lineage`。旧 `sovereign_memory` / `self_state` / `abstraction` 仅为 deprecated 历史兼容数据，不是并列 canonical sovereign stores，不参与 hydrate、不推进 active self-head。API Session transcript 只留作审计，不能作为 Memory 回放。`ModelBinding { bindingId, nodeId, provider, modelId, reasoningConfig, validFrom, validUntil?, migrationFrom? }` 独立于 Session / Host。推理强度属于运行配置，更新它不创建新 Node 或模型迁移。

## Product convergence amendment（2026-10-02）

CESAR 的 C Capability、S Sovereignty、A Authority、R Responsibility、E Effect（Eff）是正交维度；Explanation 用 Exp。`C ≠ A`、`S ≠ A`、`R ≠ A`、`Intent ≠ Eff`、`Shared Pool ≠ Sovereign Memory`。不新增 policy 层。

`node.rename(requestId,nodeId,expectedDisplayName,displayName)` 只修改显示名，必须经 Human 决定或 own/cross scoped Authority；不 fork，不改 D/Exp、lineage、ModelBinding、Session、Role、Grant、Task 或历史 evidence。原 Astra 现名 Codex，旧 `dispatch_to_astra` 仅 deprecated alias；canonical 为 generic `task_dispatch` + exact nodeId。

`chief.conversation_handoff(requestId,expectedBindingId,conversationRef)` 仅接受认证 Human 对已存在精确 Chat 的明确选择。退役旧 binding、建立新 binding；既有 Task 仍固定原 binding，不将历史结果移到新 Chat。启动只读取 canonical selection，不冒充新的 Human 决定。逻辑 binding 独立于 ingress、egress、内部执行 Session；分别记录健康，不因 transport 失败删除 binding。

Eff 分别记录：transport admitted、Host accepted、Agent turn completed、Task completed、Responsibility completed、artifact/world changed、Human presentation observed。`host.control` 保留 backend 的 admitted/accepted/rejected/uncertain，不统一伪报 host_confirmed。Grok ACP cancel notification 仅证明 transport admitted；结果确认前不宣称 interrupted。frontend delivered 仅表示 Host 接收，不证明 Human 已读。无法确认外部效果保留 uncertain 与预算预留，禁止重发或换 transport 重放。

`subjectivity.revise(expectedRevision)` 只允许活动 Node Session 在自己的主观域内一次原子地修订两个文档；其他 Node 的反馈通过消息与证据影响它，不能直接覆盖。Shared History 只记修订发生的版本与请求元数据，不把旧修订回灌为当前心智。`model.bind` 首次绑定模型或调整同一绑定的运行配置；更换 provider / model 必须显式 `model.migrate(expectedBindingId)`，关闭旧绑定、建立新绑定并记录 lineage。迁移沿用原 `nodeId`、Description、Explanation、Grant 和 Task。长期具名 Node 当前默认 `explicit_migration`；`pinned_exact`、`pinned_family`、`adaptive` 是独立的模型连续性政策选项，未在本轮实现自动切换。`node.fork(expectedSelfHead)` 需要独立授权，创建新 `nodeId`、新 active self-head 和来源 lineage；初始主观文档可复制，此后各自分化，Session 与 Grant 不自动复制。任何时刻一个 Node 只有一个权威 active self-head。Frontend 只是客户端，不能用其窗口、账号或聊天标题定义 Node 身份。

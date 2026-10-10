# Sidera R1 · Vision

**状态：R1 设计方向已批准；六个 Contract 冻结为 v1。** Sidera 是独立、可无前端运行的多 Agent 调度平台。每个 Node 是稳定的自主主体；Session 只是它在某个宿主上的运行容器。Core 负责定位、通信、调度、授权和记录共同世界中的事实，不替 Agent 思考。

## 不变量

- 身份、任务、权限和节点自己的 Sovereign Subjectivity 跟随 `nodeId`；宿主会话标题不构成身份。
- Node 身份、Model Binding、Session / Host 与 Frontend 各自独立。一个 Node 同时只有一个权威的 active self-head；换模型或调整推理强度不改变 `nodeId`、Description、Explanation 和既有任务。两个独立的自己同时继续运行须显式 fork 成新的 `nodeId`。
- `self.*` 是节点的基线主权域。节点可管理自己的 Description、Explanation、技能、工作流、会话策略、局部配置和允许范围内的自身实现；自我修改不等于自我授权。
- No capability is inherently forbidden. Hythe 原则上可暴露宿主人类可执行的全部能力；是否可调用只由 Authority 的范围、期限、预算和可转授性决定。节点没有账户，账户与凭据属于 Human / Host。
- Hythe 暴露宿主真实能力并转换协议；能列出能力不等于获准调用。
- 跨主体的影响只能通过经授权的 Action、消息和可观察的世界事件发生。一个节点知道某事，不代表其他节点知道。
- 每项状态只有一个权威来源；能计算的视图不再持久化。一次用户动作原则上对应一次 Core RPC。
- Human 永不充当 Agent 消息搬运层。Chief 派发不可用时明确报告 transport/binding 状态；不要求复制提示词、手动唤醒或另开反馈 Chat。结果回原 Chief Conversation，内部 Session 是 Runtime Resource。
- 开发、测试和运行使用独立仓库、profile、数据与 Peregrine；旧 AI Studio / Studio+ 不是运行时依赖。

3S 是 **Shared History、Sovereign Subjectivity、State Co-construction**。Shared History 保留系统与世界的证据，不自动成为节点的经历。**Sovereign Memory = Description + Explanation**。D 是过去印象与现在的自我看法；Exp 是连接这些描述的解释结构，涵盖因果、原则、动机、Rules、抽象、合理化和世界模型。两者由 Node 自己修订，均不保证事实正确。正常连续性为 `nodeId + D + Exp + lineage`；唤醒读取当前主观状态、责任和 tension，需要核实时按授权查询档案，不靠 transcript replay、全量聊天或 Shared Pool summary。

CESAR 是五个正交维度：**C Capability、S Sovereignty、A Authority、R Responsibility、E Effect (Eff)**；Explanation 简写 Exp。`C ≠ A`、`S ≠ A`、`R ≠ A`、`Intent ≠ Eff`、`Shared Pool ≠ Sovereign Memory`。它不是五步流水线。Shared Pool 是带访问权限的世界档案；Qwen 只提供索引、检索、关联/链接维护、可访问性及项目历史组织，不拥有 Node 身份或 Responsibility，不作判断或修改 D/Exp。

2026-10-02：原显示名 Astra 的 Node 改名为 **Codex**，保留 `nodeId=7dfcccd5-dbd0-4017-afbb-c3f725b2c7ad` 和全部主体/世界连续性。Host 为 Codex app-server；本次核对实际 ModelBinding 为 `openai / gpt-6-astra / medium`，Role 按实际 appointment 独立记录。历史 Astra 原文不改写。

## R1 成功条件

一个 chatbot 经自己的 Hythe 发起任务，Core 精确定位另一个节点的 Session 并授权投递，目标 Agent 在独立 Peregrine 内完成真实工作，结果经 Core 返回原 chatbot。重启后身份、授权、任务、消息和世界事实仍正确；自控和越权尝试有可验证结果。先在自有机器、账户和节点上做三轮封闭测试，不公开 Beta。

R1 不继承旧 Studio 的 Chat/Work 产品分层、固定公司表单流程、复杂状态投影或跨进程状态探测链；下一阶段使用可变的 Role、持久 Responsibility 和可转授 Grant 组织真实工作，但不建立固定组织图或中央 AI 调度。也不做人格/意识判定、模型内部学习或完整 OS 安全沙箱。可选邮箱式前端只是 Core 的一个客户端；窗口、聊天视图和登录身份均不定义 Node 身份。

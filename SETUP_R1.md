# R1 本地设置与工作

1. 安装 Node.js 24 或更新版本，解压候选包，双击 `Start-Sidera.cmd`。无需运行 PowerShell，依赖和前端已随 Windows 候选包附带。
2. 在 Setup 声明 Human。创建身份不会授予 Authority，也不代表任何第三方账户登录。
3. 安全停止 Core 后配置外部 MCP Node，或使用 API Host 表单填写 provider、HTTPS base URL 和 `env:VARIABLE_NAME` 凭证引用。API secret 必须由本机启动环境提供；浏览器不收集或返回 secret 值。
4. 审查完整权限包和精确 statement，手动输入显示的确认文本。未确认、取消、过期或被修改的审查都不能授予权限。
5. 选择已经存在的精确 Human conversation。替换绑定调用 canonical Chief handoff，固定旧 binding；不会猜测当前 Chat URL、创建 Chat 或执行浏览器回程。
6. MCP 回程表单需要精确 binding、endpoint、环境 secret reference、真实 `conversation.locate` / `conversation.send` tool 名称。只配置适配器，不发送、不认证、不建立 Presence。相同 route 的替换保留高级操作，避免重置已有 route/Effect 证据。
7. Native 回程只有启动环境同时提供真实 `SIDERA_CODEX_APP_TOOLS_SERVER` 文件和 `CODEX_THREAD_ID` 时才可配置。安装和 Host 登录由 owning Host 完成；文件存在本身不是已验证回程。
8. 启动 Core，查看分别报告的 LOCAL_READY 与 FULL_ROUTE_READY。然后从 Home 的 New Work 入口保存原样意图或提交一次。未知结果需检查原始请求，不自动重试。

LOCAL_READY 表示 Core 实际报告本地运行可用，可监测；不要求伪造外部回程。FULL_ROUTE_READY 还要求 canonical Chief admission 返回 available：精确 Human Presence、可用非浏览器 route、授权和可执行 Node 等条件全部满足。配置不等于发现、不等于认证、不等于可达、不等于 Presence。

当前 ChatGPT 产品没有为 detached Core 提供真实可用的主动回程时，这是 R1 的外部限制。本地配置、监控、意图保存和故障核对仍可使用；需要回程的工作仍保持 blocked。

## Adapter 范围

| Host | R1 普通设置 | 保留高级操作的原因 |
| --- | --- | --- |
| external MCP client | 有界 edge ID 和精确 locator | 入站边界没有主动执行能力；外部产品仍需实际连接，凭证仅本机保存 |
| OpenAI-compatible / DeepSeek API | 有界 provider schema，HTTPS/loopback URL，环境引用 | 不制造 ModelBinding；真实模型绑定和 account admission 仍需 canonical verified identity enrollment，不能从用户输入模型名推断 |
| Codex app-server | 高级 | factory 要求真实 executable、独立 home/temp/CODEX_HOME、workspace 和模型；新配置还要求已验证 ModelBinding。普通安装发现、独立登录和 verified identity 的整体闭环未实现，不能将一个 executable 输入包装成 ready |
| DSH harness ACP | 高级 | 同时需要官方 executable、版本匹配 cliEntry、独立 dshHome、workspace、MCP entry 和真实 ACP locator；固定 adapter Hythe ID 还不支持任意多实例配置。没有稳定有界安装发现/隔离登录合同 |
| Grok Build ACP | 高级 | 需要真实官方 executable、home/workspace、MCP entry 和既有 ACP Session；不能暴露 fixture launchArgs 或把新进程当成已认证 Session；固定 Hythe ID 约束多实例 |
| Antigravity / Gemini Agent | 高级 | prepare 会修改 owning Host 的 settings/permissions，默认使用用户全局安装配置；未有普通 Human 审查和受支持安装/隔离策略，不能安全泛化为新 Node 表单 |
| ZCode / GLM | 高级 | 依赖版本固定的官方本机 service、SDK 文件和 connection 文件，真实 Session/model 从 SDK 观察；任意 SDK path 是代码加载入口，不开放普通文件 picker |

## 生命周期

安全 rename 已产品化：Human 精确审查 → 显式确认 → `identity.renameNode`，使用 expectedDisplayName 比较，保留全部身份和历史。Setup 读取 canonical 名称，RuntimeSpec 旧标签不覆盖它。

Registry Session bind/handoff、Node retirement 和 Host replacement 仍需要真实 Node actor/session、request ID、授权、locator 验证以及 open work 核对。现有 Registry API 不能接受 Human actor，设置页不冒充 Node，不编辑或删除 RuntimeSpec 行模拟生命周期。安全停止后新增独立 Host 是配置操作；已有 Host 重配置/替换保留高级流程。

这是 local operator ingress：same-origin、strict schema、精确审查、policy epoch 和一次性确认阻止 Node bearer 或跨站请求静默触发 Human admission。具备完整本地操作系统/浏览器控制权的程序仍处于本地 operator 信任边界内；本产品不宣称网页能密码学证明物理 Human 点击。

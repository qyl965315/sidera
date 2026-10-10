# Sidera Desktop：产品动作与标准接口映射

日期：2026-10-06。实现入口：`ui/src/App.tsx` → `ui/src/ProductApp.tsx`。下表中的接口名供开发与审查使用；普通页面不显示这些名称。

## 导航与信息层级

主导航为窄图标栏：工作、节点、集成、状态、设置。权限位于设置 → 安全与权限；首页已移除。

| 页面 | 普通内容 | 主动作 | 精确记录位置 |
| --- | --- | --- | --- |
| 默认工作面 | 最近访问工作；无工作时显示目标输入 | 开始 | 工作 → 高级详情 |
| 工作 | 标题、目标、进展、成果、参与节点、底部输入；可收起的置顶 / 最近列表 | 开始 / 更新目标 | 工作 → 高级详情 |
| 节点 | 用户名称、产品、模型待验证、对话记录、状态 | 打开对话 / 重新检测 / 设置 | 节点行 → 高级详情 |
| 集成 | Codex、DeepSeek、Grok、Gemini、GLM、DSH、MCP 紧凑列表与选中服务详情 | 添加 / 管理一个服务 | 聚焦窗口 → 高级详情 |
| 权限 | 授权记录、未撤销记录数量、按用途解释 | 修改权限 | 查看详情、确认窗口、高级详情 |
| 状态 | 运行服务、MCP、消息回程、配置、异常 | 重新检测 | 各节高级详情、近期记录与诊断 |
| 设置 | 常规、安全与权限、更新、数据与诊断、高级 | 各节一个明确动作 | 高级 → 开发者与诊断 |

能力目录、标识、原始运行记录、回程映射、恢复限制不进入主导航。旧地址保留兼容跳转语义，展示新的产品页面；没有旧管理页面的第二套入口。

## 动作映射

所有 POST 均使用既有的同源本机 `/api/setup/` 固定端点。服务端字段校验、权限判断、Human 确认、停止约束没有改写。

| 原操作 / 标准语义 | 中文产品动作 | 英文动作 | 可达路径 | 实际动作与限制 |
| --- | --- | --- | --- | --- |
| onboard / declare Human | 确认身份 | Confirm identity | 设置向导第 3 步；设置 → 常规 → 添加身份 | `human`；声明本机身份，不推断第三方账号或授予权限 |
| admit reviewed Human act | 我已审查，批准 | I reviewed and approve | 每个审查动作的确认窗口 | `confirm`；原确认文字、十分钟期限、配置指纹与策略校验仍有效；桌面还要求原生批准 |
| permission profile | 修改权限 / 审查并应用权限 | Change permissions / Review and apply permissions | 权限；设置向导第 4 步 | `profile-review` → `confirm`；三档用途保留，只读为默认 |
| provision | 应用已批准权限 | Apply approved permissions | 权限 → 当前权限 | `provision`；只应用已准入的精确权限包；桌面原生确认保留 |
| config-check | 检查配置 | Check configuration | 状态 → 运行控制 | GET `status` 中的既有 `checkConfiguration` 结果；不会启动服务或建立登录状态 |
| core start | 启动 Sidera | Start Sidera | 状态；设置向导完成步骤 | `core-start`；已有监听器不会被替换；请求启动不等于运行已确认 |
| core stop | 停止 Sidera | Stop Sidera | 状态 → 运行控制 | `core-stop`；活动工作和未知停止结果仍阻止关闭 |
| host detect / refresh | 重新检测 | Detect again | 节点、集成、状态、陈旧读取提示 | GET `status`、`desktop-management`、`r1/snapshot`；读取已有配置和来源观测，不声称扫描到或登录了任意产品 |
| add / configure executable host | 添加服务 | Add service | 集成 → Codex / Grok / Gemini | `executable-host`；固定官方程序与结构化字段；安装和隔离配置折叠；无 shell、任意参数或 JSON 编辑器 |
| configure DeepSeek | 添加服务 | Add service | 集成 → DeepSeek | `api-host`；名称和服务地址；本机凭证引用位于折叠详情；不返回密钥 |
| configure compatible API | 保存服务 | Save service | 设置 → 高级 → 兼容服务配置 | `api-host`，固定 `openai-compatible-api` 模式；既有能力保留 |
| declare external MCP client Node | 连接外部对话 / 添加服务 | Connect external chat / Add service | 集成 → MCP | `node`；普通输入为名称和已有 HTTPS 对话链接；内部生成连接标识和声明位置；高级可保留原精确连接字段；不创建或验证外部对话 |
| bind Chief | 连接主对话 / 审查连接对话 | Connect main chat / Review chat connection | 向导第 5 步；主节点 → 设置 | `chief-review` → `confirm`；使用已有对话链接与既有绑定语义 |
| handoff Chief | 切换主对话 / 审查切换对话 | Switch main chat / Review chat switch | 主节点 → 设置 | `chief-review` 携带当前 `expectedBindingId` → `confirm`；不改变 Presence 或推断回程可用 |
| rename Node | 修改名称 | Rename | 节点 → 设置 | `rename-review` → `confirm`；保留原名称预期值、身份、会话、历史 |
| navigation reference | 设置对话快捷入口 | Set chat shortcut | 任意节点 → 设置 | `navigation`；只有 ChatGPT / Grok 支持的精确 HTTPS 对话链接；这是导航元数据 |
| add MCP return route | 添加 MCP | Add MCP | 集成 → MCP | `route`；目标对话用友好名称选择；提供方工具映射与凭证引用折叠；保存不调用工具或验证送达 |
| installed native route | 使用已安装的本机连接 | Use installed local connection | 添加 MCP 窗口 | `native-route`；真实本机上下文缺失时禁用，服务端继续严格验证 |
| enable / disable integration | 启用 / 停用 | Enable / Disable | 集成 → MCP → 结果服务开关 | `mcp-change`；Core 必须已停止且没有活动工作依赖 |
| remove integration | 移除服务 | Remove service | 集成 → MCP → 移除确认窗口 | `mcp-change` 的 `remove`；保留历史，原活动工作约束有效 |
| health | 检查连接 | Check connection | 集成 → MCP → 结果服务 | `mcp-health`；只初始化并列举工具；不执行工具，不自动重试 |
| open chat | 打开对话 | Open chat | 节点行 | 既有 `sideraDesktop.openChat`；由主进程读取已记录引用并校验产品、域名、路径；缺失时禁用 |
| new work | 新建工作 / 开始工作 | New work / Start work | 首页、工作 | `intent`，`submit:true`；字面目标不翻译；同一表单最多提交一次，未知结果锁定 |
| capture goal without dispatch | 保存目标 | Save goal | 新建工作 | `intent`，`submit:false`；本次保存后锁定表单，不伪装成任务完成 |
| revise intent | 修改已保存目标 | Revise a saved goal | 工作；工作详情 | `intent-revise-review` → `confirm`；仅选择当前身份拥有的目标；携带精确父修订，不创建工作或重放 |
| revoke permissions | 撤销权限 | Revoke permissions | 权限 → 当前权限 | `revoke-review` → `confirm`；独立明确 Human act，填写原因，保留历史 |
| uncertain / effect reconcile | 处理异常 | Resolve issue | 状态；不确定工作详情 | `reconcile-review` → `confirm`；友好结论选项映射原枚举；来源事件标识与原记录在高级详情；原请求不重放 |
| local port configuration | 保存端口 | Save ports | 设置 → 高级 → 运行端口 | `config`；端口范围、冲突与停止服务约束不变 |
| update check | 检查更新 | Check updates | 设置 → 更新 | 既有桌面 `checkUpdates`；没有更新来源时明确禁用 |
| update download | 下载并验证 | Download and verify | 设置 → 更新 | 既有 `downloadUpdate`；元数据与 SHA-256 约束不变 |
| update install | 停止并安装 | Stop and install | 设置 → 更新 | 既有 `installUpdate`；再次检查哈希、原生确认和安全停止；不推断发布者身份 |
| diagnostics | 检查桌面状态 / 导出诊断 | Check desktop status / Export diagnostics | 设置 → 数据与诊断 | 既有诊断 IPC；导出只保留允许字段，不带凭证或服务内容 |
| open data | 打开数据目录 | Open data folder | 设置 → 数据与诊断 | 既有固定本机目录 API，无任意路径或命令入口 |
| browser fallback | 在浏览器打开备用界面 | Open browser fallback | 设置 → 高级 | 既有 `openFallback`；正常桌面没有 localhost 地址或浏览器概念 |
| owning-product guide | 打开官方安装与登录引导 | Open official setup and sign-in guide | Codex / DeepSeek / Grok 服务窗口 | 既有固定官方地址 allowlist，不接收任意 URL |

## 仍然需要所属节点或外部产品的动作

`session.handoff`、`node.retire`、模型身份核验和 Host replacement 的既有权限主体是经过认证的节点。Human 的本机配置身份不能代替它。高级目录继续显示精确名称、主体、来源、不可执行原因和相关操作入口。

GLM / DSH 的自动安装、登录和 SDK 安装没有可安全调用的既有本机契约。卡片提供聚焦限制说明、已有配置观测与高级入口，不显示虚假的可执行安装按钮。

## 已核对的保持项

- 原固定后端 POST 路由均仍有对应产品动作；没有 generic RPC 或命令执行面。
- 195 项能力目录仍可搜索、只读查看，Node 专属项不被包装为 Human 可执行动作。
- 部署来源、身份、权限、安装、认证、可达性、消息回程分别判断；配置不成为连接成功。
- UI 双击提交和未知传输测试只发出一次 `intent` 请求。原生拒绝、活动工作退出阻挡和更新阻挡由打包后的真实代码验证。

## 工作底部输入与来源

`taskIntentLinks` 只读关联来自同一世界的 `task_bases` 与 `intent_revisions`。有来源时使用关联目标的当前修订；缺少来源时要求明确选择。输入以补充内容追加到原目标，走原 `intent-revise-review` → `confirm`；不会宣称已向运行中的节点发送消息或自动继续执行。批准前不修改原目标，未知结果不重试。

置顶、最近访问和列表展开状态保存在本机界面偏好，不构成后台工作状态。

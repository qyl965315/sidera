# Sidera Desktop UX 重设计报告

日期：2026-10-06。最终裁定：**UX_RELEASE_READY_WITH_LIMITS**。状态：新的本机候选已打包，**未发布**。

## 结果

生产桌面从管理表单堆叠改为动作入口。主侧栏缩为首页、工作、节点、集成、权限、状态、设置；每项常见操作对应按钮、开关、聚焦窗口或设置步骤。标准后端入口、权限主体、精确绑定、Human 批准与未知结果边界保留。

界面采用独立设计的浅色工作空间、柔和绿色强调、清晰字号层级、有限内容宽度和紧凑状态标签。首页只突出“新建工作”，节点使用行布局，集成使用七张简洁卡片。配置窗口一次只管理一个服务；权限声明、JSON、标识和技术目录采用逐层展开。

普通桌面不出现 localhost、演示选择器、R0.2 / CANONICAL / READ ONLY 开发标签、PowerShell 指令或全面展开的后端清单。启动页也已改为中文。Windows 原生标题栏保留 Sidera 名称。

## 首次使用与操作可达性

首次使用为六步：欢迎 → 添加服务 → 确认身份 → 应用权限 → 连接主对话（可跳过）→ 完成。每步只有一个主按钮。设置完成后的启动进入首页；缺少节点、身份或已准入权限的环境仍进入向导。

外部对话普通配置只需服务名称与已有 HTTPS 对话链接。连接名称和声明位置在内部生成；原精确字段保留在高级连接详情。此处仅声明，不验证外部登录、创建对话或建立 Presence。

所有旧 Human 本机操作保留具体入口，包括权限应用 / 撤销、身份创建、节点重命名、绑定 / 切换主对话、导航快捷入口、服务声明、MCP 配置 / 健康 / 开关 / 移除、目标保存 / 提交 / 修订、异常核对、运行端口、运行启动 / 停止、更新和诊断。完整逐项关系见 `UI_ACTION_MAP.md`。

精确权限批准文字只在确认窗口出现，服务器十分钟时限、配置指纹、策略修订和原生批准仍有效。原生拒绝仍阻止写入。节点自己的会话替换、退役和身份核验仍需所属节点授权，不被重新包装成 Human 通用执行按钮。

## 变更范围

| 文件 | 作用 |
| --- | --- |
| `ui/src/App.tsx`、`ui/src/ProductApp.tsx` | 新生产入口、动作界面、七页架构、向导、聚焦窗口、双语文案、逐层证据 |
| `ui/src/product.css`、`ui/src/styles.css` | 新桌面视觉体系与尺寸适配 |
| `ui/package.json`、`ui/scripts/ux-smoke.mjs`、`ui/scripts/smoke.mjs` | 新 smoke 与旧命令兼容入口 |
| `ui/scripts/localization-coverage.mjs` | 中英文源文案覆盖检查 |
| `desktop/main.cjs` | 原生提示按产品语言显示；测试专用独立 Electron profile；已完成设置的启动入口 |
| `desktop/worker.ts`、`desktop/startup.html` | 既有状态决定首次入口；中文启动页 |
| `desktop/installer.cjs` | 可指定新的候选目录，仍 `publish:'never'` |
| `desktop/ux-visual.mjs`、`desktop/ux-packaged-smoke.mjs` | 本机视觉、首次使用、打包安全和重启验证 |

没有修改 Core 权限、Registry、Effects、RPC、Host adapter、Human admission 或工作分派语义。没有增加 shell、任意命令、任意 RPC、任意 JSON 编辑器或绕过服务端确认的 IPC。

## 验证结果

Windows 使用 `npm.cmd` 执行相同 npm scripts，避免本机 PowerShell 对 `npm.ps1` 的执行策略限制。这是开发验证方式；产品不向 Human 提供控制台步骤。

| 检查 | 结果 | 证据与实际范围 |
| --- | --- | --- |
| `npm run check` | PASS | 根 TypeScript 检查 |
| 完整 `npm test` | **266 / 266 PASS** | `desktop-evidence/ux-backend-tests.txt`；约 16.77 秒完成，无失败、跳过或取消 |
| UI build | PASS | UI TypeScript + Vite；最终 JS / CSS 产物与候选一致 |
| UI smoke | PASS | 七项导航、六步设置、十个路径、七个聚焦集成窗口、双语切换、默认信息层级 |
| localization coverage | PASS | 390 处成对字面量调用；54 个既有字典键；拒绝遗漏语言和乱码 |
| `npm run desktop:test` | **13 / 13 PASS** | 精确打开 allowlist、IPC 来源、preload 边界、更新完整性、停止阻挡、诊断脱敏、安装脚本约束 |
| 既有 read projection boundary smoke | PASS | 本地 fixture，保持未知执行状态与 Effects 的证据边界 |
| Electron 视觉与首次使用 | PASS | 18 张截图；1024×768、1280×850、1440×900 内容尺寸；无横向溢出、无 Renderer 异常 |
| 打包后的隔离 smoke | PASS | 新目录复制候选、全新私有数据、真实本机运行启动与停止、原生拒绝、消息打开校验、停止后界面、重启持久性 |
| 一次提交与未知结果 | PASS | 同一工作按钮双击只发出一次请求；模拟未知传输后提交与保存均锁定，无自动重试 |
| 默认视图技术信息审计 | PASS | 已渲染 / 已加载视图中没有 UUID、标准操作名、原始 JSON 或 PowerShell 指令 |
| 高级证据可达性 | PASS | 原标识、读时间、状态、原结果、原错误、会话 / 运行 / 依赖和只读能力目录仍可查看 |
| 候选打包隐私扫描 | PASS | 初次便携打包 3647 个文件，未带私有 runtime / SQLite / 日志 / 密钥；最终交付有完整 SHA-256 清单 |
| Windows 安装包构建 | PASS | NSIS 构建；不启动安装器，不发布；签名实际检查为 `NotSigned` |

受限进程沙箱中的 Chrome / Electron 首次尝试遇到 Windows profile / AppContainer 访问限制。之后仅为用户明确要求的本机测试使用获准的非沙箱执行；没有更改 ACL、关闭 Renderer sandbox 或降低应用隔离。成功的完整套件与桌面结果来自这些实际完成的运行，不使用先前基线数字代替本轮结果。

## 视觉审查

18 张 Electron 截图逐张查看了导航、空状态、中文 / 英文卡片、节点行、权限页面、批准窗口、设置、目标输入、状态、高级记录，以及有工作 / 等待 / 不确定结果时的布局。

关键文件位于 `desktop-evidence/ux/`：

- `home-1280.png`、`home-1024.png`、`home-1440.png`
- `setup-welcome.png`、`permission-review.png`
- `integrations.png`、`integrations-english.png`、`deepseek-dialog.png`
- `nodes.png`、`permissions.png`、`status.png`、`settings.png`、`new-work.png`、`advanced-evidence.png`
- `fixture-home-1280.png`、`fixture-home-1024.png`、`fixture-work.png`、`fixture-task-uncertain.png`

`fixture-*` 使用测试专用 HTTP 读取拦截，只为检查有内容的布局，**不是实际工作完成、外部模型调用或回程可用的证据**。产品没有示例切换入口。

打包后的已加载状态截图为 `desktop-evidence/ux/packaged/desktop-status.png`。它分别显示本地已就绪、MCP 可连接、消息回程尚未就绪；没有把传输可达性提升成完整结果送达。

## 安全与证据边界

打包 smoke 实际验证了 native gate 的拒绝、Core ready、身份和绑定持久性、精确外部链接 allowlist、Renderer 不可访问 Node / require、状态和诊断不泄露凭证、活动回合阻止退出与更新、原 Core owner 保留、空闲时安全退出以及重启恢复。

但批准响应由测试驱动合成；活动回合由测试写入的持久化 fixture 提供；更新来源和下载在内存中模拟；外部打开行为被拦截。没有外部聊天发送，没有第三方账号登录，也没有真实模型完成或 Human 观察的声明。

超过 60 秒的工作读取用简短刷新提示显示。它是本地时间提示，没有新增后端轮询、恢复循环或自动重试。

## 限制与最终裁定

**UX_RELEASE_READY_WITH_LIMITS** 适用于这个本机 UX 候选，不能解读为全部外部模型、消息回程、安装平台或公开发布已通过。

1. 第三方安装 / 登录仍在所属产品完成；GLM / DSH 自动安装与 SDK 配置没有安全既有契约，因此提供明确限制而非假按钮。
2. Codex / Grok / Gemini 的安装和隔离目录，MCP 提供方映射及本机凭证引用仍需在聚焦窗口的详情里配置。普通工作不需要理解它们，但首次接入这些服务仍依赖准确的产品侧配置。
3. 当前本机读接口没有足够模型身份证据，节点显示“模型待验证”，不把配置字段当成经过核验的模型。
4. 消息回程仍未在本轮外部产品上完成真实验证；截图和 smoke 如实显示尚未就绪。
5. 安装包未签名，仍使用当前 Electron 默认程序图标；没有配置或发布更新来源。
6. 验证在同一 Windows 机器的独立测试 profile / 数据目录完成，未进行全新 OS / VM 安装、实际安装器运行或全部 DPI / 辅助技术认证。
7. 静态启动页默认中文；持久英文在产品界面载入后恢复。技术标准声明、Advanced 目录及原证据保持原文。

## 交付

新候选目录：`candidates/desktop-ux-20261006/`。

- 安装包：`Sidera-0.1.0-ux-x64-setup.exe`
- 便携启动：`portable/Sidera.exe`，必须保留同目录的全部 resources
- 候选说明、三个审计文档、`UX_CANDIDATE_MANIFEST.json` 与 `SHA256SUMS`

旧候选未覆盖，用户已有 runtime / 身份 / 凭证 / 外部会话没有迁移或写入。新的候选未发布，安装包没有被执行。

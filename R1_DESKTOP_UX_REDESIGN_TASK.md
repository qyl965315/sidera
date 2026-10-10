# Sidera Desktop UX Redesign — CLI actions become product controls

Human product correction:
The current frontend is visually poor, over-technical, mixed-language, and has regressed into an admin/config dump. Redesign it around the same PRODUCT PRINCIPLE seen in mature desktop companions to CLI tools: the desktop app should turn canonical CLI/admin actions into clear buttons, menus, dialogs, and guided flows.

Important: do NOT copy another product's proprietary visual design pixel-for-pixel. Copy the interaction principle:
CLI command semantics -> one intentional GUI action.
The Human should not need to understand commands, JSON, IDs, RuntimeSpec, RPC names, or raw adapter fields during ordinary use.

Workspace:
D:\Sidera-R1-v0.1.0

Current baseline:
- Electron desktop candidate exists.
- Full backend tests 266/266 PASS.
- Desktop UI currently exposes too many long technical forms/cards and mixed English.
- Existing canonical backend semantics must remain.

## 1. UX model: action-first, not admin-form-first

Map ordinary Human operations to product actions:
- onboard/admit -> 确认身份
- provision -> 应用权限
- config-check -> 检查配置
- core start -> 启动 Sidera
- core stop -> 停止 Sidera
- host detect -> 重新检测
- add/config host -> 添加服务
- bind Chief -> 连接对话
- handoff -> 切换对话
- add MCP -> 添加 MCP
- enable/disable -> toggle
- remove -> 移除
- health -> 检查连接
- open chat -> 打开对话
- new work -> 新建工作
- uncertain/effect reconcile -> 处理异常
- update check -> 检查更新

The UI should present the action and user consequence, not the implementation name.

## 2. Information architecture

Primary sidebar should be small and Human-oriented:
- 首页
- 工作
- 节点
- 集成
- 权限
- 状态
- 设置

Do NOT put Tools / Capabilities, raw Effects, RPC catalogs, transport internals, RuntimeSpec, etc. in primary navigation.
Move technical inventories to 设置 -> 高级 -> 开发者 / 诊断.

Home:
- calm overview
- one clear readiness summary
- active work
- connected Nodes/services
- items needing Human attention
- one primary action: 新建工作

Nodes:
- compact row/card per Node
- name + product/model
- status
- current conversation if any
- primary buttons: 打开对话 / 重新检测 / 设置
- no giant IDs by default
- advanced details collapsed

Integrations:
- simple tiles/cards for Codex, DeepSeek, Grok, Gemini, GLM, DSH, MCP
- each card shows installed/configured state, connection/auth state, one primary action
- opening a card launches a focused modal/page
- do not render all adapter forms one after another on one page

Permissions:
- Human-friendly summary of what Sidera can do
- grants grouped by purpose
- 查看详情
- 修改权限
- exact canonical statements only in confirmation dialog / advanced

Status:
- Core, MCP, integrations, route/readiness, recent issues
- plain Chinese labels and concise status chips
- technical IDs/logs behind details

Settings:
- General
- Updates
- Data & diagnostics
- Advanced
- Advanced contains raw capability catalog, identifiers, canonical operation names, recovery hints

## 3. Progressive disclosure
- Normal screens use human language, one main action per section, no raw UUIDs, raw JSON, canonical operation names, command snippets, or implementation jargon like RuntimeSpec/Hythe.
- Advanced details may show exact IDs, canonical operation, transport, evidence timestamps, read-only manifest.

## 4. Language quality
Chinese is default and must be complete.
Audit nav, buttons, forms, helper text, statuses, dialogs, errors, empty states, updates, integrations, diagnostics, confirmations.
Rules:
- no accidental English in normal Chinese mode
- product names may remain English
- technical terms only in Advanced
- English mode remains complete
- add localization coverage tests where practical

## 5. Visual redesign
Current look is too dense and ugly. Redesign for a calm native desktop feel:
- fewer borders and stacked cards
- no endless vertical form wall
- stronger typography hierarchy
- consistent spacing
- clear primary/secondary/destructive buttons
- compact status chips
- focused dialogs/sheets for configuration
- sections rather than boxed panels everywhere
- max readable content width
- responsive desktop layout
Do not imitate another product pixel-for-pixel.

## 6. Setup simplification
First run should be a short guided setup:
1. 欢迎
2. 选择/添加服务
3. 确认 Human 身份
4. 应用权限
5. 连接主对话（可跳过）
6. 完成

Each step has one primary action.
Do not show full backend checklist unless user opens detailed status.
The former typed confirmation should stay only inside the confirmation dialog if canonical backend requires it; never ask the user to use PowerShell.

## 7. Desktop app framing
- native-ish title area
- no visible localhost concept
- no demo/scenario selector in production
- no R0.2/CANONICAL/READ ONLY developer labels in normal chrome
- no giant evidence banners on every screen
- diagnostics under Status/Advanced

## 8. Preserve safety
Do not create generic command execution, arbitrary RPC console, arbitrary JSON editor, weaken Human confirmation, infer Presence/authentication, retry uncertain Effects, or hide blockers.

## 9. Validation
- npm run check
- full npm test
- UI build + smoke
- desktop tests
- visual screenshot review at common desktop sizes
- Chinese localization coverage
- first-run flow test
- verify no PowerShell instruction in normal UI
- verify raw UUID/canonical names absent from default views
- verify all previous Human operations remain reachable from UI
- verify Advanced still exposes exact evidence for debugging
- package a new desktop candidate after visual QA

Write:
- R1_DESKTOP_UX_REDESIGN_REPORT.md
- UI_ACTION_MAP.md
- LOCALIZATION_AUDIT.md

Final verdict:
- UX_RELEASE_READY
- UX_RELEASE_READY_WITH_LIMITS
- UX_HOLD

Do not publish yet.
# Sidera Desktop UX Addendum — 主体优先 / Primary Surface First

> 2026-10-11 scope correction: these are historical visual guidelines for an optional desktop client, not Sidera's global architecture or a required Human entry surface. The [Chat-first Architecture correction](ARCHITECTURE.md#2026-10-11-additive-correction-headless-chat-first-precedence) takes precedence. Ordinary input remains in the existing Chief Chat; Console is optional Human Boundaries administration. Original text is preserved.

Human design direction:
Use ChatGPT/Codex desktop products as interaction references for hierarchy and simplicity, not for pixel-copying.
The two non-negotiable goals are:
1. 主次分明：确定一个主体，其余能力退到可折叠/图标化的次级位置。
2. 命令包装：把 CLI/admin commands 变成按钮、开关、弹窗和短流程，不让命令裸露给普通用户。

## Primary product subject
Sidera's primary subject is WORK, not administration.
The default central surface should be the currently selected work/task and its activity/output/next action, with a lightweight input/composer for creating or refining work.

Recommended desktop hierarchy:
- Center/main: 当前工作 / Work detail + activity + outputs + primary action/composer
- Collapsible secondary sidebar: 置顶 / 最近工作 / Recent work
- Thin icon rail: 节点 / 集成 / 权限 / 状态 / 设置
- Admin/config/catalog never occupies the default home canvas.

Like ChatGPT/Codex, peripheral functions should be available but visually quiet and often collapsible. The user should feel that they are 'doing work', not operating an admin console.

## Home / Work behavior
- If work exists: open the most recent or explicitly selected Work as the main surface.
- If no work: show a very simple empty state with one primary input/action: 新建工作.
- Recent/pinned work belongs in a collapsible sidebar, not in a giant dashboard grid.
- Project/task metadata appears only as supporting context around the selected work.

## Secondary product areas
Nodes / Integrations / Permissions / Status / Settings live behind compact icons/labels and open focused views or sheets.
Do not display all system state at once.
Each secondary view must have one obvious primary action.

## Visual density
- remove dashboard-card sprawl
- remove endless stacked forms
- remove long bilingual paragraphs from normal screens
- reduce borders and boxed sections
- use whitespace, hierarchy, concise labels, compact status chips
- use modal/sheet/drill-in for configuration
- hide IDs and canonical operation names by default
- no raw implementation vocabulary in normal screens

## Language
Chinese mode must read as a complete Chinese product.
English may remain only for product/protocol names (ChatGPT, Codex, MCP, DeepSeek, Grok, Gemini, GLM).
Technical canonical terms belong only in Advanced.

## Command-to-control packaging
Every normal Human CLI action must map to exactly one GUI control or guided flow.
Examples:
- admit -> 确认身份
- provision -> 应用权限
- config-check -> 检查配置
- start/stop -> 启动 / 停止
- add MCP -> 添加 MCP
- bind/handoff -> 连接对话 / 切换对话
- health -> 检查连接
- inspect -> 查看详情
- reconcile -> 处理异常
- update -> 检查更新

Normal UI must not show command snippets as the primary instruction.
Recovery CLI may be shown only under 设置 -> 高级 -> 恢复.

## Desktop frame
The app should feel like a native product shell rather than a website embedded in Electron.
No visible localhost, R0.2, CANONICAL, READ ONLY, demo selector, giant evidence banners, or transport vocabulary in normal chrome.

## Acceptance
- default screen has a clear single main subject: Work
- recent/pinned work is collapsible
- peripheral areas are visually subordinate
- no giant admin dashboard on startup
- no normal-mode PowerShell/CLI instructions
- Chinese normal mode contains no accidental English UI copy
- all previously supported Human operations remain reachable through intentional GUI controls
- visual screenshots at common desktop sizes are reviewed before packaging
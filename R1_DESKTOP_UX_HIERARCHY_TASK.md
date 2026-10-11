# Sidera Desktop UX Refinement — AI-native hierarchy, Work as the primary subject

> 2026-10-11 scope correction: this historical desktop layout task does not define Sidera's required entry point or P0 acceptance. Apply it only to optional client work under the [Chat-first Architecture correction](ARCHITECTURE.md#2026-10-11-additive-correction-headless-chat-first-precedence). The original task below remains evidence.

Human design principle is now precise. Use mainstream AI desktop products only as a reference for hierarchy and interaction habits, not for pixel copying.

Key principles:
1. 主次分明 / Clear hierarchy. The user mainly wants work completed. The product's primary subject is Work, not setup, capabilities, memory, status, or administration.
2. Familiar AI-product mental model. Users are already trained by ChatGPT/Codex/Claude/Gemini-style products to expect a dominant central work surface and subordinate collapsible peripheral functions.
3. CLI semantics are wrapped. Normal users see buttons, toggles, menus, dialogs, and guided flows; never raw commands.
4. Visual restraint. Do not use colorful text. Use typography, spacing, hierarchy, monochrome surfaces and one restrained accent. Product/service names may carry their logos/icons, but status should not become a rainbow.

Current screenshots have improved but still violate the new hierarchy:
- Home is still a dashboard, not a primary Work surface.
- the full labeled sidebar is too visually dominant for secondary functions.
- Integrations is still a grid of administrative cards.
- New Work still feels like a form page rather than an AI work composer.
- the app still feels like a management utility rather than an AI-native work product.

## 1. Redesign the shell around one primary Work surface

Default app state should be Work, not Home dashboard.

Desktop hierarchy:
- Narrow icon rail at far left for major secondary areas: Work, Nodes, Integrations, Status, Settings. Permissions should live under Settings/Security unless actively requiring attention.
- When Work is selected, show a collapsible secondary pane for Pinned / Recent work and a New Work action.
- Main center is the selected Work.
- The recent/pinned pane can be hidden to maximize the main surface.
- No permanent wide labeled navigation taking equal visual weight with Work.

Do not mechanically clone ChatGPT's chat layout. Sidera Work should be its own object:
- title / goal at top
- activity/progress stream
- important outputs
- current blockers/attention
- participating Nodes shown compactly
- bottom composer / instruction input for next Human intent
- a concise work-state indicator

If there is no work, center a clean empty composer with one question such as “想让 Sidera 完成什么？” and one primary action. No dashboard cards.

## 2. Remove or demote Home
- Remove Home as a first-class primary destination unless it has a unique semantic purpose.
- Starting the app should land in the most recent Work, or the empty Work composer.
- Global summary/attention can live as a lightweight top indicator or a small secondary view, not the default canvas.

## 3. Secondary areas should be focused utilities

Nodes:
- list on left or compact rows
- selected node detail on right
- primary actions: 打开对话 / 重新检测 / 设置
- IDs and actor/transport details only under Advanced

Integrations:
- no giant card wall if avoidable
- use a compact list or icon strip + selected integration detail
- each integration has one obvious state and one obvious action
- install/configure/login flows are focused dialogs/sheets

Status:
- concise system health, attention, recent problems
- not a raw observability dashboard

Settings:
- General, Security/Permissions, Updates, Data/Diagnostics, Advanced
- all capabilities/tool catalogs, canonical operations, raw IDs, transports, logs move under Advanced/Diagnostics

## 4. Make Work interaction feel AI-native

Replace the current New Work form-page feeling with a composer-first interaction:
- large primary text input
- optional compact controls for context/target only when needed
- Human identity selection should be implicit/default where safe; do not make it the first field unless multiple Humans genuinely exist.
- submit button wording should be simple: 开始
- explain blocked return route only when relevant, not as a permanent warning box.

Within a Work, allow follow-up Human instruction from the same bottom composer instead of sending the user to separate admin/forms.

## 5. Visual system
- neutral/light surfaces with one restrained Sidera accent
- no multicolor text hierarchy
- reduce tinted banners; warnings only when action is needed
- reduce card borders; prefer whitespace and separators
- tighter left rail, wider main canvas
- typography creates hierarchy
- default body copy concise
- use product icons/logos for Codex/ChatGPT/DeepSeek/Grok/Gemini/GLM/MCP only where helpful
- do not fetch decorative assets unless they materially improve recognition

## 6. Chinese language quality
- Chinese mode must be complete and idiomatic.
- Product names remain English; otherwise normal UI should not contain English implementation terms.
- Remove/translate phrases like Workbench, Ready, Runtime, Route, Actor, Presence from normal views.
- Advanced may show canonical English terms.

## 7. CLI-to-control map remains mandatory
Every ordinary Human CLI action must remain reachable as one intentional GUI control/flow:
- admit -> 确认身份
- provision -> 应用权限
- config-check -> 检查配置
- start/stop -> 启动/停止
- add/configure service -> 添加服务/设置
- bind/handoff -> 连接对话/切换对话
- health -> 重新检测/检查连接
- add MCP -> 添加 MCP
- enable/disable -> switch
- reconcile -> 处理异常
- update -> 检查更新

No PowerShell instruction in normal product UI.

## 8. Visual acceptance is mandatory
Produce and inspect screenshots at 1024x768, 1280x850, 1440x900 for:
- empty Work state
- active Work with recent/pinned sidebar expanded
- active Work with sidebar collapsed
- Nodes
- Integrations
- Settings

Review criteria:
- First glance clearly says 'this app is for doing work'.
- Work occupies the dominant visual area.
- Peripheral functions feel subordinate.
- No admin-dashboard impression.
- No form-wall impression.
- Chinese normal mode is clean.
- No multicolor status text.

## 9. Validation
- preserve all backend and desktop tests
- UI build/smoke
- localization coverage
- no default UUID/canonical operation/PowerShell/raw JSON
- all prior Human actions reachable
- Advanced still exposes exact evidence
- package a new UX candidate only after visual review

Write R1_DESKTOP_UX_HIERARCHY_REPORT.md and update screenshots.
Verdict: UX_HIERARCHY_READY / UX_HIERARCHY_READY_WITH_LIMITS / UX_HIERARCHY_HOLD.
Do not publish to GitHub yet.
# Sidera R1 One-Pass Usability Closure — anyone can use it

Human product decision after real hands-on use:
Sidera is still too hard. The target is GPT/Clash-level usability: full capability exists, but an ordinary user does not need to understand or use most of it.

Non-negotiable product model:
- Simple mode by default.
- Advanced exists, but is hidden until requested.
- If the user has to ask what a normal-mode term means, the UI is not finished.
- If Sidera can detect/generate a value, the user must not type it.
- Normal setup should feel like: Detect -> Connect/Enable -> Done.

Workspace: D:\Sidera-R1-v0.1.0

Current machine evidence already observed:
- Codex native: C:\Users\13cheng4\AppData\Local\OpenAI\Codex\bin\f544b3844e0f14e9\codex.exe
- DeepSeek Harness installed: D:\dsh\DeepSeek Harness.exe (0.1.7-rc.2)
- Gemini desktop installed: C:\Users\13cheng4\AppData\Local\Google\Gemini\Gemini.exe
- Antigravity CLI installed via winget; package contains agy.exe
- Grok Bot installed: C:\Program Files\Grok Bot\Grok Bot.exe; Grok PWA also exists
- ZCode Start Menu shortcut currently points to the deleted old dev path D:\CodexProjects\Sidera\.sidera-dev\zcode\host\ZCode.exe. Treat this as stale/unavailable; never silently restore or use it.
- DeepSeek API is a separate API integration and must not be confused with DeepSeek Harness.

## 1. One-click service onboarding for ALL supported services

Complete ordinary onboarding for:
- Codex
- Grok / Grok Bot
- Gemini / Antigravity
- DeepSeek Harness (DSH)
- DeepSeek API
- GLM / ZCode
- MCP

For each product, the normal card/dialog must contain only:
- product name/icon
- plain-language state
- one sentence explaining what connecting it lets Sidera do
- ONE primary action appropriate to current state: 自动检测 / 连接 / 启用 / 打开登录 / 重新检测 / 修复 / 暂不可用
- optional work/project folder only when it has real Human meaning
- `高级` disclosure

Do not expose path, locator, adapter, provider id, SDK path, home/temp, session, model binding, command, JSON, RPC, or transport in normal mode.

### Auto-detection / auto-configuration
- Read installed-app registry, Start Menu links, known product locations, PATH and known per-product app data in bounded product-specific detectors.
- Never whole-disk scan.
- Never infer login/Presence from install existence.
- Where existing adapter contracts permit safe generated defaults, configure automatically with Sidera-managed private directories and internal identifiers.
- Where one owning-product step is genuinely required, show exactly that one step, e.g. `打开 Grok Bot 完成登录`, then `重新检测`.
- Do not tell user to open PowerShell.

### DSH
Use the actually installed D:\dsh product. Inspect its current package/app.asar contract and existing Sidera DSH adapter. If cliEntry can be safely discovered from the installed package, auto-configure it. User should not type D:\dsh or internal JS paths.

### Gemini / Antigravity
Treat Gemini as the Human product name. Internally use the existing Antigravity adapter only when the installed CLI/runtime contract is actually supported. Detect Gemini desktop and agy.exe separately. If a login must occur in Gemini/Antigravity, provide `打开 Gemini` / `打开登录` and re-check. Do not make Human choose provider/model/settings path unless Advanced.

### Grok
Treat Grok/Grok Bot as the Human product. Detect Grok Bot and PWA. Use existing grok-build-acp adapter only if the installed product exposes the required ACP contract. If not, say `已安装，但当前连接器不可用` and do not ask for paths.

### GLM/ZCode
Detect stale shortcut versus real installed runtime. Do not use deleted legacy path. If no real runtime exists, normal UI says `未安装` / `当前版本需要所属产品安装`; no SDK path form.

## 2. MCP like Clash: simple but complete

Create a default MCP manager that an ordinary user can understand.

Default screen:
- MCP integrations as a compact list.
- enabled switch
- status: 可用 / 需要登录 / 连接失败 / 未配置
- one `添加 MCP` button
- per row: `管理` / `重新检测`

Add MCP flow should offer simple choices:
1. `从应用自动发现` — bounded discovery of known local integrations when available.
2. `通过链接连接` — asks only for Name + MCP URL where Streamable HTTP is supported.
3. `导入配置` — accept/paste a common MCP JSON snippet and parse it locally into supported typed configuration; preview what will be added before apply. This is NOT a generic arbitrary JSON editor. Unsupported fields are shown as unsupported, not executed.

Advanced shows exact endpoint, transport, tools/capabilities, binding, auth reference, raw read-only manifest.

Do not expose a generic tool-execution console.

## 3. Replace typed ADMIT/CONFIRM with a real Human button

Normal user should NOT type confirmation tokens.

Target UX:
- show a short Human-readable permission summary
- `查看详细权限` expandable
- one button: `批准并继续`
- desktop native confirmation dialog displays the exact canonical statement/scope
- Human clicks `批准` / `取消`

Security requirement:
- Node/MCP cannot call the Human approval path.
- renderer alone cannot approve.
- native main-process confirmation remains required.
- use a one-time server-held review / privileged main-process proof rather than exposing a reusable approval secret to renderer.
- preserve expiry/config fingerprint/policy epoch/exact statement semantics.

CLI `ADMIT` remains recovery/developer only.

## 4. Reports: simple/detailed and overview/exact

Create a Human report view/export with two independent presentation controls:

Detail:
- `简略` — only outcome, what changed, what needs Human attention, next step.
- `详细` — include work steps, Nodes/services, outputs, blockers, evidence summary.

Precision:
- `概览` — coarsen canonical facts into plain-language categories; NEVER invent certainty. Approximate/unknown must be labeled.
- `精确` — show exact canonical states, timestamps, identifiers, evidence refs, uncertainty boundaries.

Important: `概览` means less detail, not less truth. Never turn UNKNOWN into success.

Default should be `简略 + 概览`, similar to mainstream AI product summaries. Advanced users can switch to `详细 + 精确`.

Allow copy/export from UI. Exact view may expose technical IDs only there.

## 5. Clash-like progressive disclosure

Adopt the principle: features are complete, but users only touch what they need.

Normal left navigation stays minimal:
- 工作
- 节点
- 集成
- 状态
- 设置

Settings -> Advanced contains:
- exact adapter configuration
- internal paths
- canonical operations
- raw manifests
- capability catalog
- recovery CLI hints

Normal mode must not mention:
locatorRef, RuntimeSpec, Hythe, adapter kind, session id, workspace/home/temp internals, provider thread, canonical operation, MCP tool names.

## 6. App icon

A new Sidera app icon has already been implemented in this workspace:
- desktop/assets/sidera.png
- desktop/assets/sidera.ico
- portable Sidera.exe icon and NSIS installer icon wiring added.
Preserve and validate it. Do not revert to the old green italic `s`.

## 7. Current machine acceptance

Use the CURRENT user's installed products as real local onboarding evidence where safe:
- Codex should be detected automatically.
- DSH should be detected automatically.
- Gemini/Antigravity should be detected automatically (even if actual auth remains unverified).
- Grok Bot should be detected automatically (connection capability may remain unavailable if contract absent).
- stale ZCode should be reported honestly, not configured.

Do not perform external login or send external model work without explicit Human action.

## 8. Validation

Required:
- npm run check
- full backend tests
- desktop tests
- UI build + smoke
- localization coverage
- simple-mode disclosure audit
- one-click ADMIT Human-gate tests
- MCP import/parser tests
- report mode tests (brief/detailed, overview/exact)
- current-machine detection evidence for all installed products above
- screenshots of first-run service list, DSH, Gemini, Grok, MCP manager, Human approval, report modes
- package new portable candidate + installer with the new icon
- privacy scan

Write:
- R1_USABILITY_CLOSURE_REPORT.md
- SERVICE_ONBOARDING_MAP.md
- MCP_SIMPLE_MODE.md
- REPORT_PRESENTATION_MODEL.md

Final verdict:
- USABILITY_READY
- USABILITY_READY_WITH_LIMITS
- USABILITY_HOLD

Do not publish to GitHub yet.
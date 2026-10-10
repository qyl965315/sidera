# Sidera Onboarding Simplification — remove technical fields from ordinary setup

Human feedback from actual use:
- The current Add Service flow is confusing.
- '服务位置' is not understandable.
- '官方引导' is not understandable or actionable.
- User should not need to know locatorRef, executable paths, home/temp/codexHome, provider internals, or other implementation details just to add Codex or another service.

Diagnosis:
`locatorRef` is an internal exact Host/Session locator, NOT an ordinary Human concept. It must not appear as '服务位置' in normal UI.
`codexExecutable` is the actual installed Codex executable path. It also should be automatically detected where possible, not typed manually.
`home/temp/codexHome` are isolation/runtime directories and should be generated automatically under Sidera private app data unless the user opens Advanced.
`官方引导` currently opens docs/guidance and is too vague. Replace with state-specific actions.

## Product goal
For ordinary setup, adding Codex should feel like:
1. User clicks Codex.
2. Sidera automatically detects whether Codex is installed.
3. UI says one of: 已安装 / 未安装 / 需要登录 / 已连接 / 需要重新检测.
4. Primary action is contextual: 连接 Codex / 打开 Codex 登录 / 查看安装方式 / 重新检测.
5. User may optionally choose a work folder if relevant.
6. Everything else is generated or hidden under 高级设置.

## Required changes

### A. Remove locatorRef from ordinary UI
- Never label `locatorRef` as 服务位置 in normal UI.
- Generate an exact internal locatorRef automatically from canonical configuration identifiers.
- Show it only under Advanced as `内部定位标识`, read-only if possible.

### B. Auto-detect installed executables
Implement bounded detection for supported installed desktop/CLI Hosts, especially Codex.
For Codex on Windows, inspect only known supported locations / PATH resolution and verified basename patterns. Current machine may have:
- packaged/native Codex under `%LOCALAPPDATA%\OpenAI\Codex\bin\<version-or-hash>\codex.exe`
- CLI wrapper from npm; distinguish wrapper from actual supported app-server executable where needed.

Detection must return only product-safe facts:
- installed true/false
- display path only in Advanced
- supported/unsupported
- sign-in state only if a real owning-product contract can prove it; otherwise '登录状态待确认'.

Do not infer authentication from file existence.

### C. Generate isolation directories automatically
For Codex normal setup:
- workspace: default to a Sidera-managed workspace directory unless the Human explicitly selects a project/work folder.
- home/temp/codexHome: create Sidera-managed isolated directories under private app data.
- model: use existing supported default/auto selection unless Human explicitly opens Advanced.
- no normal form field for these.

For other Host adapters, apply the same rule: ordinary view asks only the minimum Human choice; generated/internal details go to Advanced.

### D. Replace '官方引导'
Use context-specific labels:
- 未安装 -> `查看安装方式`
- 已安装但登录未确认 -> `打开 Codex` or `去 Codex 登录` only if a safe owning-product launch action exists; otherwise `查看登录说明`
- 已配置 -> `重新检测`
- connection issue -> `检查连接`

`帮助` may open official documentation, but documentation must not be the primary action.

### E. Simplify Add Service dialogs
Normal Codex dialog should show roughly:
- Codex
- status
- optional work folder
- one primary button
- a small '高级设置' disclosure

Advanced may show:
- executable path
- internal locator
- workspace/home/temp/codexHome
- model
- exact adapter kind
but with explanations.

Do the same progressive-disclosure audit for DeepSeek, Grok, Gemini, GLM, DSH, MCP.

### F. Plain-language help
Every field visible in normal mode must answer: 'why does the user need to choose this?'
If no strong reason, remove/hide it.
Add concise inline explanations where needed.

### G. Acceptance
- A first-time Human can add Codex without knowing any filesystem path or internal locator.
- No normal UI contains labels `服务位置`, `locatorRef`, `RuntimeSpec`, `Hythe`, `codexHome`, `home`, `temp`.
- Codex detection works on the current Windows machine if installed.
- Normal setup never requires PowerShell.
- Advanced retains exact evidence for debugging.
- existing authority/identity/presence semantics unchanged.
- npm check/tests/build/smoke/localization pass.
- produce screenshots of Codex: detected, not-installed simulation, advanced details.

Write R1_ONBOARDING_SIMPLIFICATION_REPORT.md.
Do not publish yet.
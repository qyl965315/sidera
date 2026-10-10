# Sidera Onboarding Copy & Guide Addendum — Explain before asking

Human feedback:
Many nouns in current onboarding are not self-explanatory. The guide must teach only what the user needs for the current decision and hide implementation vocabulary.

## Design rule
For every normal-mode concept or field, the UI must answer four questions in plain Chinese:
1. 这是什么？
2. 为什么需要它？
3. 我现在该做什么？
4. 做完以后会发生什么？

If the user must learn an internal term before proceeding, the term probably belongs in Advanced instead.

## Copy rules
- Prefer outcome/action language over architecture nouns.
- Avoid unexplained terms such as Host, Session, locator, Presence, ModelBinding, RuntimeSpec, Hythe, route, actor, canonical.
- Product/protocol names like Codex, ChatGPT, MCP, DeepSeek may remain.
- Normal Chinese mode should be idiomatic Chinese, not literal translations of backend terminology.
- Use one short sentence of help directly under an unfamiliar control.
- Add small '这是什么？' / help affordance only where a concept genuinely needs explanation; do not create a documentation wall.

## Example: Codex onboarding
Normal card/dialog should read approximately:

Codex
让 Sidera 使用你电脑上已经安装的 Codex 来完成工作。

状态:
- 已检测到 Codex
- 尚未检测到 Codex
- 登录状态待确认
- 已连接 / 需要重新检测

Primary actions by state:
- 未安装: 查看安装方式
- 已安装: 连接 Codex
- 需要登录: 去 Codex 登录 / 查看登录说明
- 已配置: 重新检测

Optional field:
`工作文件夹`
Help: `Codex 会在这里处理项目文件。没有特别要求时可以使用 Sidera 默认文件夹。`

Advanced disclosure:
`高级设置`
Inside only: program path, internal locator, isolated home/temp/config directories, model, adapter kind.

## Guide style
First-run guide should be conversational and task-oriented, not a glossary.
Examples:
- `先连接一个你平时使用的 AI 服务。Sidera 会自动检测已安装的服务。`
- `检测到了 Codex。点击“连接 Codex”即可，其他设置可以以后再改。`
- `没有检测到 Codex。你可以先查看安装方式，也可以跳过，之后再添加。`
- `这一步只是让 Sidera 记住你的本地身份，不会登录任何第三方账号。`
- `权限会在确认前完整展示；你可以从只读开始。`

## Error/help copy
Every user-facing error should say:
- what failed in plain language
- what the user can do now
- whether retry is safe
Do not expose only an internal error code in normal UI.

## Acceptance
- A first-time user can complete setup without knowing Sidera architecture terms.
- Every unfamiliar visible field has a clear reason and next action.
- No normal-mode screen assumes the user knows backend vocabulary.
- Help text remains concise; Advanced preserves exact terminology.
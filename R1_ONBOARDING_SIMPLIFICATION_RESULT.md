已完成本轮 onboarding 简化，并写入 [R1_ONBOARDING_SIMPLIFICATION_REPORT.md](/D:/Sidera-R1-v0.1.0/R1_ONBOARDING_SIMPLIFICATION_REPORT.md)。**未发布、未部署。**

现在添加 Codex 时，普通界面只显示安装状态、可选工作文件夹、当前状态对应的主要动作，以及“高级设置”。用户可以不填写任何路径，直接保存配置：

- 自动检测原生 Codex，区分 `codex.exe` 与 npm 的 `codex.cmd` 包装器。
- 自动生成工作、用户、临时和 Codex 配置目录，放在 Sidera 私有应用数据目录下。
- 自动生成内部配置定位标识，普通界面不显示；高级设置中以“内部定位标识”只读展示。
- 默认采用自动模型选择。
- 主按钮按状态显示“连接 Codex”“查看安装方式”或“重新检测”；登录说明作为次要动作。

本机已检测到原生 Codex。检测结果没有推断账号登录状态，界面明确显示“登录状态待确认”。DeepSeek 的地址和凭证引用已收进高级设置；Grok 使用同样的自动检测和目录生成规则。Gemini、GLM、DSH 已审查并保留明确的所属产品配置限制，MCP 的精确连接信息继续放在高级披露中。

验证结果：

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过 |
| 全套后端测试 | **268/268 通过** |
| 桌面测试 | **13/13 通过** |
| UI 类型检查与生产构建 | 通过 |
| UI smoke | 通过，覆盖七种服务对话框、普通界面披露和权限确认边界 |
| 本地化检查 | 通过 |
| 桌面 onboarding 实测 | 通过：不输入路径，实际保存 Codex 配置，查看生成的高级详情 |

三种截图已交付：

- [Codex 已检测到](/D:/Sidera-R1-v0.1.0/desktop-evidence/onboarding/codex-detected.png)
- [Codex 未安装模拟](/D:/Sidera-R1-v0.1.0/desktop-evidence/onboarding/codex-not-installed-simulation.png)
- [Codex 高级详情](/D:/Sidera-R1-v0.1.0/desktop-evidence/onboarding/codex-advanced.png)

**验证边界：这轮证明了自动检测和无需路径的配置流程，没有验证已登录 Codex 的实际执行。** 自动生成的定位标识是 Sidera 内部配置声明，不是 Codex 返回的 provider thread ID；保存配置不会被标记为已连接、已认证或已有 Presence。现有权限、身份和活动 Host 替换保护仍然保留。


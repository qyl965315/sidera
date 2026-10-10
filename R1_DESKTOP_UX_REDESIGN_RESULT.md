已完成桌面 UX 重设计，并生成新的、**未发布**的 Windows 候选包。最终裁定：**UX_RELEASE_READY_WITH_LIMITS**。

生产界面已改为动作入口：主侧栏只有 **首页、工作、节点、集成、权限、状态、设置**。常见操作通过按钮、开关、聚焦配置窗口和短向导完成；普通页面不再展开 UUID、JSON、标准操作名、运行规格或命令说明。精确标识、原始记录和只读能力目录仍可从高级详情查看。

主要变化包括：

- **首页**集中呈现就绪摘要、活动工作、连接服务和待处理事项，以“新建工作”为主动作。
- **节点**采用紧凑行布局，提供打开对话、检测和设置入口；缺少模型身份依据时明确显示“模型待验证”。
- **集成**提供 Codex、DeepSeek、Grok、Gemini、GLM、DSH、MCP 七个入口，一次只打开一个服务的配置窗口。
- **首次使用**缩为六步：欢迎 → 添加服务 → 确认身份 → 应用权限 → 连接主对话（可跳过）→ 完成。
- **中文和英文**均已覆盖生产界面及原生确认窗口。精确批准文字只在确认窗口出现，普通流程没有 PowerShell 指令。
- **安全语义**保留：原生批准、权限主体、精确绑定、活动回合的退出与更新阻断，以及未知结果待核对；没有增加通用命令执行、任意 RPC、JSON 编辑器或自动重试。

本轮验证结果如下，使用的是实际重新运行的结果：

| 验证 | 结果 |
|---|---|
| `npm run check` | PASS |
| 完整后端测试 | **266/266 PASS** |
| 桌面测试 | **13/13 PASS** |
| UI 构建与 UX smoke | PASS |
| 六步首次使用流程 | PASS |
| 本地化覆盖 | **390 处中英文配对文案**；导航、服务窗口及默认视图审计通过 |
| 默认视图技术信息审计 | PASS：受测视图无原始 UUID、标准操作名、JSON 或 PowerShell 指令 |
| 视觉审阅 | **18 张截图**，覆盖 1024×768、1280×850、1440×900；无横向溢出 |
| 最终打包 smoke | PASS：隔离启动、拒绝批准、退出保护、更新阻断和重启恢复 |
| 候选完整性 | PASS：打包 UI 与当前构建一致；完整 SHA-256 清单已校验；隐私扫描无发现 |

交付文件：

- [Windows 安装候选包](D:/Sidera-R1-v0.1.0/candidates/desktop-ux-20261006/Sidera-0.1.0-ux-x64-setup.exe)
- [便携版启动程序](D:/Sidera-R1-v0.1.0/candidates/desktop-ux-20261006/portable/Sidera.exe)——使用时需保留整个 `portable` 目录及相邻资源
- [重设计报告](D:/Sidera-R1-v0.1.0/R1_DESKTOP_UX_REDESIGN_REPORT.md)
- [操作映射表](D:/Sidera-R1-v0.1.0/UI_ACTION_MAP.md)
- [本地化审计](D:/Sidera-R1-v0.1.0/LOCALIZATION_AUDIT.md)
- [候选清单](D:/Sidera-R1-v0.1.0/candidates/desktop-ux-20261006/UX_CANDIDATE_MANIFEST.json) · [SHA-256 清单](D:/Sidera-R1-v0.1.0/candidates/desktop-ux-20261006/SHA256SUMS)
- [首页截图](D:/Sidera-R1-v0.1.0/desktop-evidence/ux/home-1280.png) · [集成页截图](D:/Sidera-R1-v0.1.0/desktop-evidence/ux/integrations.png) · [最终打包状态页截图](D:/Sidera-R1-v0.1.0/desktop-evidence/ux/packaged/desktop-status.png)

安装包 SHA-256：

```text
cb8c497ac3e0b3f57f406d9d570719aa70d3dda54f8e8fceafe71834f0661a71
```

**WITH_LIMITS 的具体原因**：安装包未签名，仍使用 Electron 默认程序图标；验证在同一台 Windows 机器的隔离数据目录完成，未执行安装器或进行全新 OS/VM 验证；外部登录、真实模型调用和消息回程未在本轮完成验证。打包测试中的批准响应、活动回合和更新来源使用了明确的测试夹具。GLM/DSH 缺少可安全调用的既有安装契约，界面如实显示限制；其他服务首次接入的准确配置仍位于聚焦窗口详情中。静态启动页默认中文，保存的英文偏好在产品界面加载后恢复。

新候选已打包并校验，**没有发布或运行安装器**，也没有迁移或写入用户现有身份、凭证和外部会话。


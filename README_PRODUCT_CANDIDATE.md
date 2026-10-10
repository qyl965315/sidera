# Sidera R1 产品修订候选包

先安装 Node.js 24 或更新版本，解压到本机目录，双击 **Start-Sidera.cmd**。浏览器会打开本地 Setup。无需 PowerShell 或 npm 安装步骤；本候选包附带运行所需 production dependencies 和已构建前端。

在 Setup 声明 Human、配置有界 Node/Host、审查精确权限、确认 Chief conversation、配置真实回程并启动 Core。普通目标从 **Home / New Work** 输入。创建身份、配置 Host、绑定 conversation 都不会自动授予 Authority、登录 Host、建立 Presence 或发送外部任务。

查看 [SETUP_R1.md](SETUP_R1.md) 的完整步骤、adapter 限制和生命周期边界。候选包的结论为 **HOLD**：本地产品流程已改善，但可执行 Host 的普通安装/登录/已验证模型身份闭环尚未完成；Node 授权的 Session handoff、退役和 Host replacement 保留高级操作。不要把它当作已经正式发布的完整产品。

**LOCAL_READY** 代表本地 Core 实际可用、可监测。**FULL_ROUTE_READY** 额外要求真实精确 Human 回程、Presence、授权及执行 Node 可用。当前外部 ChatGPT 无 detached proactive return 能力时，本地运行仍可用；需要回程的提交会保持 blocked。没有浏览器生产回程或自动重试。

私有状态只在首次启动后创建于本机 `.sidera-dev`，请勿共享这个目录。API 和 MCP secret 使用本机环境变量引用；值不会进入 React。第三方 Host 登录始终在 owning Host 中完成。

本包仅供候选验证，未发布 GitHub，未覆盖已有 release ZIP。`CANDIDATE_MANIFEST.json` 记录范围，`SHA256SUMS` 校验每个文件，`PRIVACY_SCAN.json` 记录全包扫描，`CANDIDATE_VALIDATION.json` 记录新临时目录首次运行结果。

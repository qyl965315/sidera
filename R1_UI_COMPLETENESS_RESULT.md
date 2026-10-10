已完成最终 UI completeness pass，并准备好**未发布候选**。当前 verdict 已更新为 **RELEASE_READY_WITH_EXPLICIT_EXTERNAL_LIMITS**。

前端现在有 Home / Work、Nodes、Connections / Routes、Authority / Permissions、Effects / Recovery、System 和 Tools / Capabilities 的明确入口。管理入口共用现有 Setup 控制面和 Human confirmation 流程，后端继续使用 canonical 实现。

这轮主要补齐了：

- **能力目录**：195 个条目，覆盖原接口映射中的全部 **56 个功能**以及 canonical RPC 分支、别名和 MCP tools。目录显示用途、actor、条件可用性、canonical source、前端位置和不可执行原因；目录本身不提供通用执行控制台。
- **Host 配置**：八种指定 adapter 均有前端配置入口。五种可执行 Host 使用严格、按 adapter 区分的类型化表单；API adapter 保留环境变量 credential reference；external MCP edge 保留精确 locator。没有增加 shell、任意 launch arguments 或 JSON options editor。
- **权限撤销**：使用现有 `revokePermissionPackage`，先审查当前 grants 和精确 scope，再通过独立 admitted Human act 确认撤销，保留历史。
- **Intent revision**：审查精确 owned parent revision，调用 `SemanticStore.reviseIntent`；过期审查被拒绝，不重写已有任务，也不重新提交工作。
- **生命周期边界**：Session handoff、Node retire、Host replacement 和原始 result repair 在界面中可见，并显示 canonical 操作和 actor 要求。Node-only mutation 没有变成 Human 可执行操作。

验证结果如下：

| 验证 | 结果 |
|---|---|
| `npm run check` | PASS |
| 完整 `npm test` | **258/258 PASS**，0 fail、0 skip |
| Setup / admin / catalog tests | **15/15 PASS** |
| UI build / typecheck | PASS |
| 原有 UI smoke、canonical projection smoke | PASS |
| Function map 与 canonical MCP catalog 覆盖检查 | PASS |
| Node actor gating、严格 schema、generic RPC/command 拒绝、secret redaction | PASS |
| 最终候选隐私扫描 | **零发现** |
| 最终 ZIP 解包文件校验 | **3,585 个 payload 文件全部通过** |
| 最终 ZIP 解包后的 clean-install 浏览器流程 | PASS |

验证记录也保留了实际遇到的限制：首次受限全套运行卡在 Chrome fixture 启动，获得本地 fixture 浏览器启动权限后完整通过；首次 clean-install 在 Core 启动期间收到暂态状态错误，后续全新安装和最终 ZIP 解包验证均通过。测试遗留的 Workbench 进程是在核对临时 fixture 身份、确认 Core 已安全停止后清理的，没有终止其他运行实例。

最终交付：

- [候选 ZIP](D:/Sidera-R1-v0.1.0/candidates/r1-ui-completeness-release-candidate/Sidera-R1-UI-Completeness-Candidate.zip)
- [候选验证记录](D:/Sidera-R1-v0.1.0/candidates/r1-ui-completeness-release-candidate/CANDIDATE_VALIDATION.json)
- [候选 SHA256SUMS](D:/Sidera-R1-v0.1.0/candidates/r1-ui-completeness-release-candidate/SHA256SUMS)
- [R1_UI_COMPLETENESS_REPORT.md](D:/Sidera-R1-v0.1.0/R1_UI_COMPLETENESS_REPORT.md)
- [更新后的 FUNCTION_INTERFACE_MAP.md](D:/Sidera-R1-v0.1.0/FUNCTION_INTERFACE_MAP.md)
- [更新后的 R1_FINAL_PRODUCT_CLOSURE.md](D:/Sidera-R1-v0.1.0/R1_FINAL_PRODUCT_CLOSURE.md)

ZIP 大小为 **8,394,077 bytes**，SHA-256：

```text
4831617197a9278bb2636fb9c42e11d51e86b9a4ac8a4eba00b02e1d605221c8
```

剩余限制已明确展示：真实登录和 provider-owned action 仍由拥有账号的 Host 完成；当前本地上下文没有支持的登录启动机制。配置不会制造 authentication、verified ModelBinding 或 Presence，也不构成真实外部 E2E、detached ChatGPT proactive return 或结果 delivery 的证明。最终安装测试中 **LOCAL_READY=true、FULL_ROUTE_READY=false**，缺少回程的工作继续被 canonical gate 阻止。

**没有发布、没有 GitHub 变更、没有覆盖已有归档。**


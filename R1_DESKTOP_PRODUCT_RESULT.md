已完成 R1 桌面产品壳、Windows 便携候选包和验证。最终结论：**`DESKTOP_RELEASE_READY_WITH_EXPLICIT_LIMITS`**。未发布到 GitHub。

你现在可以直接运行已解包目录中的 [Sidera.exe](/D:/Sidera-R1-v0.1.0/candidates/Sidera-Desktop-R1-Windows-x64/Sidera.exe)。分发时使用下面的 ZIP，解压后保留整个目录和资源，再双击 `Sidera.exe`；普通操作不需要安装 Node、打开 PowerShell 或手动访问 localhost。

- [Windows 桌面便携包 ZIP，约 192 MiB](/D:/Sidera-R1-v0.1.0/candidates/Sidera-Desktop-R1-Windows-x64.zip)
- [DESKTOP_ARCHITECTURE_R1.md](/D:/Sidera-R1-v0.1.0/DESKTOP_ARCHITECTURE_R1.md)
- [R1_DESKTOP_PRODUCT_REPORT.md](/D:/Sidera-R1-v0.1.0/R1_DESKTOP_PRODUCT_REPORT.md)
- [桌面候选 manifest](/D:/Sidera-R1-v0.1.0/candidates/Sidera-Desktop-R1-Windows-x64/DESKTOP_CANDIDATE_MANIFEST.json)
- [候选目录 SHA256SUMS](/D:/Sidera-R1-v0.1.0/candidates/Sidera-Desktop-R1-Windows-x64/SHA256SUMS)
- [ZIP SHA256](/D:/Sidera-R1-v0.1.0/candidates/SHA256SUMS-desktop.txt)

选择了 **Electron 44.5.1 + bundled Node 24.18.0**。依据是现有 React/Node/TypeScript 后端可以直接复用，而本机没有发现 Rust/Cargo；Tauri 或自建 WebView2 壳会增加另一套语言和构建链，并仍需 Node sidecar。架构文档记录了取舍，以及 [Electron sandbox 边界](https://www.electronjs.org/docs/latest/tutorial/sandbox)与 [Tauri 的 Windows 前置条件](https://v2.tauri.app/start/prerequisites/)。

实际实现包含：

- 原生应用窗口内部承载现有前端，独立启动 Workbench，复用 canonical Core 启动、状态与停止语义。**Core 停止后 Setup/System 仍可用**。
- renderer 开启 sandbox、context isolation，关闭 Node integration；preload 只暴露诊断、按 binding ID 打开 Chat、显式浏览器回退三项操作。
- Human 精确审查和键入确认之外，增加显示 canonical statement 的**原生确认窗口**。renderer 提交确认本身不能批准该 Human act。
- Open Chat 由主进程重新读取已有 binding 并校验产品对应的 HTTPS URI；不接受任意 URL，也不推导 ChatGPT conversation URL。无精确引用时显示不可用，打开行为不改变 Presence 或回程 readiness。
- 新增 Integrations / Services 页面，提供有界配置、Core 服务集启停、MCP/Host inventory、认证/Presence/health 分离标签，以及桌面生命周期诊断。
- 退出通过 canonical graceful-stop gate。活动 turn 或停止结果不确定时，应用保持打开，不按 PID 或进程名强杀。

验证结果如下：

| 验证 | 结果 |
|---|---|
| 后端及 desktop worker 类型检查 | PASS |
| 完整现有回归测试 | **259/259 PASS**，保留原有 258 项并新增一项桌面边界测试 |
| 前端 production build / UI smoke | PASS |
| 桌面安全测试 | **3/3 PASS** |
| 新目录、新数据目录的打包 EXE 启动 | PASS：窗口 → Setup → Core 启动 → 安全停止 |
| 无调试参数的普通 EXE 启动及窗口关闭 | PASS |
| 缺少 bundled Node | 应用内显示启动错误，并可正常退出 |
| renderer 隔离及令牌检查 | `process`/`require` 不可用；已检查的 status/diagnostics 不含生成的 Core/HTTP 令牌 |
| 活动 turn 退出保护 | 真实 stop gate 拒绝退出，原 Core owner 与 open turn 记录保留 |
| 缺失完整回程 | **`FULL_ROUTE_READY` 保持 `false`** |
| 候选隐私扫描与 ZIP 内容哈希 | PASS；逐项验证 **3,644 个文件** |

需要保留的限制是：这是**未签名便携包**，没有自动更新或第三方 Host 安装器；第三方安装、登录和独立 adapter 启停仍按报告标注为所属产品操作或 Advanced。干净目录验证在当前 Windows 机器完成，尚未做全新 Windows VM 验证。外部 Chat 打开在测试中被拦截；原生批准响应和活动 turn 使用受控测试 fixture，因此这些结果不代表真实 Human 批准、外部 Host turn 或 detached ChatGPT 回程已经验证。

ZIP 的 SHA256 为：

```text
0eac1388cc1703e2772a01b698d7b5753ae7021f2f97126c63d510ae55255f22
```


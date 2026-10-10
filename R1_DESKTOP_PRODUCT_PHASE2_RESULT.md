已完成 Phase 2 实现、本机验收和最终候选封装。最终判定为 **`DESKTOP_PHASE2_RELEASE_READY_WITH_EXPLICIT_LIMITS`**。未发布到 GitHub，未配置公共更新源。

候选位于 [candidates/desktop-phase2](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2)，验证用的私有数据和安装临时目录已移到 `desktop-evidence`，不包含在交付载荷中。

| 交付物 | 文件 |
|---|---|
| Windows x64 安装器，约 144.44 MB | [Sidera-0.1.0-phase2-x64-setup.exe](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/Sidera-0.1.0-phase2-x64-setup.exe) |
| Windows x64 便携 ZIP，约 195.96 MB | [Sidera-0.1.0-phase2-Windows-x64-portable.zip](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/Sidera-0.1.0-phase2-Windows-x64-portable.zip) |
| 安装器与便携版 manifests | [INSTALLER_MANIFEST.json](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/INSTALLER_MANIFEST.json)、[PORTABLE_MANIFEST.json](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/PORTABLE_MANIFEST.json) |
| 全部交付文件校验和 | [SHA256SUMS](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/SHA256SUMS) |
| 干净机器验证入口 | [Validate-Fresh-Install.cmd](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/Validate-Fresh-Install.cmd)、[验证清单](D:/Sidera-R1-v0.1.0/candidates/desktop-phase2/validation/FRESH_MACHINE_VALIDATION.md) |

实现结果包括：

- **安装器**：当前用户安装、开始菜单快捷方式、可选桌面快捷方式、卸载支持和数据保留。运行中的 Sidera 会阻止安装、替换和卸载；安装器不会强制终止应用。可选桌面快捷方式记录安装归属并在卸载时清理。安装器使用 [electron-builder 的 NSIS 配置](https://www.electron.build/docs/nsis/)。
- **更新**：新增独立的 **System → Updates** 页面和 main-process 更新状态机。没有更新源时显示“未配置更新源”；支持严格验证的 release manifest 与 GitHub release metadata，下载后和安装前均核对 SHA-256。安装必须先通过 canonical graceful-stop gate。
- **Integrations / MCP**：八类 Host onboarding 卡片、显式 Re-check、受限官方引导，以及 canonical MCP 路由清单、能力/tool 映射、健康检查、启用/禁用和安全移除。健康检查只初始化 MCP 并列出 tools，不调用 tool 或制造 Presence。
- **Chat 导航**：非 Chief Node 可保存独立的 `userOpenableConversationRef` 导航元数据。ChatGPT/Grok 使用精确 HTTPS allowlist；不从 Node/Session ID 构造 URL，不修改身份、Session locator 或返回路由。
- **诊断**：版本、健康、更新状态、集成摘要、最多 100 条持久化生命周期日志、原生保存对话框导出脱敏诊断，以及固定数据目录打开动作。渲染器没有通用 shell、RPC、下载器、路径打开器或凭证接口。

验收结果如下：

| 验收项 | 最终结果 |
|---|---|
| `npm run check` | PASS |
| 完整 `npm test` | **266/266 PASS**，保留原 259 项并新增 7 项 |
| UI build + smoke | PASS |
| 桌面专项测试 | **13/13 PASS** |
| 安装器构建、安装后 UI、同版本重装、卸载及隔离数据保留 | PASS |
| 便携启动、Core 启停、渲染器隔离及无凭证泄漏检查 | PASS |
| 活动 Host turn 阻止退出与更新安装 | PASS，实际 canonical stop gate 拒绝，原 owner 保留 |
| 安装器与便携载荷隐私扫描 | PASS |
| 安装器解包载荷与便携载荷 SHA-256 比对 | **3,649 个文件，零差异** |
| 最终交付校验 | **3,659 个文件校验通过，零未登记文件** |
| 无真实返回证据时 `FULL_ROUTE_READY` | 保持 **false** |

主要限制已完整写入报告：

1. **应用和安装器均为 `NotSigned`**。没有 Authenticode 发布者身份；SHA-256 只验证完整性。
2. **没有生产更新源或真实更新发布验证**。当前拒绝 HTTP redirects，因此默认 GitHub 重定向下载地址可能被保守拒绝；实际发布前需要兼容的直接资产端点或另行审计的重定向策略。
3. **安装与登录仍遵循所属产品合同**。缺少安全合同的自动操作明确不可用；DSH 脚本入口和 ZCode SDK 安装不开放给普通 Host 表单。不会从配置、文件存在或打开引导页面推断认证、ModelBinding 或 Presence。
4. **干净 Windows VM 验证仍待外部证据**。本机完成了隔离安装与新数据目录验证，并从应用 PATH 中移除了 Node；这不等同于无 Node 的全新操作系统。跨版本迁移、安装向导选项交互和真实外部 Host 登录/回程也未宣称完成。
5. 活动 turn、更新下载和外部 Chat 打开验收使用明确标记的本地测试夹具；更新夹具仅存在于测试进程内，没有写入或访问公共更新源。

完整记录见 [R1_DESKTOP_PRODUCT_PHASE2_REPORT.md](D:/Sidera-R1-v0.1.0/R1_DESKTOP_PRODUCT_PHASE2_REPORT.md)。[DESKTOP_ARCHITECTURE_R1.md](D:/Sidera-R1-v0.1.0/DESKTOP_ARCHITECTURE_R1.md) 和 [README.md 中文快速开始](D:/Sidera-R1-v0.1.0/README.md) 已更新。

最终两个主制品的 SHA-256 为：

```text
Installer EXE
6b418b24c9b3178bc4b235e83d16f59b93cb3a907180fa4625ca9c6d06170f88

Portable ZIP
df3234c469993354f6c647c1ddcec97dbfdea8c4cdcde1d505e72718f5ab4f21
```
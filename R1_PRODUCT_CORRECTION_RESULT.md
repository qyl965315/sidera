已在 `D:\Sidera-R1-v0.1.0` 实现并验证本地 Setup/Admin 修正，保留 R1 ontology。**当前候选仍为 HOLD，尚未达到完整的普通用户首次安装即 ready 的发布标准；没有发布任何包。**

现在的普通本地入口是双击 [Start-Sidera.cmd](/D:/Sidera-R1-v0.1.0/Start-Sidera.cmd)，打开 `http://127.0.0.1:47320/setup`。启动器提供最小 bootstrap、静态前端和受见证的 Core 启动路径；Core 停止后，Setup 仍可使用。已有监听器会被保留并明确报告。

Setup 已支持：

- bootstrap、运行端口配置、配置校验，以及 Core/Gateway/回程状态查看；
- Human principal 创建；
- inbound-only 外部 MCP Node 的精确声明及 Node/Host inventory；
- 完整权限 manifest 和 scope 审查、输入确认码后 admission/provision，以及已有批准 grants 的 provision；
- 已存在 Chief conversation 的绑定和 canonical handoff；
- 原样 Human 意图保存、一次性工作提交；
- 带来源事件和 revision 的 Effect reconciliation 审查；
- Core 安全启动/停止，以及高级手动恢复说明。

Human 高信任操作使用服务器保存的精确提案，页面展示全文和 scope，再要求明确输入确认码。错误、过期或重复确认不会授权；admission 与实际应用在同一事务中完成。这些操作没有注册为 MCP 工具。管理 API 使用 loopback、同源检查和固定操作 schema，没有 generic shell、任意文件路径或任意 RPC 方法入口。

架构上完成了三处共享实现提取：配置校验、literal Human intent capture、exact-owner Core stop。CLI 与 UI 复用这些实现；静态发布前端继续使用既有的 canonical read projection，并移除了指向旧开发 checkout 的默认路径。

交付文档：

| 文件 | 内容 |
|---|---|
| [FUNCTION_INTERFACE_MAP.md](/D:/Sidera-R1-v0.1.0/FUNCTION_INTERFACE_MAP.md) | 功能与入口清单、canonical 实现、重复/legacy/CLI-only/缺失流程及决策 |
| [PRODUCT_FLOW_R1.md](/D:/Sidera-R1-v0.1.0/PRODUCT_FLOW_R1.md) | Human 心智模型和八条最小流程图 |
| [ARCHITECTURE_DIET_R1.md](/D:/Sidera-R1-v0.1.0/ARCHITECTURE_DIET_R1.md) | 保留的语义层、合并项、数据转换链及 legacy 隔离 |
| [R1_PRODUCT_CORRECTION_REPORT.md](/D:/Sidera-R1-v0.1.0/R1_PRODUCT_CORRECTION_REPORT.md) | 实现结果、验证证据、CLI-only 原因及发布阻塞项 |

验证结果：

| 检查 | 结果 |
|---|---|
| `npm run check` | PASS |
| `npm test` | **249/249 PASS**：原有 **243 项全部保留并通过**，新增 6 项 |
| Setup/Admin 行为测试 | **6/6 PASS** |
| UI build、原有 UI smoke、canonical projection smoke | PASS |
| 全新临时发布副本：实际 CMD 启动＋真实 Edge 浏览器流程 | PASS |
| 启动后不使用 PowerShell完成本地 Setup、授权、绑定及 Core 启停 | PASS |
| 缺失回程保持 blocked | PASS，且 **零 Task、零 logical Action** |
| 浏览器响应不包含配置凭证 | PASS |
| 修改前恢复副本 | **188 个文件 SHA-256 校验通过** |

证据包括 [完整测试日志](/D:/Sidera-R1-v0.1.0/correction-evidence/final-tests-unsandboxed.log)、[干净安装结果](/D:/Sidera-R1-v0.1.0/correction-evidence/clean-install-result.json) 和 [Setup 浏览器截图](/D:/Sidera-R1-v0.1.0/correction-evidence/setup-browser.png)。最初沙箱内有两项 Chrome 初始化测试失败；允许浏览器正常启动后，同一测试文件及完整套件均通过，未修改或跳过原有断言。

**HOLD 的具体原因**是：

1. 普通 UI 当前可声明 inbound-only 外部 MCP Node；其他 executable/API Host 的配置、隔离登录、verified ModelBinding 和实际 return-route 安装仍需高级步骤。因此，全新安装后的“setup → 可执行并可回传的 ready”链尚未闭合。
2. Active Session handoff、Node retirement 和既有 Host 配置变更尚缺少普通 Human UI 流程；当前没有用配置删除或静默替换绕过 canonical Authority/Registry 语义。
3. 公共包需要重新构建并清理。本目录含预先存在的私有运行状态及本次验证证据，不能直接作为公共发布归档。

本次真实浏览器验证属于本地合成测试，没有执行真实外部推理，也没有把自动化测试动作记为真实 Human 产品批准。报告还明确说明了本地信任边界：同源检查和键入确认无法从密码学上区分实体 Human 与拥有完整本机 OS/浏览器控制权的自动化进程。


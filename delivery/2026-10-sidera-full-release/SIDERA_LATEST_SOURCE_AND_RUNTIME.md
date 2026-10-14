# SIDERA 最新源码与运行事实（核查记录）

- 核查时间：2026-10-14 23:13–23:50 +08:00（开工核查快照；后续变更见 INTEGRATION_CHANGELOG）
- 核查人：DSH（本工作令执行者）
- 结论性质：仅记录可由命令输出复现的事实，不含推测性完成声明。

## 1. 真实 Git 工作树（依据：git worktree list；主仓库 .git 目录）

主仓库（唯一 .git 目录）：D:\Sidera-R1-v0.1.0\.sidera-dev\convergence\g3-stage\project

| 工作树 | 分支 | HEAD | 未提交 |
|---|---|---|---|
| g3-stage\project | master | f327c58 | 仅未跟踪 candidates/、desktop-evidence/（保护，未清理） |
| g3-grok-stage\project | g3-grok-acp | 3f9a331 | 仅未跟踪 desktop-evidence/ |
| g3-integration-stage\project | g3-integration-candidate | 5291668 | 干净（已是 master 祖先） |
| r1-chatfirst-contract\project | r1-chatfirst-contract | d80e936 | 干净 |
| r1-chatfirst-core\project | r1-chatfirst-core | e528e23 | 干净 |
| r1-chatfirst-edge\project | r1-chatfirst-edge | d322cb4 | 干净 |
| r1-chatfirst-integration\project | r1-chatfirst-integration | e2a7380 | 仅未跟踪 desktop-evidence/ |
| r1-chatfirst-runtime\project | r1-chatfirst-runtime | 741761e | 干净 |
| release-full-product\project（本次新建） | release/full-product-20261014 | 84c3c82 | 未跟踪 candidates/（构建产物） |

- origin/master = efe1ace；master 领先 origin 9 个提交。
- 工作令快照中的 HEAD 全部核对一致；D:\CodexProjects\Sidera 仍为指向 r1-chatfirst-integration\project 的 Junction。
- g3-grok-acp 相对 master 仅 1 个提交（+240/-18，6 文件，Grok Build ACP 会话集成），尚未并入发行基线，待评估。

## 2. 运行中的旧 Core 与端口（CIM 进程 + TCP 监听 + 实测）

| 对象 | 事实 |
|---|---|
| 旧 Core 进程 | PID 51436，node D:\Sidera-R1-v0.1.0\core\service.ts，启动于 2026-10-12 08:31 |
| 监听 | 127.0.0.1:8765（RPC）、8787 |
| 实测 | 8765 为自定义 RPC（非普通 HTTP GET）；GET /health 返回 SID-CORE-9000 unavailable JSON |
| 构建身份 | 无法追踪到 Git SHA：D:\Sidera-R1-v0.1.0 不是 Git 仓库；core/*.ts 与 r1-chatfirst-integration 71/73 相同，时间戳 2026-10-12 08:30，早于该分支 HEAD（10-13 00:38） |
| 保护 | 未停止、未迁移、未写入旧 Core 数据目录；所有实验使用独立临时 Profile |

其他相关监听（未触及）：SRB read-only 47311（PID 67000）、SRB R2 shadow 47312（PID 63292）、SRB R3.1 observe 47313/47314（PID 53472，supervisor PID 22408，notAfter 2026-11-13T05:00Z）、站内网关 8788（PID 52544）。

## 3. 源码 / 构建 / 运行三者差异（本次发现的真实漂移）

1. 部署目录含有未提交增量（2026-10-13 18:25–18:31 写入，Git 中不存在）：
   - hythes/remote-bridge-r2-readonly-mcp.ts：R2 shadow 只读 MCP 适配器（47312，list/info/read_text/read_many，精确 Chief 绑定授权）；
   - hythes/canonical-mcp.ts 中的 R2 注册；
   - tests/remote-bridge-r2-readonly.test.ts；
   - ui/public 下的 favicon 与 sidera 图标（仅部署侧存在）。
   处置：逐字恢复进发行分支，提交 ab11e2f（5 文件，+215/-1）。
2. 旧 Core（8765）运行的是 10-12 08:30 快照，落后于 Git 源；在重启用新构建前，界面已更新的说法都不成立。
3. ui/dist 缺失导致 tests/console-viewer.test.ts 失败（CONSOLE_UI_BUILD_REQUIRED）；已在发行工作树完成 typecheck 与 vite build。
4. 恢复 R2 工具后 tests/ui-completeness.test.ts 失败（能力目录缺 4 个 R2 条目）；已补齐，两测试转 PASS。

## 4. SRB 私有仓库保护（优先动作）

- 仓库：D:\Sidera-Remote-Bridge，master HEAD 052ef85。
- 开工实测未提交状态：18 个 tracked 修改（SRBWinOperator.cs、mcp-server.js、stdio-server.js、http/server.js、lib 下 bridge/config/errors/process-registry/tokens、tests、evidence JSON）+ 未跟踪 R3.1 实现（src/auth、tests/r31-*.cjs、tools、docs/R31_OBSERVE_DEPLOYMENT.md、package-lock.json、evidence 记录）。
- 保护措施：
  - 全量文件系统备份 D:\Sidera-Backups\srb-20261014-2313（git bundle 267,866 B、tracked-changes.patch 120,913 B、未跟踪实现副本、config/r31 运行态私有副本）；
  - 快照分支 r31/preserved-snapshot-20261014 = d09689f（43 文件，+5586/-413），逐字保留工作树内容；
  - config/r31（含 tokens.json 与运行态）仅离线备份，经 .git/info/exclude 排除，绝不进入 Git。
- 快照验证：npm test 178/178 PASS（34.1s，10 suites，evidence/validation.json）。
- 开工前 90 分钟无其他任务写 SRB；R3.1 OAuth observe 监督进程仍在设计内的到期运行，本次未停止、未改动其配置。

## 5. 本次新建的发行集成分支

- 工作树：D:\Sidera-R1-v0.1.0\.sidera-dev\convergence\release-full-product\project
- 分支：release/full-product-20261014（起点 r1-chatfirst-integration e2a7380）
- 已提交：ab11e2f 恢复部署侧独有的 R2 bridge 适配器与测试/资产；84c3c82 内建本机执行者 peregrine-local（含真实端到端测试）。
- 依赖：node_modules 以 Junction 复用 g3-stage 工作树，未改动任何既有工作树。

## 6. 当前最大真实阻断点（按严重度）

1. 运行时构建身份与源码不一致：8765 旧 Core 无法对应任何 Git SHA。需要由本发行分支重建并在用户确认的时机替换启动（涉及在线数据，先快照 SQLite/WAL）。
2. 可写产品面不足：默认 UI 入口（ConsoleApp）是只读观察视图；完整可写 ProductApp 仍藏在 technical=1 参数后。工作令明确只读控制台不算完成，需把创建/派发/授权/监控放回主界面。
3. 无外部账户时的完整闭环：本机执行者（84c3c82）已完成 任务->授权->派发->真实执行->证据->结果；仍需产品 UI 入口与本地监督者路径，才能让非开发者使用。
4. 公开 GitHub 发布：尚未确认本机 Git 凭据/远端仓库授权；未验证前不得声称已发布（后续报告单列）。
5. SRB 桌面控制（点击/输入/滚动）已实现，但真实桌面输入验收受人工本地同意约束；本次未伪造同意，列为待用户批准的 HOLD。

## 7. 复现方式（关键命令）

    git -C D:\Sidera-R1-v0.1.0\.sidera-dev\convergence\g3-stage\project worktree list
    git -C D:\Sidera-R1-v0.1.0\.sidera-dev\convergence\release-full-product\project log --oneline -3
    node --test tests/peregrine-host.test.ts
    cd D:\Sidera-Remote-Bridge ; npm test

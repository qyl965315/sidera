# SIDERA 集成变更记录（release/full-product-20261014）

所有提交均在发行工作树 release-full-product\project。每条含来源、作用、验证与回退方式；未验证项一律不写为已完成。

## 基线

- 起点：r1-chatfirst-integration e2a7380（master f327c58 + R1 Chat-first 集成 + 只读 Console）。
- 主仓库 worktree 机制不变；node_modules 以 Junction 复用 g3-stage 工作树，未改动既有工作树。

## ab11e2f - recover(integration)：恢复部署侧独有的 R2 Bridge 适配器

- 来源：D:\Sidera-R1-v0.1.0（非 Git 部署目录）2026-10-13 18:25-18:31 的未提交增量。
- 内容：hythes/remote-bridge-r2-readonly-mcp.ts（R2 shadow 只读适配器，47312，4 工具）、hythes/canonical-mcp.ts 的 R2 注册、tests/remote-bridge-r2-readonly.test.ts、ui/public 下的 favicon 与 sidera 图标。
- 验证：逐字恢复（git diff 仅 2 行注册差异）；R2 适配器测试通过；ui-completeness 一度失败后由能力目录补齐修复。
- 回退：git revert ab11e2f（部署侧原文件仍在）。

## 84c3c82 - feat(executor)：内建本机执行者 peregrine-local

- 内容：peregrine/task.ts（write_text 与 run_node 有界动作、durable started/completed、按精确 messageId 幂等、sha256 证据、started-without-completed 一律 UNCERTAIN 且不重放）；hythes/peregrine-host.ts（Hythe、SideraControlled Effect profile、非启动探针、终态结果流、completedTurn 重启后读取证据）；host-factories 与 service 注入 Core 拥有的 LocalPeregrineManager；local-setup 的 addLocalExecutor；真实端到端测试。
- 验证：tests/peregrine-host.test.ts PASS；全量 Core 套件 442/442 PASS（40.9s）。
- 回退：git revert 84c3c82（不影响既有 Host）。

## 05f28ef - feat(product)：经 Human 确认的本机执行产品路径

- 内容：LocalSetup.localExecute 记录字面 Human 意图、创建并接受精确 Responsibility 依据、再以 Chief Node 主体派发；development-profile 为已声明的内建执行者节点增加仅限自身 Core 工作域的 self.peregrine.run 与 contained workspace 项；peregrine/task.ts 真实承认 world_observation 回合且不启动工作；local-launcher 新增 local-executor 与 local-execute 路由（后者要求原生 Human 确认，并返回可幂等读回的 requestId）；ui/src/LocalExecute.tsx 与 ConsoleApp 面板（仅在已配置内建执行者且 Core 就绪时出现，只读 Viewer 不显示）；产品路径端到端脚本。
- 验证：scripts/e2e-local-executor.ts 结果 PASS，真实文件 PRODUCT_E2E_OK.txt，sha256=1fb5f0cfa9a3e9abd2c08dbf00f414da6cd6566db9a0b7741b7ab1a83157e0ae；证据见 SIDERA_E2E_EVIDENCE/local-executor/LOCAL_EXECUTOR_E2E.json。该 E2E 的原生确认由测试驱动响应完成，属集成测试，不构成 Human 同意声明。
- 回退：git revert 05f28ef；或仅停用 local-execute 路由。

## SRB 私有仓库（独立仓库，不随公开版发布）

- r31/preserved-snapshot-20261014 = d09689f：逐字保留 18 个 tracked 修改与 R3.1 未跟踪实现（43 文件，+5586/-413）；config/r31 运行态仅离线备份（D:\Sidera-Backups\srb-20261014-2313）并排除出 Git。
- 快照验证：npm test 178/178 PASS（34.1s）。

## 尚未完成（不得标为完成）

- 打包、安装器、干净机复核、SBOM、许可证、隐私扫描、GitHub 发布（含凭据核查）。
- SRB 与 RDC 的实测对比矩阵与基准、桌面控制缺口补齐、私有分发包。
- 运行时旧 Core（8765）替换为可追溯 SHA 的构建（需用户确认时机并先快照数据）。

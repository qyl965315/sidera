# Sidera Console · 用户可验证的桌面交付（2026-10-12）

## 产品定位与交付判定

**Console GUI = PASS；Sidera R1 真实 M0 = HOLD。**

Console 从原始复杂工作台收敛为两条一级入口：
- **项目：** Project → Task → Run 三列，点开 Run 查看关联 Host / Effect / Checkpoint 证据。
- **节点：** Node → Executor / 关联 Task / Host 健康，权限缺失和 UNKNOWN 明确显示。

日常 Console 不再暴露「工作」「通信」「身份」「集成」四个额外一级页面，也不再是另一处下达目标的聊天入口。高级配置仍由原有已审查的 Desktop 功能承担，位于必要时的高级管理入口，未删除后台规则和历史。通信记录继续由 Core 保存，按任务有关联的 Run 展示。

所有任务 / 项目 / 执行者状态必须来自 Core 或只读本机数据库投影；没有事实时显示空 / UNKNOWN，不生成模型推理、不自动重试，不用合成任务填真实页面。

## 用户可打开的成品

- 现有 Core 的只读管理模式（推荐）：`D:\Sidera-Console-R1\Open-Sidera-Console.cmd`
- Windows 桌面快捷方式：`Sidera Console.lnk`
- 独立便携程序：`D:\Sidera-Console-R1\Sidera.exe`

**应打开 CMD 启动器或桌面快捷方式**。它使用显式的 `SIDERA_CONSOLE_VIEW_ROOT=D:\Sidera-R1-v0.1.0` 连接已存在的真实项目，不更换账号、Core 或资料目录。单独打开 EXE 则是独立全新 Profile，二者的数据空间不同。

只读 Viewer 在隔离的 Electron Profile 和单独的非 Core HTTP 进程中运行，不调用 `startWorkbench`、`launchCore`、`stopLocalCore`；它没有管理 POST 入口。退出时只关闭自己的 HTTP listener，绝不停止正在运行的 Core / P5。

安全读取：复制原 SQLite + WAL 到独立暂存路径，在复制前后进行 SHA-256 一致性核查；若源文件变化则读操作以 UNCERTAIN 失败，不把不一致快照当事实。只打开临时数据库，允许 SQLite 在临时位置创建 shm；读取完毕立即销毁副本。全新空本机 World 可以直接展示空 Project / Node，但没有 Human 授权的非空 World 保持拒绝读取。

## 本次验收证据

- 全量 Core 回归：**432 / 432 PASS、0 FAIL**（包含新的严格只读 Viewer 边界测试）
- TypeScript 主仓检查、Console Vite 编译：PASS。
- 独立前端点击烟测：PASS（只有两个一级入口、Project→Task→Run、Node/Executor、错误时不显示模拟数据、无管理写操作）。
- 旧后台管理交互烟测：PASS，说明高级操作没有因 GUI 收敛被删除。
- 真正的便携 EXE：Windows Electron 启动 PASS；真实 Canonical 本机读取、合成任务分列和节点权限呈现分别验证 PASS。
- 真实 Core Viewer：**1 个 Project，2 个 Node，0 个 Task**；准确展示未获授权的 Codex。没有派发任何真实 Host Turn、没有模型推理调用；Viewer HTTP POST 返回 405，退出后 Core 8765 仍可连接。
- 打包隐私扫描：PASS，未包含生产私有 DB、凭证或日志。
- 真实原 Core 截图：`D:\Sidera-R1-checkpoints\console-product-20261012-v4-real-review\real-projects.png` 与 `real-nodes.png`。
- 合成任务 GUI 截图（**不是生产任务**）：`D:\Sidera-R1-checkpoints\console-product-20261012-v4-standalone-review\synthetic-project-task-run.png`。
- 生产 M0：**HOLD**；CC → Codex 的精确任务派发 Grant 尚未由真实 Human 本机入口采纳，Codex Host 状态仍未验证，真实 Task→Run→原 Chat 回程仍缺证据。

## 未解决 / 不能误报

1. 正常运行的 Console 不会冒充 CC 发任务，也不会代替 Human 执行 Grant / OAuth / Host 操作。
2. 真实生产中暂无 Task。Task 和 Run 的完整分列交互已通过合成测试，但**尚无真 Agent Task 完成的生产证据**。
3. 对现有 Core 的 GUI 观察既不是证明 Sidera 的所有 Operator 可用，也不是证明实际 M0 / M0+ / M1 完成。
4. 若设备的原 P5 服务（47321/47322）已经离线，须用其原始所有者生命周期单独调查；本轮没有以名称 / PID 停止它。
5. 安装包是本机 Windows x64 非签名便携候选，暂不等同于经过发布签名与跨电脑测试的正式公开版本。

## 代码组织

本次不建立第二套事实或调度。
- `ui/src/ConsoleApp.tsx` + `ui/src/console.css`：两入口、分列显示与细节。
- `ui/integration/project-world.mjs`：Canonical Project、Task、Run、Node 投影。
- `ui/integration/local-human.mjs`：单一本机 Human World 只读快照。
- `scripts/console-viewer.ts` + `desktop/viewer-worker.ts`：只读连接现有 Core 的 Windows Viewer。
- `desktop/main.cjs`：显式 Viewer Profile 与 Worker 选择，退出绝不触发 Core stop。
- `tests/console-viewer.test.ts`、`ui/scripts/console-smoke.mjs`、`desktop/console-viewer-smoke.mjs`：测试与验收。
- `scripts/p0-human-minimal-grant-review.ts`：尚未执行的最小 Human 审批辅助程序；Grant 不会因文件存在而生效。

**后续只剩真实 M0 与用户最终体验验收；不能拿上述 432 个本地 PASS 冒充生产 AI 派发成功。**

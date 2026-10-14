# Sidera 迁移与发布手册（第二轮交付物）

## 第一部分：GitHub 权限如何提供（安全方式，切勿在聊天中发送令牌）

推荐顺序（任一即可，A 最安全）：

A. 你在本机安装 GitHub CLI 并登录：winget install GitHub.cli 然后 gh auth login（浏览器 OAuth，令牌不经过聊天、不落盘明文）。登录后告诉我，我用 gh 创建仓库、推送、打 tag、创建 Release 并回读下载内容校验。
B. 你创建空仓库（例如 sidera），把仓库 URL 给我，并在本机配置凭据：git config --global credential.helper manager，然后首次 push 时由 Git Credential Manager 弹出浏览器登录。
C. 你创建细粒度 PAT（仅 content:read/write，限定该仓库，最短有效期），以环境变量方式提供给我运行的一次性会话，例如在 PowerShell 中 $env:GITHUB_TOKEN=... 后在同一会话启动我；不要粘贴到聊天。用完立即吊销。
D. 你完全自行发布：我提供已打包产物、SHA256SUMS、发布说明与逐条命令，你在自己的终端执行。

我不会：索要账号密码、把令牌写入仓库或日志、替你做 OAuth 页面上的同意、或在你未授权前声称已发布。

## 第二部分：旧 Core（8765）受控替换流程（需你确认后执行）

前置条件：新安装包已通过干净机安装与本地 E2E；数据快照校验通过；回滚包与旧启动命令已备份。

步骤 1（只读快照，不改动运行）：记录 PID 51436 与命令行、8765/8787 监听；复制 D:\Sidera-R1-v0.1.0\.sidera-dev\sol\data 下 sidera.sqlite、-wal、-shm 到带时间戳的备份目录，并对复制前后各文件做 SHA256 一致性核对；若源文件在校验期间变化则中止并重试。
步骤 2（停止旧 Core）：仅通过其所有者界面/进程所有者执行优雅停止；若其拒绝停止（存在未完成回合），保持原状并记录阻断，绝不强杀。
步骤 3（启动新构建）：用发行分支构建的启动器指向同一数据目录启动；确认构建身份输出与 Git SHA 一致（build-identity 记录），且 8765 由新 PID 占用。
步骤 4（迁移核对）：对比启动前后 Project/Node/Task/Run 行数与关键状态、权限包、证据事件；执行一次只读状态查询和一次本机执行任务（写入测试文件），核对哈希与证据落库。
步骤 5（回滚演练）：在另一目录用备份副本启动旧构建，确认可读旧数据；保留回滚脚本与备份路径。只有演练通过才视为替换完成。

失败判定：构建身份不符、行数/状态不一致、证据缺失或出现 UNCERTAIN 未调解，立即回滚并保留现场（日志、截图、事件 ID）。

## 第三部分：第三轮复现与人工验收入口

供其他 Agent 复现：node scripts/e2e-local-executor.ts（产品路径 E2E）；node --test tests/peregrine-host.test.ts；node --test tests/*.test.ts（全量 442）；npm --prefix ui run build；node desktop/packaged-boot-check.mjs <candidate>。
供人工验收：解压 candidates/r1-desktop，双击 Sidera.exe；首次使用；在已配置内建执行者且 Core 就绪时使用本机执行面板；确认原生确认对话框出现；核对生成文件与证据。

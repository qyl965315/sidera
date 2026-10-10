CHANGES_MADE

# Sidera R1 — Codex 独立审核、修改与续跑结果

工作区：`D:\Sidera-R1-v0.1.0`。日期：2026-10-08（Asia/Shanghai）。本报告包括原 Codex 独立审核及断线后从原工作区继续的收尾，没有重新开始审核，也没有重跑六套完整验收。

**结论：本轮确实修改了代码、配置和文档；Core 当前 READY，本地 Gateway / constitutional reads 可实际调用；真实 Chief → Operator → result → Chief 未完成。唯一一次完整验收的原始结果是 FAIL，必要修补后的定向验证通过。不能把它改写成“全套全绿”或真实跨 Node E2E 已验收。**

## 1. 独立证据与恢复范围

独立阅读了四份指定文档、canonical MCP / RPC / Rules / Authority / History / Sovereignty / Host / frontend 接线，并通过 live SQLite、Core RPC、HTTP MCP、实际隔离 Codex app-server、实际 connector 调用复核关键结论。没有把 DSH 报告作为当前运行事实。

最初 Core 8765 与 Gateway 8788 均为 ECONNREFUSED，旧 Core owner 已死；恢复后才进行 baseline probes。[初始证据](evidence/codex-review/before-live.json)记录这一差异。DSH 曾经完成的 live 调用不能推出交棒时服务一直在线。

修改前建立私有恢复点 `.sidera-dev/codex-review/checkpoint-before`：299 个纳入 manifest 的源文件逐一验证 SHA-256；SQLite 使用一致性 backup；保存 runtime spec、Gateway config / OAuth state 和两个 Node 的私有 Sovereignty current files。manifest SHA-256：

`acf67b3fe8bf2adc3dd259506dbfa4c0c51c646c01426792f83d70e042afae83`

[恢复点核对](evidence/codex-review/checkpoint-verification.json)：299/299 源副本匹配，SQLite backup quick_check=ok，两个私有 current file 的 hash 与 live 相同。此 checkpoint 是列明文件的恢复范围；ui/scripts/ux-smoke.mjs 的修改前内容不在这 299 个文件中，不能声称整个工作区每个文件都有同等 preimage 证明。新增诊断脚本、生成资源和本报告另列于证据。工作区没有 Git 元数据，sourceCommit / loadedCommit / sourceDirty 均为 null，没有虚构 commit。

## 2. 实际代码修改

| 范围 | 修改与原因 | 主要文件 |
|---|---|---|
| 单一 northbound operation truth | 保留 canonical 注册导出，补齐 node.rename；修正 presentation / source / history 的 RPC label aliases。每个 canonical registration 都进入 registry，命名映射不能决定 membership；collision 拒绝启动。Codex stable outer surface 复用唯一 GATEWAY_TOOL_NAMES。 | `hythes/canonical-mcp.ts`、`tool-catalog.ts`、`mcp-gateway.ts`、`codex.ts` |
| canonical schema / D/E | Gateway 直接调用 handler 时先执行 canonical strict schema；subjectivity MCP strict；Core 用 Object.hasOwn 拒绝包括 null 值在内的 Node selectors。此前“callback 没用 selector”不等于拒绝了 selector。 | `hythes/mcp-gateway.ts`、`subjectivity-mcp.ts`、`core/rpc.ts` |
| Rules procedure 完整接线 | RPC 与 Native Human path 支持 reviewTaskIds，拒绝单个 ID / 数组混用；按 governing policy 处理 required / optional / none Human；AuthorizedOperator 必须真为 Operator；count 按不同主体计算；验证所有提供的 reviews，不截断后忽略额外 ID。Console 展示实际 policy、选择多个已完成 reviewer，policy 缺失时拒绝伪造确定性。 | `core/constitutional-rpc.ts`、`local-setup.ts`、`rules.ts`、`constitution.ts`、`desktop-management.ts`、`ui/src/ConsolePanel.tsx`、`ProductApp.tsx` |
| World bootstrap 与治理分离 | 原 World 分支永远返回 bootstrap。现在 first World 仍按 bootstrap；后继 World 固定当时 current World 的 governanceVersionId，将其纳入 proposal digest / immutable version / History；由已采纳 World.policy.worldReviewPolicy 决定后继程序。policy.reviewPolicy 继续治理子级。stale 未采纳提案拒绝；原主体已采纳 receipt 幂等返回；机器 World 不得扩大治理祖先 boundary。只实现显式 procedure，没有 autonomous Rule Evolution engine / 元胞自动机。 | `core/rules.ts`、`constitution.ts`及上述 RPC / Native / Console 接线 |
| Ω / conflict / Authority | 冲突恢复用实际 governing procedure，不用被恢复 Rule 的 child / successor policy；canonical proposalObject 同时用于 digest 和 adoption projection，避免重新拼装漏字段。机器采纳 Project / World 的 standing Grant 追溯已存在、已 applied 的真实 Human ancestor；新 Grant 不会生成假的 Human act，current hierarchy / boundary / ancestor validity 继续约束。 | `core/history.ts`、`authority.ts`、`rules.ts` |
| Chief canonical scope | admission、Authority discovery、dispatch 使用 binding.projectRef；projectSpaceId 只作兼容输入，不替代 canonical resource identity。Chief 仍是 Communicator 的 Project Conversation role。 | `core/chief.ts`、`rpc.ts` |
| Host health 粘滞 | 新增有界按需 exact locator probe；status、显式 activation、新请求分配和 execution admission 重新探测。recheck exact Node / Session / locator tuple；诊断只写 host.health.observed，不创建 Agent turn。恢复 Host cache 不重放 uncertain work，不替换既有 context。Authority denied 与 Host unavailable 分开报告。 | 新增 `core/host-health.ts`；`core/chief.ts`、`rpc.ts`、`runtime.ts`、`service.ts` |
| Presence / return route / ingress | 历史 UI_ROUTE_VERIFIED 不再成为 exact Presence，也不会遮蔽较旧的真实 transport evidence。新增 actual Gateway health observation：本地 / 公网须匹配同一 live instance ID、六个 stable tools、config digest 与 bound Node，观察过期 fail closed。30 秒基础设施观察不产生 Agent turn、Presence 或 delivery。兼容 native 8787/8790 profile 保留，但不再是唯一 ingress 来源。 | 新增 `hythes/gateway-ingress.ts`；`core/activation.ts`、`frontend-presence.ts`、`service.ts`；`hythes/mcp-gateway-cli.ts`、`human-boundary.ts`、`frontend-factory.ts` |
| Codex stale executable pin | 仅在旧 owning-product pin 缺失时，允许同一 Codex bin 下唯一版本 slot；拒绝链接 / junction，核验 OpenAI Authenticode、CLI version、before/after hash；runtime spec whole-file CAS + durable atomic replace。只改变 executable path，记录实际 Effect receipt。 | 新增 `core/codex-pin.ts`；`core/service.ts` |
| OAuth reconnect / credential boundary | 新增 durable rotating refresh：client / edge / Node / audience / scope 绑定，refresh 只存 digest，固定 family expiry，reuse 撤销 family，拒绝 scope 扩大和 Node 重绑定。保留 legacy / revoked / expired access receipts；无原始 Node binding 的旧 token 要求真实 reauth。public PKCE 在无 resource-owner authentication 的 R1 流程中不能签发 Node credentials；当前 edge 转为 confidential client。Gateway 要求 sidera.mcp scope，空 scope 返回 403；过期 / 无效 token 401 + WWW-Authenticate。 | `hythes/mcp-oauth.ts`、`mcp-gateway.ts` |
| UI catalog 与验证接线 | UI canonical catalog 从真实注册生成并可 --check，保留独立的非执行 interface-map reference rows，补上 node_rename。修正 smoke fixture 的实际 governing policy / 按钮文本，增加有针对性的 policy UI probe；重生成 UI assets。 | 新增 `scripts/generate-capability-catalog.ts`、`ui/scripts/rules-review-probe.mjs`；`ui/src/capability-catalog.json`、`ui/scripts/ux-smoke.mjs`及相关 tests |

## 3. 设计底线复核

Node ontology 仍是 Communicator / Operator（Agent / Bot）；Chief role 不新建 Node，Executor 无独立 Sovereignty，Console.isNode=false。保留的 chiefNodeId 字段是兼容命名，不是 canonical “Chief Node”。

Capability discovery、Effect、D/E、Authority、Responsibility 保持分离。D/E 仍是每 Node 私有 current pair + CAS；本轮 live selector denial 在 schema 前沿拒绝 nodeId:null，没有使用它读取任何 Node 的私有语义内容。私有文件仅核 hash。

Claim 不可直接带 deltaOmega；proposal 仍作为 Claim，实际 adoption / Effect 才沿 typed History procedure 改投影。Ω 仍从 Shared History + Basic deterministic Apply 产生；operational indexes 和不可变版本记录是执行 / 追溯载体，没有增加第二套 Ω store。冲突修补验证的是既有精确采纳及其 governing procedure，没有让机器选择创造新的政策真相。

Derived Grant subset、ancestor revoke / expiry、current Rule hierarchy 继续约束授权。Responsibility 仍是 traceability；Consequence 使用已采纳的 named Rules、精确 completed review 和实际 Effect / Authority restriction。没有加入 Basic “必须诚实 / 必须正确”的保证。本轮不宣称完成所有未来 Rule 演化语义。

## 4. DSH 八项 claim 的独立结论

| DSH claim | 独立结论 |
|---|---|
| 1. Gateway registry 从 canonical 注册自动导出 | **核心 membership 改动证实。**仍发现 label aliases、node.rename omission、Codex outer surface 和 UI catalog 未完全接线，已修。 |
| 2. live Gateway constitutional operations 可调用 | **恢复服务后证实。**接棒时服务已停。history.list、omega.inspect、rules.list、executor.list、chief.conversation_role、node.ontology 六项实际 loopback MCP read 完成；最终加载后再次复核 rules.list / omega.inspect / node.ontology。该证据不代表云端 connector 可用。 |
| 3. expired token 500 改为 401，正常 PKCE 可工作 | **局部证实。**实际 HTTP expiry / challenge 通过；但无 refresh 导致 durable reconnect 不完整，且原 public auto-issuance 没有 resource-owner authentication，是 material credential gap。已修 confidential issuance、refresh rotation 与 scope boundary。 |
| 4. server 有 sidera_read，connector schema 旧 | **证实。**最终本地 tools/list 为六项；当前已加载实际 connector 只有五项、缺 read，调用返回 UNAUTHORIZED / requires reauthentication。需要产品侧 Human 刷新 / 重新授权，不改原 Chat binding。 |
| 5. reviewer topology 已下放 versioned Rules policy | **不完整，原结论过强。**多 reviewer RPC、optional Human、Reviewer 类型、Console、conflict、machine standing Authority 以及 World 永久 bootstrap 分支均有漏接。本轮已修，并有八项最后 World / Authority / conflict / Native 定向验证。 |
| 6. subjectivity.* strict reject selectors | **原实现未完整成立。**null selectors 与 Gateway schema bypass 仍能被 callback 丢弃；现在 strict schema + Core own-property reject，live null selector 返回 REJECTED。 |
| 7. Core ready，真实闭环 blocked | **总体证实并细化。**初始 Core 停止，恢复后 READY。stale pin 已安全自动修复；隔离未登录、非法 thread locator、真实 Authority / adoption、connector reauth、公网 ingress、Presence / route 仍阻止闭环。没有因为审计者是 Codex 就宣布 Sidera Codex Node available。 |
| 8. 331/331 core、16/16 desktop、UI / evidence 全绿 | **只保留为 DSH 的历史 claim，不能用作当前验收。**本轮唯一完整验收是 340/344 core，check / UI smoke 失败；desktop 16/16、UI build、evidence check 通过。失败项定向修补已通过，完整六套未重跑。 |

## 5. Additive migration、配置与数据保持

最后 live snapshot：`2026-10-07T23:54:50.781Z`（北京时间 2026-10-08 07:54:50）。Core PID `23456`，Gateway PID `35056`；Core /ready 与本地 Gateway /readyz=200，Core READY。加载的 sourceDigest：

`c0e9c4925b4e7ec65736ca4f70ca3dbe8bb2f75776d794789956874e82479635`

[最终加载后 live 证据](evidence/codex-review/resumed-final-live.json)记录 ready、Chief separation、六项 outer tools、三项 canonical reads、严格 selector rejection、confidential S256 PKCE 302→200 + refresh issuance，以及实际 public probe timeout。此 PKCE 是本地诊断，不是 ChatGPT 产品侧重新授权。

实际 config 变化只两处：

- runtime-spec：`nodes.1.options.codexExecutable`，从缺失 slot `f544b3844e0f14e9` 改为唯一合法 slot `9691020b546a15b2`。版本 `codex-cli 0.162.0-alpha.2`，OpenAI OpCo LLC valid publisher，binary SHA-256 `3553cd6e7df5a093d8cb8301cd8088a57e0971aba71ddbe0e67f7f44a15cdf68`。
- gateway.json：同一个 chatgpt edge 仅增加 `oauth.clientSecret`。clientId、Node、Core credentials、redirect URIs 不变。私有 [connector import profile](.sidera-dev/sol/data/codex-review-connector-import.private.json)供 Human 产品侧使用；报告与 public evidence 不写出 secret。

新增 `rule_proposals.governance_version_id`、`rule_versions.governance_version_id` 两个 nullable 列已 live 验证。旧 null 不进入原 object digest；没有改写历史版本 / review / Human acts / History。历史 pending World proposal 若没有治理 pin 且已有 current World，则 fail closed，须提出新的 exact proposal；当前 live proposals / versions 均为 0。

| Live durable object | 原始 → 最终 |
|---|---|
| Nodes / Sessions | 2 / 2 → 2 / 2；全部原行匹配 backup |
| Tasks / Runs / Messages | 0 / 0 / 0 → 0 / 0 / 0 |
| Grants / Rules versions / Rules proposals | 1 / 0 / 0 → 1 / 0 / 0 |
| HumanSemanticActs | 2 → 2；全部原行匹配，原有 acts 不是 Rules adoption |
| Shared History | 9 → 10；仅新增实际 executable re-pin Effect receipt，未以它改 Ω |
| Exact Presence / prepared route records | 0 / 0 → 0 / 0 |
| 私有 D/E current files | 两个 hash 保持不变 |

chief_conversations 与 project_chief_roles 全行匹配 backup。原 binding `cf6b0d22-e4ec-41e1-8ad1-5176fc0f0cf3`、canonical Project `sidera://project/local`、Communicator `ba3cb7ac-b601-4706-920d-d540960c3b4f`、exact Chat `https://chatgpt.com/c/6ac50f7f-4a6c-83ee-81ad-1e359d31c4b9` 保持原值；没有新建 / 替换 Chat、发送 prompt 或标记 Human 已观察结果。

重启仅通过 exact Core owner stop（accepted、0 open work）和本轮自有 Gateway PID / executable / command / creation-time 核对后进行。没有停止 Human-owned devtunnel，没有删 live data、发布、打包或上传。

## 6. 真实闭环与剩余 material blockers

**Live E2E = NOT COMPLETED；实际 model turns、Task、Run、message 均为 0。**以下是已观察 blocker，而非用测试或 model/list 推测可用：

| Blocker | 已证实事实 | 归类 / 必要步骤 |
|---|---|---|
| Rules / Authority | 无 adopted World / Project；只有原有非跨 Node self Grant；Codex state=authority_denied | **Human semantic decision gate。**按实际 governing policy 采纳 exact Rules / scope，授予所需 work / return Authority；本轮不代签、不伪造。 |
| 隔离 Codex account | 最终相同 CODEX_HOME 下 login status exit=1，Not logged in | **Human-only account login。**仅登录 `isolated-codex-host.json` 中列明的独立 home，不能借当前审计 Codex 或默认 account。 |
| Codex exact context | 实际 app-server initialize / model/list 完成（8 models），thread/read 对现存 installed:// locator 返回 -32600 invalid thread id，locate=false；最终 exact Host probe unavailable | **Host / runtime admission blocker。**登录后由 owning Host 创建或恢复真实 thread，并按适用 review / admission procedure 接入。创建 / 审阅主体由相应 Rules 决定，不能由审计者悄悄替换旧 Session / locator 或假定这是 Human-only review。 |
| 实际 ChatGPT connector | 当前加载五项旧工具；实际 status 调用 UNAUTHORIZED / requires reauthentication；之前精确错误 oauth_refresh_token_missing | **Human-only product authorization / schema refresh。**使用私有 confidential import profile，刷新或重建 connector / reauth，保留 exact Chat binding。 |
| 公网 ingress | 本地 healthy / ready；公网 health timeout，remoteReady=false。先前 owning devtunnel show exit=1，SSL connection could not be established | **外部 network / TLS / owning tunnel blocker。**本轮不能据此定位到证书链或网络的具体根因；原 tunnel owner process 存在也不等于 ingress 可用。没有换账号 / 隧道、关闭 TLS 校验或结束原进程。 |
| exact Chief Presence / return route | exactPresenceVerified=false、returnRouteVerified=false；记录计数均为 0 | **真实 transport procedure gate。**所属 Communicator 的 authorized frontend prepare / protocol verification 须产生当前 exact Presence 与 route；UI history、tunnel health、MCP discovery 均不能替代。 |

Host locator 非法不是“登录之后必然恢复”的同一个问题；OAuth reauth 也不会自动授予 Sidera Authority。这些 gates 必须分别满足，才能发起一次有 correlated result / Chief return 的真实任务。遇到 uncertain delivery 必须 reconcile 原请求，不能重发或创建 replacement work。

## 7. 可行的 Human adoption path

当前 bootstrap 只提供 procedure，不声称已有 adoption。存在可解释的 backend / Console 路径，Native exact preview / apply 及多 review ID 接线已在隔离 fixture 中验证；fixture 不是 live Human 批准。

1. 由拥有当前 World 的 Node 提出 exact World object（parent=`sidera-r1-constitution/1`、精确 boundary / policy），只形成 proposal Claim。Human 在 Console / Native boundary 核对 proposalId、digest、scope 并实际采纳首个 World。
2. Human 可在该 World 的 `policy.reviewPolicy` 明确选择 Project 的 procedure。如果希望先建立最小可执行治理而不依赖尚未可用的 Operator，可明确选择 Human-only Project procedure（Human required、machine count=0）；随后按该 governing procedure 真正采纳 exact Project，包含 Human 选择的 bounded standing Authority。此处是可供 Human 决定的路径，没有替 live Human 创建对象或预选授权。
3. 若 Human 保持 bootstrap Machine+Human Project procedure，则先经真实 Human boundary 给 review work 所需的有限 Authority，恢复真实 Operator Host，执行 exact object-bound review；再携带全部实际 completed review IDs 进入 Human preview / apply。不能用 auditor 的判断或临时 SQL 伪造 review。
4. Node 只能 materialize 自己在已采纳 Rules 中的 exact standing Grant，不能扩大其 scope；之后再核对执行 Host、实际 connector ingress、exact Presence / return route，才有条件完成 live E2E。

World 后继程序使用已采纳 `worldReviewPolicy` + exact governanceVersionId；它不会取消当前首个 World 的真实 Human gate。是否独立、是否 self-review、count 和 Human involvement 均来自 applicable policy。

## 8. 唯一一次完整验收与必要 focused follow-up

[原始统一验收](evidence/codex-review/final-validation.json)：2026-10-07T19:21:00Z 至 19:21:32Z，每个指定命令只运行一次。该原始文件与日志没有被改成 PASS。

| 原完整命令 | 实际原始结果 | 修补后的证据范围 |
|---|---|---|
| npm run check | FAIL：3 个 TS diagnostics（SQL return 类型收窄、Gateway test fixture 两处 spec/runtime edge 混用） | 必要类型修复后，有限 compilation roots + imports 通过；最后 6 roots、447 source files、TypeScript 7.0.2、0 diagnostics。不是再次执行全项目 check。 |
| npm test | FAIL：340/344；4 项失败为 ingress fixture、旧 timer guard、status-event 断言、缺 node_rename catalog row | 四项失败 + 两项受影响 Rules / Authority 行为的 focused filter 6/6 通过。后续 World repair 另有 8/8 定向检查。 |
| npm run desktop:test | PASS：16/16 | 未重跑。 |
| npm --prefix ui run build | PASS | canonical catalog 更新后只通过 Vite API 重生成 ui/dist assets，没有重跑 npm build / 完整验收。 |
| npm --prefix ui run test:smoke | FAIL：旧 fixture 未带实际 policy、旧按钮文本断言 | fixture 已修；实际 Console focused UI probe 覆盖 World Human preview、optional Human + 两 reviewer IDs、none Human 三分支并通过。完整 smoke 未重跑。 |
| npm run evidence:check | PASS | 未重跑。 |

原补充 constitution static audit 9/9 通过，发生在最后 World 修补之前，不把它冒充最后全部源码的静态重验。

[原 focused follow-up](evidence/codex-review/focused-validation.json)保留了首次 TypeScript API harness 失败；安装的 TypeScript 7 只从包入口导出版本，旧 API 检查没有实际检查源码。续跑改用已安装 compiler binary。[续跑 focused record](evidence/codex-review/resumed-focused-validation.json)记录类型通过、OAuth 3/3（expired 401、bound rotating refresh / replay、empty scope 403）和 UI asset generation 成功。catalog --check 对 79 条 canonical tool records 通过。

World 新修补首次 focused run 的缺失 import、projection 漏字段和断言文本错误也完整保留在 [world-focused-validation.json](evidence/codex-review/world-focused-validation.json)。修复后 [world-focused-final.json](evidence/codex-review/world-focused-final.json)两项均 PASS：最后有限类型检查与 8/8 行为检查，覆盖 initial bootstrap、governance pin、old pending rejection、receipt、真实 Human provenance、机器 boundary narrowing、World conflict recovery、既有 Project / Native path。

**本轮的 global full-validation 状态仍是原 FAIL；所有已识别失败及最后修改的必要 focused checks 通过。受“不得重跑六套”约束，最终全部源码没有第二次全套验收结果。没有以 focused PASS 或本地 Core READY 代替真实闭环验收。**

## 9. 交棒边界与保留债务

用户列明的六项 DSH debt 均作实质处理：actual ingress 取代只看 legacy profile、node.rename 恢复北向、RPC aliases / membership 约束、Host 按需重探、UI freshness 不冒充 Presence、安全限定自动 re-pin。

保留非 material 兼容内容：chiefNodeId / projectSpaceId 字段名称、legacy native profile、operation 名称语义例外映射及非执行 interface-map reference rows。它们不再控制 canonical membership、Node ontology 或生产 Presence。适用 procedure 中对 Project-scoped Chief 的选择仍要求 exact Project binding；World procedure 不接受没有 Project scope 的 Chief selection。

已复现的 material source / integration defects 已在本轮修补；上述 live adoption、account、product auth、非法 locator / admission、外部 ingress、Presence / route 和全局验收覆盖限制继续保留。不是无变化点头，不是产品发布批准。

更新的现有文档：SIDERA_R1_CONSTITUTION.md、SIDERA_R1_IMPLEMENTATION_RESULT.md、SIDERA_R1_MIGRATION_MAP.md、SIDERA_R1_DSH_REVIEW_REVISION_RESULT.md、R1_USABILITY_CLOSURE_REPORT.md。本文件是本轮最新交棒报告；原历史结果保留并注明适用范围。

交付前服务检查 [final-service-status.json](evidence/codex-review/final-service-status.json)：2026-10-08T00:16:48.269Z（北京时间 08:16:48），Core 仍 READY，加载 sourceDigest 相同；Chief BLOCKED，实际公网 ingress / exact Presence / return route / Operator Authority 与 Host blocker 仍存在；Tasks / Runs / Messages=0，Human acts=2，Rules=0。

附加可核对记录：[源码变更 manifest](evidence/codex-review/source-change-manifest.json)列出与 checkpoint 相比的 39 个修改、7 个新增源文件 / 文档、0 删除，以及不在 checkpoint preimage 范围内的 UI smoke 文件；[最终数据保持检查](evidence/codex-review/final-preservation-verification.json)记录 Human frontend sources / 私有 current hashes 不变、live SQLite quick_check=ok；[实际 connector surface](evidence/codex-review/actual-connector-surface.json)记录当前五项 callable tools、缺 sidera_read 与实际 reauthentication 错误。

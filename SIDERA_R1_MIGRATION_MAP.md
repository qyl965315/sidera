# R1 constitutional migration map

Workspace: `D:\Sidera-R1-v0.1.0`. No `.git` metadata was present at task start.
Source checkpoint: `D:\Sidera-R1-checkpoints\constitutional-20261007\source-before.zip`;
its adjacent `.sha256` is the authoritative pre-change digest. Runtime credentials
and `.sidera-dev` are excluded. No package, publication or release is produced.

| Prior representation | Canonical representation / compatibility boundary |
| --- | --- |
| Generic Node / informal Agent role | `node_ontology`: Communicator, Operator → Agent/Bot; same stable NodeRef |
| `chiefNodeId`, `CHIEF_NODE_IDENTITY` | Project Chief Conversation role; old fields remain runtime compatibility references |
| One active Session per Node | Default adapter context remains unique; admitted parallel Operator Executors have their own exact runtime context |
| Disposable Session-as-subject | Conversation/Executor sub-unit, no independent D/E or Authority |
| SQLite `node_subjectivity` body | `<database-file>.sovereignty/<NodeRef>/current.json` is canonical; SQLite content scrubbed only after verified durable local publication |
| `sovereign_memory` / `self_state` | Historical frozen compatibility data; never a new current Sovereignty ontology |
| Events and mutable operational rows | Typed append-only `shared_history` plus recognized public-column Effect adapters; old event records retained |
| Mutable state treated as second truth | Ω reduced from History; no public state-write RPC |
| Adapter `supported:true` | Discovery inventory; current availability requires actual operation evidence, freshness separate |
| Disabled Node delegation | Parent-linked Derived Grants under ancestor and applicable Rules boundaries |
| Assignment-only responsibility | Historical provenance + Ω + action-time Rules; structured review and consequence records |
| Frontier management concept | Console, Human interface to Boundaries, not a subject |

## Migration ordering and recovery

`openDatabase` runs existing compatibility migrations, initializes History, ontology,
Authority/Rules and Executor metadata, and installs history adapters transactionally.
Sovereignty file migration follows through its own crash-safe publication boundary.

For each existing Node, migration publishes and verifies local D/E before blanking
SQLite's description/explanation content. A local committed receipt reconciles a
SQLite metadata interruption; a missing established canonical file fails closed.
SQLite metadata writer serialization prevents concurrent self-writes; whole-file
atomic replacement preserves D/E as a pair. Path-unsafe NodeRefs map to a stable
hashed directory while retaining the exact NodeRef inside the document. Node-visible
file/source brokers reject the private region even through filesystem links.

Historical operational snapshots are labeled `compatibilityImport` with original
act time UNKNOWN. Migration does not pretend to reconstruct unrecorded past acts.
The imported snapshot and subsequent recognized deltas are the replay basis for Ω.
History update/delete triggers reject ordinary mutation. No canonical history is pruned.

The active Chief binding is projected into `communicator_conversations` and
`project_chief_roles` without changing its ID, exact Chat reference, Project, grants
or pending messages. Migration does not open a Chat, refresh Presence or send a prompt.
Unadopted historical Project Rules remain explicitly `legacy-unadopted`; migration
does not synthesize Human adoption or mint new Authority.

An existing active runtime context remains the default. A formerly active context
later put into standby is not automatically granted parallel routing. A new exact
parallel context requires a completed Chief machine review, current Authority,
actual Host verification and explicit admission. Historical uncertain work stays pinned.

## API integration

The canonical MCP tool registry exposes typed history/claim/Ω, Rules proposals and
review, standing Rules grants, consequence, ontology and Executor operations. It
does not expose arbitrary History append, ΔΩ assignment, Basic Rule mutation,
Node World adoption or another Node's D/E. `subjectivity.get/revise` accept no subject
selector. Caller authentication determines the sole accessible private region.

The northbound Gateway operation registry is derived from that canonical
registration at call time; there is no second hand-maintained operation list. The
six stable gateway tools do not change as the internal catalog grows, and a
canonical operation Core already serves cannot be hidden by a stale gateway list.
Reviewer topology travels in `policy.reviewPolicy`; the World/Project/Task
arrangement is the labeled R1 bootstrap policy, not a Basic invariant. An expired
OAuth access token returns a 401 `invalid_token` challenge with resource metadata
so the owning product can re-authorize; it is never reported as a server error.

Existing Task/Run/Message/Grant IDs and RPCs remain compatible. Canonical views use
Chief Conversation, Communicator/Operator and Executor; legacy Session fields remain
adapter/runtime locators. Compatibility does not waive Authority or Effect gates.

## Validation scope

Focused tests cover the constitutional acceptance cases, migration/restart, RPC/tool
exposure and exact synthetic Host execution. Full validation commands are recorded
in `SIDERA_R1_IMPLEMENTATION_RESULT.md` and `evidence/r1-constitutional-validation.json`.
Fixture evidence does not certify an external provider, account, product quota or
Human Chat return route. No new remote-host E2E result is inferred from these tests.

## 2026-10-08 Codex revision 的 additive 接线

- 无 destructive SQLite migration；现有 Node、Session、Rule、History、Grant、Human-owned Chief binding 的身份不变。
- canonical MCP 增加 node_rename，Gateway 自动从 canonical 注册导出 node.rename。四个历史 RPC 命名例外被修正；stable outer tools 仍为六个。
- rule reviewTaskIds 从 RPC / Console 一直传到 exact adoption；旧单个 reviewTaskId 继续支持，不能同时提供两种形式。
- Codex updater pin 仅在旧路径缺失、归属同一 owning-product bin、唯一候选、有效 OpenAI Authenticode 签名、CLI 身份和前后 SHA-256 一致时自动修复。RuntimeSpec 两次内容 CAS 后原子替换 executable 字段，并留下实测 repair receipt。账户和 exact locator 保留。
- Gateway serve 写入 gateway-ingress.json：30 秒有限协议重探，90 秒新鲜度；public health 的 instanceId 必须与本地 listener 相同。配置 digest 改变时拒绝旧缓存。停止、失效和缺测均不能保持假 healthy。
- Host probe 重新检查同一个 registered / admitted context，CAS 复核 Session tuple。恢复只清除粘滞 health；uncertain Run 继续待核对，不替换 locator，不自动创建新 Session。
- 执行前恢复点位于 .sidera-dev/codex-review/checkpoint-before；含修改前 source manifest、coherent SQLite backup、runtime 配置与私有 Sovereignty。含凭据的恢复文件留在私有目录。
- live migration / restart / validation 的最终证据和限制见 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md。

- OAuth 增量迁移保留旧 receipts，新增精确 Node binding、SHA-256 refresh digest、token family、rotation / revoke 状态；不回填无法证明的旧 Node binding。旧 access token / refresh 缺失需要一次真实 connector reauthorization。
- 当前 chatgpt edge 原为没有 owner authentication 的 public PKCE。R1 以 confidential client + S256 PKCE 提供确定的 machine client authentication；本轮仅为相同 clientId / Node / redirectUris 配置私有 clientSecret，生成私有导入资料。Human-owned Chat binding、Core tokens、Authority 全部不变。secret 不写入报告或公开 evidence。
- > 2026-10-08 OAuth connector repair correction: 当前 chatgpt edge 保留同一 clientId / Node / redirectUris，并以显式 `publicPkceOwnerApproval` 运行 public S256 PKCE（token auth method `none`）：公网 `/authorize` 不再自动签发 code，必须由 Human 在仅监听 127.0.0.1 的本机确认页核对客户端 / Node / 回调 / 核对码并点击批准，才会完成一次性 code 签发。confidential clientSecret 路径继续支持，但不再用于该 connector。Human-owned Chat binding、Core tokens、Authority 与有效 auth state 不变；本机确认只认证 connector，不授予 Sidera Authority。详见 SIDERA_R1_EXISTING_CONNECTOR_OAUTH_REPAIR_RESULT.md。
> 2026-10-08 Codex final correction: rule_proposals / rule_versions 仅 additive 增加 governance_version_id。旧对象 null 值不进入原 digest，不改写原版本、review、Human act 或 History。新的 World successor proposal 固定 current governance version；未固定版本的历史 pending World 提案在已有 current World 时 fail closed，须重新提出精确对象。当前 live 两表均为 0，未代 Human 创建提案或采纳。恢复 checkpoint、配置变更和验收证据见 SIDERA_R1_CODEX_REVIEW_REVISION_RESULT.md。

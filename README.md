# Sidera

## Current R1 constitutional runtime

The current source implements [the R1 Constitution](SIDERA_R1_CONSTITUTION.md). See the [migration map](SIDERA_R1_MIGRATION_MAP.md) and [implementation evidence](SIDERA_R1_IMPLEMENTATION_RESULT.md). Console is the Human interface to Boundaries. Nodes are Communicators or Operators; Conversations and Executors are their subunits. A Project selects a Chief Conversation. Shared History is append-only; Ω is its deterministic projection. Private Description and Explanation live in each Node's local sovereignty region.

The installer instructions below describe earlier, unmodified candidates. This source refactor does not package or release a new installer.

## Windows 桌面快速开始（Phase 2）

1. 打开 `candidates/desktop-phase2/Sidera-0.1.0-phase2-x64-setup.exe`，完成当前用户安装。开始菜单快捷方式自动创建；桌面快捷方式可选。安装器未签名，Windows 可能显示信誉提示；没有经过验证的发布者身份。
2. 从开始菜单启动 **Sidera**。不需要单独安装 Node，不需要打开 PowerShell。便携版解压同目录的 `Sidera-0.1.0-phase2-Windows-x64-portable.zip`，保留所有资源并双击 `Sidera.exe`。
3. 在 **Setup** 声明 Human/Node，审阅并确认精确权限声明。到 **Integrations / Services** 配置 Host/MCP；安装与登录在所属产品完成，再点击 **重新检查 / Re-check**。已配置不等于已认证、Presence 或模型身份。
4. 使用 **Work / New Work** 提交一次意图，在界面监控；结果未知时先核对原始记录。没有真实回程证据时 `FULL_ROUTE_READY` 保持 false。
5. **System admin** 可查看版本、最近生命周期日志、导出脱敏诊断和打开固定数据目录。**Updates** 显示“未配置更新源”；候选不配置或发布公共更新源。
6. 退出通过安全停止门：活动 Host turn 或结果不确定时保留运行。先安全退出再手动升级；运行中的 Sidera 会阻止安装器替换或卸载。卸载保留用户数据，不自动删除历史。

详细验收与限制见 [Phase 2 报告](R1_DESKTOP_PRODUCT_PHASE2_REPORT.md)、[桌面架构](DESKTOP_ARCHITECTURE_R1.md) 和 [干净机器验证](desktop/FRESH_MACHINE_VALIDATION.md)。下方 CLI、Node 和 PowerShell 内容仅用于开发、恢复及旧候选，不属于普通桌面使用流程。

For the Windows desktop R1 candidate, unpack **candidates/Sidera-Desktop-R1-Windows-x64.zip**, keep all resources together, and double-click **Sidera.exe**. Setup, Integrations, System diagnostics and safe Core lifecycle are inside the app; Node and Chromium are bundled. See [desktop architecture](DESKTOP_ARCHITECTURE_R1.md) and [desktop report](R1_DESKTOP_PRODUCT_REPORT.md). Earlier Phase 1 verdict: **DESKTOP_RELEASE_READY_WITH_EXPLICIT_LIMITS**; Phase 2 supersedes this quick start. The unsigned candidate has not been published. Browser Workbench and CLI instructions below remain fallback/developer/recovery paths. Setup does not log into a Host, create a Chat, establish a return route or grant Authority automatically.

The correction is a pre-release candidate with explicit remaining product gaps. See [FUNCTION_INTERFACE_MAP.md](FUNCTION_INTERFACE_MAP.md), [PRODUCT_FLOW_R1.md](PRODUCT_FLOW_R1.md), [ARCHITECTURE_DIET_R1.md](ARCHITECTURE_DIET_R1.md) and [R1_PRODUCT_CORRECTION_REPORT.md](R1_PRODUCT_CORRECTION_REPORT.md) before public packaging. A reachable local page is not a working external Human return route.

Sidera is a local system for coordinating AI resources and work. Communicator and Operator Nodes own stable identity; Conversations and Executors provide their communication and execution contexts:

```text
Human → existing Chat / Chief Conversation
                    ↕
       Responsibility · Task · Run · Supervision
       Authority · Effect · Message · Presence · Route
                    ↕
        multiple independent execution Nodes
```

One adapter per Host enables authorized Node-to-Node cooperation. Model names and Host protocols remain inside adapters. Changing a model or Session does not change Node identity. The supplied **R1.1 Design Pack** defines the product boundary; historical acceptance records below prove only their stated runs.

**Production is browser-free.** Native and authenticated protocol routes may deliver to an exact existing Human Chat. Browser automation, browser visibility, CAPTCHA handling and UI fallback do not establish Presence or provide runtime recovery. A missing authenticated return route produces a truthful blocked state.

## Start and inspect

The supported development environment is **Windows 11 x64, Node.js 24 or newer**, with a single Core process, SQLite, loopback RPC and independent Host adapters.

For an already provisioned local workspace:

```powershell
npm ci
npm run check
npm test
node scripts/sidera.ts config-check
npm run dev
```

In another terminal:

```powershell
node scripts/sidera.ts status
node scripts/sidera.ts nodes
node scripts/sidera.ts inspect task <task-id>
node scripts/sidera.ts inspect responsibility <responsibility-id>
node scripts/sidera.ts inspect supervision <supervision-id>
```

`status`, `nodes` and `inspect` read canonical runtime records. They do not dispatch, retry a Run, prepare a return route or wake a Node. Inspection exposes execution, dependencies, rounds, decision references, Effect knowledge and final results within the caller's authorized World and work scope. It does not return private Description/Explanation, Memory, Host credentials or arbitrary logs.

The default caller is the Communicator owning the configured Chief Conversation; `--node <nodeId>` selects an existing local Node identity. `SIDERA_PROJECT_ROOT` can select the project directory. This is a local operator interface using the configured Node's Authority, not a way for a Node to acquire Human authority.

The private runtime configuration is `.sidera-dev/sol/data/runtime-spec.json`; the database is `.sidera-dev/sol/data/sidera.sqlite`. Configuration includes private RPC tokens: do not commit, paste or print the whole file. The CLI prints a filtered view. Default listener ports are Core `127.0.0.1:8765` and MCP `127.0.0.1:8787/mcp`; configured values take precedence.

A clean checkout alone does not supply accounts, exact Host Sessions, Human admission or a bound Chief Conversation. Provision those through the existing Human/Host onboarding paths before starting real work. Login belongs to the Host; Sidera does not open a browser to repair runtime authentication.

To stop a Core launched by the current launcher:

```powershell
node scripts/core-lifecycle.ts stop
```

The operator channel asks the current owner to stop normally; open Host turns may block shutdown. It does not kill the user's desktop Host. Start again with the same private environment. Startup reports an immutable build identity; Git HEAD alone is not proof that a running process loaded new code.

`/readyz` reports whether the MCP service can serve requests after startup. It includes the aggregate activation observation separately; its stale cache or an unrelated offline Node does not make `tools/list` unavailable. Every actual dispatch still requires fresh participant admission, exact Human return-route evidence where applicable, Authority and the final Effect gate. A healthy MCP endpoint is not proof that a particular Task can execute.

## Start cooperative work

Normal interaction begins in the existing authenticated primary Chat: give the Chief the intended outcome. The Chief/Supervisor selects authorized Nodes and decides whether to continue, rework, reconcile, wait, accept or escalate. Results remain tied to the original project and Chief; an explicit Human Chat handoff selects the current admitted binding and requires fresh exact Presence. Pinned Agent messages are not retargeted. Human does not copy prompts or results between Nodes.

For the local Human operator entry, write your actual goal into a UTF-8 text file and submit it directly:

```powershell
node scripts/sidera.ts request --file .\goal.txt --human <existing-human-id> --world <existing-world-id>
```

This privileged local Human frontend preserves the actual file text and its provenance as a literal Intent. It admits only that Intent revision, creates no Grant, and sends it through canonical cooperation. Core creates the caller-owned Responsibility when needed; no manual basis JSON, worker/model selection or message copying is required. `intent` with the same file/Human/World arguments records only the literal goal without dispatching.

The operator must supply actual Human-authored input. These privileged local entry points must not be exposed as Node tools or used to promote model output into Human authority. Ordinary Node interpretations remain claims; wording such as “grant everything” inside a goal does not create a Grant.

For integrations that already have admitted semantic state, `cooperate` also accepts a goal file and basis JSON:

```json
{
  "intentRevisionId": "existing-human-admitted-intent-revision-id",
  "contextBasis": ["existing-provenance-reference"]
}
```

Then submit once:

```powershell
node scripts/sidera.ts cooperate --goal-file .\goal.txt --basis-file .\basis.json
```

An existing `responsibilityId` may be supplied in the basis; otherwise Core creates the caller-owned Responsibility idempotently. `cooperate` does not admit new Human Intent.

Both commands use the canonical `cooperation.start` RPC. The CLI saves and flushes a unique request receipt in `.sidera-dev/operator-requests/` **before** submission. It makes one call and saves a separate response receipt. It does not create a substitute Grant, choose a vendor model or automatically resend after an uncertain response.

The receipt and response provide the original request and work IDs for `inspect`. A response acknowledging submission is not proof that the Agent finished or that the Human saw its result. Do not rerun `request` or `cooperate` as a recovery mechanism for an uncertain receipt: inspect and reconcile the original operation.

### Multi-round behavior

- Real result and dependency events wake the appropriate Node; logical progress is not driven by a polling timer.
- A Supervisor supplies the next instruction and may select another authorized executor. Core records and routes that decision; it does not manufacture the judgment.
- A waiting round resumes from its relevant event; uncertain external effects require reconciliation of the original attempt.
- Acceptance and escalation can request Human presentation through the exact prepared non-browser route. Routine work and intermediate tool output stay internal and remain inspectable.
- Session/Host acceptance, Agent completion, result delivery and Human observation are separate evidence.

## Configuration and adapters

```powershell
node scripts/sidera.ts config-check
```

This checks configuration structure, duplicate identities and registered adapter IDs. It creates no Host process, contacts no provider, and proves neither authentication nor Presence.

### Execution Nodes

The existing Host factory registry is [hythes/host-factories.ts](hythes/host-factories.ts). Current adapters include:

| Adapter | Host interface |
|---|---|
| `codex-app-server` | Independent Codex app-server Session |
| `dsh-harness-acp` | DeepSeek Harness ACP |
| `grok-build-acp` | Grok Build ACP |
| `antigravity-cli-headless` | Antigravity headless CLI |
| `zcode-native-service` | ZCode native service |
| `openai-compatible-api` | Compatible streaming Chat Completions Host |
| `deepseek-api` | Compatibility provider configuration |

A Node configuration declares its stable Node ID, exact Session and locator, independent Hythe ID, Host kind, model binding and adapter options. Credentials are local Host references or private local connection tokens. Public cooperation code does not branch on a model name or on a pair of Nodes.

To add a Host, implement its Hythe and capability/control-profile manifest, register one factory, then add the Human-owned Node/Host configuration and required admission. Tool discovery does not itself grant Authority. A changed model uses model migration; a changed Session uses an explicit handoff. Editing configuration must not silently replace the historical binding of outstanding work.

Removing a Node from active use must preserve its identity, history and unresolved work. Close/retire its active resources through authorized lifecycle operations, resolve outstanding attempts, then remove its active configuration. Deleting an entry is not a cancellation or proof that external effects stopped.

### Human Chat routes

[FrontendAdapterRegistry](hythes/frontend-registry.ts) supports declarative multiple frontend routes. Every protocol route requires a `bindings` allowlist of exact `projectSpaceId` + `conversationRef` tuples, optionally pinned to a `bindingId`. Matching only `frontendKind` is insufficient. Preparing one Chat does not replace another Chat's control profile, including two endpoints for the same Chat product.

```json
{
  "frontend": {
    "routes": [
      {
        "id": "chatgpt-native",
        "adapter": "codex-app-tools",
        "frontendKind": "chatgpt-web",
        "options": { "nativeServerPath": "C:/installed/codex-app-tools/server.mjs" }
      },
      {
        "id": "another-chat",
        "adapter": "mcp-http",
        "frontendKind": "other-chat",
        "bindings": [{ "projectSpaceId": "my-project", "conversationRef": "other-chat://conversation/existing-id" }],
        "options": {
          "endpoint": "https://your-supported-host.example/mcp",
          "authTokenEnv": "SIDERA_OTHER_CHAT_TOKEN",
          "operations": {
            "conversation.locate": "actual_locate_tool",
            "conversation.send": "actual_send_tool",
            "conversation.observe": "actual_observe_tool"
          }
        }
      }
    ]
  }
}
```

The protocol example is a configuration shape, not a deployed service. Its real MCP bridge must authenticate the caller, expose the declared tools and return canonical observations with the exact `data.conversationRef`; send acceptance also needs a real `hostRef`. Tools receive immutable `projectSpaceId`, `conversationRef` and `bindingId` arguments. A scope mismatch is rejected before connecting or sending any payload. The endpoint, credential reference and binding scope form part of the route's control profile identity; changing them invalidates prior prepared evidence. Credentials remain Host-owned. The adapter accepts HTTPS or authenticated loopback HTTP, never redirects to an interactive login, and never automatically reconnects/replays a send. Observation of presentation requires the exact correlated message in the actual conversation; generic “success” or preview text is insufficient.

The ChatGPT native adapter requires executor-provided Codex app context. Its presence on disk does not make an arbitrary PowerShell process authenticated. Historical `chatgpt-ui` configuration is read only for native bridge compatibility and never enables a production browser route.

Chief Conversation binding/handoff is an explicit Human action. It selects an existing Chat, invalidates the old prepared route and requires fresh exact Presence for the new binding. Sidera does not create “Feedback”, “Report” or other Human-visible Chats automatically.

## Development permission profiles

Three coarse planning modes reuse the existing Authority and Permission Package machinery:

```powershell
node scripts/sidera.ts profile read-only .\profile.json
node scripts/sidera.ts profile workspace .\profile.json
node scripts/sidera.ts profile full-access .\profile.json
```

To apply the reviewed mode once, run this in your interactive terminal:

```powershell
node scripts/sidera.ts profile-apply workspace .\profile.json --human <existing-human-id>
```

The console shows the concrete manifest, digest and exact approval statement before creating any Grant. Type the requested `APPROVE <digest>` text. Full Access is separately labeled and requires `APPROVE FULL ACCESS <digest>`. Piped input and `--yes` cannot approve a first application. A matching already admitted package is reused without another prompt or duplicate Grants. Changed scopes require a new package revision; revoked, expired or obsolete approval is not silently restored.

Example input shape:

```json
{
  "worldId": "existing-world-id",
  "packageId": "development-workspace",
  "subjects": [{
    "nodeId": "existing-node-id",
    "collaboratorNodeIds": ["another-existing-node-id"],
    "productionWorkspaceAccess": "write",
    "workspaces": [{
      "resourceScope": "project/sidera/workspace/**",
      "access": "write",
      "kind": "production"
    }]
  }]
}
```

`profile` only prints a manifest, digest and admission requirements. It opens no database and issues no Grant. `profile-apply` uses the existing Human package admission, application and atomic materialization path. Full Access requires an explicit package confirmation and individually described additional scopes. Workspace mode does not silently include payments, subscriptions, account administration or arbitrary Host tools. Applying a profile adds its reviewed scopes; selecting Read Only does not revoke broader old Grants. These profiles do not implement an OS sandbox.

A fixture-only Node can use `productionWorkspaceAccess: "none"` and explicitly declared fixture resources. This preserves GLM/ZCode in the capability topology without granting access to the real Sidera production repository. Description and Explanation remain each Node's sovereign state; World history/evidence/artifacts are not automatically copied into Memory.

## Current limits and historical evidence

Use `status` and `inspect` for current facts. Prior PASS records do not prove that an account, adapter or route is online today.

- [MULTINODE-ACCEPTANCE.md](MULTINODE-ACCEPTANCE.md): historical real Sol → Astra → DS → Astra → Sol, including reverse delegation and continuation.
- [R1_GROK_ACCEPTANCE.md](R1_GROK_ACCEPTANCE.md): Grok Build Host acceptance and limits.
- [BILATERAL.md](BILATERAL.md): historical bilateral/ordinary-agent runs, exact IDs and uncertain attempts retained without replay. Some old runs used the subsequently rejected browser path; those do not satisfy the present browser-free production requirement.
- DSH, Gemini and ZCode have implemented adapters, but current Host availability, plan/region restrictions and supported interface versions are independent runtime facts. An offline optional Host is not a reason to pretend it succeeded.
- The new generic MCP Chat adapter has local authenticated protocol tests. Another vendor Chat requires a real supported bridge and account binding before claiming external delivery.
- A local test, an available Node, a prepared route or a tool manifest is not a real end-to-end result. Real supervised acceptance must prove the actual rounds and return to the same Human Chat, with no browser launches and no Human relay.
- Control-plane p95 < 200 ms excludes model and external Host waiting; it remains a real-path release measurement, not a claim inferred from unit tests.

For the installed ZCode native service, the existing helper remains:

```powershell
pwsh -NoProfile -File scripts/start-zcode-host.ps1
```

It uses the installed official Agent and pinned native service/client interface. `-Build` is an explicit setup operation; ordinary restart does not download or log in. The desktop bundle's old `zcode.cjs` interactive TUI path lacked `@zcode/tui`; `/login` is not a PowerShell command. See the helper and [BILATERAL.md](BILATERAL.md) for its current pin and local paths.

## Independent runtime

Sidera has no AI Studio / Studio+ runtime dependency. It does not launch their binaries, tunnels or relay bridges, import their credentials, or use their state for readiness or Authority. Sidera's Shared History is its own World archive.

Qwen is optional archive indexing/retrieval/accessibility infrastructure. It does not determine authorization, routing truth, project direction or Node subjectivity. Advanced Bot research, public ingress and a final frontend matrix remain separate from making ordinary cooperation dependable.
# Windows desktop candidate

The normal Human entry is now the portable desktop application: unpack `candidates/Sidera-Desktop-R1-Windows-x64.zip`, keep its resources together, and double-click `Sidera.exe`. Setup, Integrations, System diagnostics and safe Core lifecycle are inside the app. Browser Workbench and CLI instructions below remain fallback/developer/recovery paths.

See [desktop architecture](DESKTOP_ARCHITECTURE_R1.md) and [desktop product report](R1_DESKTOP_PRODUCT_REPORT.md) for validation and explicit limits. Verdict: `DESKTOP_RELEASE_READY_WITH_EXPLICIT_LIMITS`. The candidate is unsigned and has not been published.

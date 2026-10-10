# Sidera R1 — 原有 ChatGPT Connector OAuth 兼容修复

日期：2026-10-08

## 问题与根因

已有 Sidera ChatGPT 插件的客户端 ID / OAuth 回调仍存在；公网和本地 Gateway 健康。
Codex 上一轮将同一客户端升级为 `client_secret_post`，而原插件此前使用无需 `client_secret` 的 PKCE 流。已观察到 /authorize 签发 code、/token 返回 `invalid_client: Client secret is required`，导致 ChatGPT “We couldn't connect your account”。

## 本轮处理

- 不删除、重建、替换 Sidera 插件；保留原 clientId、redirectUris、NodeRef、Core credential、Chief Conversation。
- `hythes/mcp-oauth.ts` 加入显式 `publicPkceOwnerApproval` 模式。只有已注册且精确匹配 clientId、redirect_uri、S256 PKCE 的请求，才可进入待 Human 认证状态。
- 额外建立仅监听 `127.0.0.1:8791` 的本地 Human 确认服务（`hythes/oauth-local-consent.ts`）。DevTunnel 仅转发 8788，不暴露 8791。
- 公网 /authorize 不直接发 code；浏览器需主动打开本机确认页，核对客户端、Node、回调和核对码，再点击批准。独立本地 CSRF 随机令牌、同源 Origin 校验、期限校验、审批一次性使用。
- 批准后，原公网授权页自动继续，生成一次性 authorization code；SDK 仍检查 PKCE、redirect、client 和 scope；之后可获得原 Node 绑定的 access+rotating refresh tokens。
- 保留机密客户端流：只有明确启用该选项的客户端才以 public/none 方式运行。没有 Human owner confirmation 的公开客户端仍拒绝。
- 原 `gateway.json` 私有备份位于 `.sidera-dev/sol/data/gateway.before-public-owner-approval.20261008T012843Z.private.json`；仅增加选项与本地批准端口，未改变既有身份。
- Gateway 已重启为 PID 44604；Core 没有重启。

## 实测与回归

- `npm run check` PASS
- `npm test` 350/350 PASS（含公开客户端 Human consent 新验收）
- `npm run desktop:test` 16/16 PASS
- `npm --prefix ui run build` PASS
- `npm --prefix ui run test:smoke` PASS
- 实际 Gateway 本机 /healthz HTTP 200；DevTunnel 公网 /healthz HTTP 200
- 实际 Gateway localhost /authorize HTTP 200，**未自动产生跳转授权码**
- 本机审批链接 HTTP 200，审批前状态 PENDING，未经批准完成请求 HTTP 409，非法 owner 申请 HTTP 404
- OAuth metadata 对已有 ChatGPT client 公布 `none` token authentication method
- `127.0.0.1:8791` 监听，未对其他网络接口开放
- 回归日志：`.sidera-dev/sol/data/oauth-owner-approval-final-validation.log`

## 仍需 Human-only 的一步

在原 ChatGPT Sidera 插件设置点击“重新连接”，出现 Sidera 授权页后点击“打开本机确认页面”，核对并批准。
此步骤必须由 Human 执行，不能由本地测试代签。只有插件侧真正回连和真实 `tools/list`、`session.active` 成功后，才能声明 **ChatGPT 真实连接 E2E 完成**。

本修复只修 OAuth 连接兼容性，不自动改变 Sidera World/Project Rules、Grant、Node、D/E、Chief Presence 或 Return Route。


## 2026-10-08 Chrome 本机确认 403 修正

**发现的真实根因**：本机确认页返回了 `Referrer-Policy: no-referrer`，这会使普通 HTML POST form 的 `Origin` 在 Chrome 等标准浏览器中变为 `null`。服务端仍严格要求本机的精确 Origin，因此正常 Human 点击也被拦截成 `403 来源被拒绝`。

**修订**：仅将本机 `oauth-local-consent.ts` 的响应头改为 `Referrer-Policy: same-origin`。浏览器从本机确认页向同源 `/approve` 提交时，可携带真实的同源 Origin；同时不会将本机页面的 Referer 泄漏给其他站点。所有原安全边界保持原样：仅绑定 127.0.0.1、本机 Host 核对、精确 Origin 检查、Fetch Metadata 限制、一次性随机 CSRF、申请过期和 Node/Client/Redirect 绑定。先前未完成的“允许 null Origin”思路没有采用。

**验证**：`npm run check` exit 0；定向 `tests/mcp-oauth.test.ts` **18/18 PASS**，新增 O-T18 检查页面响应头为 same-origin，并确认 `Origin:null` / 缺失 Origin / 外域 Origin / cross-site 均被拒绝，真正本机同源提交仍能完成模拟审批。Gateway 仅重启指定进程，最终 PID 48220；运行态的本机 8791 HTTP 响应头实测 `Referrer-Policy: same-origin`；公网 `/healthz` HTTP 200。没有更改 Core、Node、D/E、Chief 绑定或 OAuth clientId。

**未完成**：还没有 Human 亲自在 ChatGPT 原插件发起本轮新授权并在本机点确认，因此不得宣布真实产品侧 OAuth E2E 已完成。

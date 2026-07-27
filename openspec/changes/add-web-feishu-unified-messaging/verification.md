# 实施验证记录

## 变更前基线

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 依赖 | `pnpm install --frozen-lockfile` | 通过 |
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Host 测试 | `pnpm test` | 通过，76 个测试文件、864 个测试 |
| Runner 依赖 | `bun install --frozen-lockfile` | 通过 |
| Runner 类型检查 | `bun run typecheck` | 通过 |
| Runner 测试 | `bun test` | 通过，320 个测试 |

受限沙箱内运行 Host 测试时，`scripts/q.test.ts` 的 7 个子进程用例因 `tsx` 无权创建本地 IPC
而失败；在允许本地 IPC 的执行环境中复跑后 864/864 全部通过。该环境差异发生在任何实现
修改之前，不属于本变更的代码回归。

## 规范用户与外部身份数据层

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| 身份层类型检查 | `pnpm typecheck` | 通过 |
| 身份迁移、DB 模块、Sender Resolver、飞书可信身份、Organization/Gateway 守卫 | `pnpm exec vitest run src/db/migrations/036-user-identities.test.ts src/db/user-identities.test.ts src/modules/permissions/user-identity-resolver.test.ts src/channels/feishu-webhook.test.ts src/modules/permissions/operability-gateway-isolation.test.ts` | 通过，5 个测试文件、35 个测试 |
| Host 全量回归 | `pnpm test` | 通过，79 个测试文件、874 个测试 |

本阶段还验证了新 Channel Inbound 会由 Host 把解析后的规范用户写入
`messages_in.origin_user_id`。旧 Session 行仍可回退到正文中的 `senderId`，但新身份映射不会
在 A2A 多跳中退化回未经映射的外部 ID。

## Web 配置、认证数据层与飞书 SSO 核心

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Web 配置、Hash Session、一次性 OAuth 事务、飞书 SSO 与身份冲突 | `pnpm exec vitest run src/web/feishu-sso.test.ts src/db/web-auth.test.ts src/config-validate.test.ts` | 通过，3 个测试文件、47 个测试 |

SSO 测试覆盖合法登录、浏览器绑定的 State、S256 PKCE、Code 重放拒绝和已登录用户身份冲突
Fail Closed。持久化快照断言数据库与 Enterprise Audit 中均没有飞书 App Secret、Authorization
Code、Access Token、原始 Web Session Token 或原始 CSRF Token。

## Web 登录 HTTP 安全边界

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Web Listener、Cookie、`/api/me`、Logout、CSRF、Origin、Body Limit、Rate Limit | `pnpm exec vitest run src/web/server.test.ts src/web/feishu-sso.test.ts src/db/web-auth.test.ts src/config-validate.test.ts` | 通过，4 个测试文件、50 个测试 |
| 新增文件格式 | `pnpm exec prettier --check src/web/server.ts src/web/server.test.ts src/index.ts` | 通过 |
| 新增 Web Listener Lint | `pnpm exec eslint src/web/server.ts src/web/server.test.ts` | 通过 |
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Host 全量回归 | `pnpm test` | 通过，82 个测试文件、894 个测试 |

HTTP 集成测试通过本机回环随机端口驱动真实重定向和 Cookie。受限沙箱禁止监听回环端口，
因此该组测试与全量回归在允许本地 IPC/回环端口的执行环境中运行。Web Listener 使用独立
端口，不与 Webhook 或 Metrics Listener 共用路由；未配置 `WEB_ENABLED=true` 时保持关闭。

## Conversation Lane 与跨渠道 Session

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Lane Migration、DB 模块、Session Resolver、Router 跨端复用、A2A 身份连续性 | `pnpm exec vitest run src/modules/agent-to-agent/agent-route.test.ts src/router.conversation-lane.test.ts src/session-manager.conversation-lane.test.ts src/db/conversation-lanes.test.ts src/db/migrations/038-conversation-lanes.test.ts` | 通过，5 个测试文件、41 个测试 |
| Host 全量回归 | `pnpm test` | 通过，86 个测试文件、904 个测试 |

测试证明 Alice/Bob 即使在同一个飞书群也分别进入自己的 Lane 与根 Session；Alice 的 Web
Turn 使用服务端授权的 Lane 后复用飞书根 Session。每条入站行仍保存自己的 Channel、
Platform、Thread、外部消息 ID 和 Host 写入的规范 `origin_user_id`。

旧飞书 Session 的关联要求精确 Session ID 和属于同一规范用户的已验证飞书身份，不扫描或
合并历史。`shared`、`per-thread`、`agent-shared`、Owner 不一致和 Agent Group 不一致均
Fail Closed。额外的两跳 A2A 回归证明 Agent 可见正文中的伪造 `senderId` 不能替换 Host
交叉验证后的规范用户。

## Web Channel、Conversation API 与幂等消息接入

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Web Adapter Contract、会话服务、历史分页、Migration | `pnpm exec vitest run src/channels/web.test.ts src/channels/channel-contract.test.ts src/web/conversations.test.ts src/db/migrations/039-web-message-receipts.test.ts` | 通过，4 个测试文件、15 个测试 |
| 真实 HTTP API、Cookie/CSRF/Origin 和消息去重 | `pnpm exec vitest run src/web/server.test.ts src/web/conversations.test.ts src/db/migrations/039-web-message-receipts.test.ts` | 通过，3 个测试文件、8 个测试 |
| Host 全量回归 | `pnpm test` | 通过，89 个测试文件、910 个测试 |

HTTP 测试证明服务器忽略浏览器伪造的 User、Agent Group、Session 和 Lane 字段，只使用 Hash 化
Web Session、重新授权后的 Lane 与数据库 Binding。相同 `clientMessageId` 重试只调用一次 Web
Adapter，并返回同一个服务端消息 ID。

History 从根 Session 的 `inbound.db` / `outbound.db` 合并，使用确定性不透明 Cursor；测试额外
注入了 Bob 的底层入站行，Alice 的 Web History 不会返回该内容。撤销 Alice 的 Agent Group
Membership 后，下一次 List 与 History 请求立即隐藏/拒绝该 Lane。

## Web SSE 持久化事件与断线重放

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Event Migration/DB、Web Adapter 出站引用、SSE 重放/授权/连接上限/Backpressure/Session 撤销 | `pnpm exec vitest run src/web/events.test.ts src/db/web-events.test.ts src/db/migrations/040-web-events.test.ts src/channels/web.test.ts src/web/conversations.test.ts` | 通过，5 个测试文件、13 个测试 |
| 真实 HTTP SSE、Cookie、精确 Origin、非法 Cursor 与 `Last-Event-ID` | `pnpm exec vitest run src/web/server.test.ts src/web/events.test.ts src/db/web-events.test.ts src/db/migrations/040-web-events.test.ts src/channels/web.test.ts src/web/conversations.test.ts` | 通过，6 个测试文件、18 个测试 |
| Host 全量回归 | `pnpm test` | 通过，92 个测试文件、920 个测试 |

测试证明 SSE Event 只引用已经持久化的服务端消息，不复制正文、Token 或 Organization。重放只
查询当前规范用户的事件，每条事件还会重新执行 Lane Owner 与当前 Agent Group/Organization
访问门；测试中的无权 Lane、Bob Lane 和撤权后 Event 均不会发给 Alice。

同一资源的重复 Delivery 只生成一个 Event。连接达到每用户上限时返回拒绝，慢客户端触发
`ServerResponse` Backpressure 后立即关闭，Web Session 被撤销后在心跳检查中收到
`session-revoked` 并断开。真实回环 HTTP 测试验证 `/api/events` 同时要求有效 Cookie 和精确
Origin，且会从标准 `Last-Event-ID` 之后继续发送。

# 实施验证记录

## 变更前基线

验证日期：2026-07-27

| 范围            | 命令                             | 结果                            |
| --------------- | -------------------------------- | ------------------------------- |
| Host 依赖       | `pnpm install --frozen-lockfile` | 通过                            |
| Host 类型检查   | `pnpm typecheck`                 | 通过                            |
| Host 测试       | `pnpm test`                      | 通过，76 个测试文件、864 个测试 |
| Runner 依赖     | `bun install --frozen-lockfile`  | 通过                            |
| Runner 类型检查 | `bun run typecheck`              | 通过                            |
| Runner 测试     | `bun test`                       | 通过，320 个测试                |

受限沙箱内运行 Host 测试时，`scripts/q.test.ts` 的 7 个子进程用例因 `tsx` 无权创建本地 IPC
而失败；在允许本地 IPC 的执行环境中复跑后 864/864 全部通过。该环境差异发生在任何实现
修改之前，不属于本变更的代码回归。

## 规范用户与外部身份数据层

验证日期：2026-07-27

| 范围                                                                        | 命令                                                                                                                                                                                                                                                         | 结果                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 身份层类型检查                                                              | `pnpm typecheck`                                                                                                                                                                                                                                             | 通过                            |
| 身份迁移、DB 模块、Sender Resolver、飞书可信身份、Organization/Gateway 守卫 | `pnpm exec vitest run src/db/migrations/036-user-identities.test.ts src/db/user-identities.test.ts src/modules/permissions/user-identity-resolver.test.ts src/channels/feishu-webhook.test.ts src/modules/permissions/operability-gateway-isolation.test.ts` | 通过，5 个测试文件、35 个测试   |
| Host 全量回归                                                               | `pnpm test`                                                                                                                                                                                                                                                  | 通过，79 个测试文件、874 个测试 |

本阶段还验证了新 Channel Inbound 会由 Host 把解析后的规范用户写入
`messages_in.origin_user_id`。旧 Session 行仍可回退到正文中的 `senderId`，但新身份映射不会
在 A2A 多跳中退化回未经映射的外部 ID。

## Web 配置、认证数据层与飞书 SSO 核心

验证日期：2026-07-27

| 范围                                                           | 命令                                                                                                  | 结果                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| Host 类型检查                                                  | `pnpm typecheck`                                                                                      | 通过                          |
| Web 配置、Hash Session、一次性 OAuth 事务、飞书 SSO 与身份冲突 | `pnpm exec vitest run src/web/feishu-sso.test.ts src/db/web-auth.test.ts src/config-validate.test.ts` | 通过，3 个测试文件、47 个测试 |

SSO 测试覆盖合法登录、浏览器绑定的 State、S256 PKCE、Code 重放拒绝和已登录用户身份冲突
Fail Closed。持久化快照断言数据库与 Enterprise Audit 中均没有飞书 App Secret、Authorization
Code、Access Token、原始 Web Session Token 或原始 CSRF Token。

## Web 登录 HTTP 安全边界

验证日期：2026-07-27

| 范围                                                                          | 命令                                                                                                                         | 结果                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Web Listener、Cookie、`/api/me`、Logout、CSRF、Origin、Body Limit、Rate Limit | `pnpm exec vitest run src/web/server.test.ts src/web/feishu-sso.test.ts src/db/web-auth.test.ts src/config-validate.test.ts` | 通过，4 个测试文件、50 个测试   |
| 新增文件格式                                                                  | `pnpm exec prettier --check src/web/server.ts src/web/server.test.ts src/index.ts`                                           | 通过                            |
| 新增 Web Listener Lint                                                        | `pnpm exec eslint src/web/server.ts src/web/server.test.ts`                                                                  | 通过                            |
| Host 类型检查                                                                 | `pnpm typecheck`                                                                                                             | 通过                            |
| Host 全量回归                                                                 | `pnpm test`                                                                                                                  | 通过，82 个测试文件、894 个测试 |

HTTP 集成测试通过本机回环随机端口驱动真实重定向和 Cookie。受限沙箱禁止监听回环端口，
因此该组测试与全量回归在允许本地 IPC/回环端口的执行环境中运行。Web Listener 使用独立
端口，不与 Webhook 或 Metrics Listener 共用路由；未配置 `WEB_ENABLED=true` 时保持关闭。

## Conversation Lane 与跨渠道 Session

验证日期：2026-07-27

| 范围                                                                       | 命令                                                                                                                                                                                                                                        | 结果                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Host 类型检查                                                              | `pnpm typecheck`                                                                                                                                                                                                                            | 通过                            |
| Lane Migration、DB 模块、Session Resolver、Router 跨端复用、A2A 身份连续性 | `pnpm exec vitest run src/modules/agent-to-agent/agent-route.test.ts src/router.conversation-lane.test.ts src/session-manager.conversation-lane.test.ts src/db/conversation-lanes.test.ts src/db/migrations/038-conversation-lanes.test.ts` | 通过，5 个测试文件、41 个测试   |
| Host 全量回归                                                              | `pnpm test`                                                                                                                                                                                                                                 | 通过，86 个测试文件、904 个测试 |

测试证明 Alice/Bob 即使在同一个飞书群也分别进入自己的 Lane 与根 Session；Alice 的 Web
Turn 使用服务端授权的 Lane 后复用飞书根 Session。每条入站行仍保存自己的 Channel、
Platform、Thread、外部消息 ID 和 Host 写入的规范 `origin_user_id`。

旧飞书 Session 的关联要求精确 Session ID 和属于同一规范用户的已验证飞书身份，不扫描或
合并历史。`shared`、`per-thread`、`agent-shared`、Owner 不一致和 Agent Group 不一致均
Fail Closed。额外的两跳 A2A 回归证明 Agent 可见正文中的伪造 `senderId` 不能替换 Host
交叉验证后的规范用户。

## Web Channel、Conversation API 与幂等消息接入

验证日期：2026-07-27

| 范围                                                | 命令                                                                                                                                                                   | 结果                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Host 类型检查                                       | `pnpm typecheck`                                                                                                                                                       | 通过                            |
| Web Adapter Contract、会话服务、历史分页、Migration | `pnpm exec vitest run src/channels/web.test.ts src/channels/channel-contract.test.ts src/web/conversations.test.ts src/db/migrations/039-web-message-receipts.test.ts` | 通过，4 个测试文件、15 个测试   |
| 真实 HTTP API、Cookie/CSRF/Origin 和消息去重        | `pnpm exec vitest run src/web/server.test.ts src/web/conversations.test.ts src/db/migrations/039-web-message-receipts.test.ts`                                         | 通过，3 个测试文件、8 个测试    |
| Host 全量回归                                       | `pnpm test`                                                                                                                                                            | 通过，89 个测试文件、910 个测试 |

HTTP 测试证明服务器忽略浏览器伪造的 User、Agent Group、Session 和 Lane 字段，只使用 Hash 化
Web Session、重新授权后的 Lane 与数据库 Binding。相同 `clientMessageId` 重试只调用一次 Web
Adapter，并返回同一个服务端消息 ID。

History 从根 Session 的 `inbound.db` / `outbound.db` 合并，使用确定性不透明 Cursor；测试额外
注入了 Bob 的底层入站行，Alice 的 Web History 不会返回该内容。撤销 Alice 的 Agent Group
Membership 后，下一次 List 与 History 请求立即隐藏/拒绝该 Lane。

## Web SSE 持久化事件与断线重放

验证日期：2026-07-27

| 范围                                                                                       | 命令                                                                                                                                                                                           | 结果                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Host 类型检查                                                                              | `pnpm typecheck`                                                                                                                                                                               | 通过                            |
| Event Migration/DB、Web Adapter 出站引用、SSE 重放/授权/连接上限/Backpressure/Session 撤销 | `pnpm exec vitest run src/web/events.test.ts src/db/web-events.test.ts src/db/migrations/040-web-events.test.ts src/channels/web.test.ts src/web/conversations.test.ts`                        | 通过，5 个测试文件、13 个测试   |
| 真实 HTTP SSE、Cookie、精确 Origin、非法 Cursor 与 `Last-Event-ID`                         | `pnpm exec vitest run src/web/server.test.ts src/web/events.test.ts src/db/web-events.test.ts src/db/migrations/040-web-events.test.ts src/channels/web.test.ts src/web/conversations.test.ts` | 通过，6 个测试文件、18 个测试   |
| Host 全量回归                                                                              | `pnpm test`                                                                                                                                                                                    | 通过，92 个测试文件、920 个测试 |

测试证明 SSE Event 只引用已经持久化的服务端消息，不复制正文、Token 或 Organization。重放只
查询当前规范用户的事件，每条事件还会重新执行 Lane Owner 与当前 Agent Group/Organization
访问门；测试中的无权 Lane、Bob Lane 和撤权后 Event 均不会发给 Alice。

同一资源的重复 Delivery 只生成一个 Event。连接达到每用户上限时返回拒绝，慢客户端触发
`ServerResponse` Backpressure 后立即关闭，Web Session 被撤销后在心跳检查中收到
`session-revoked` 并断开。真实回环 HTTP 测试验证 `/api/events` 同时要求有效 Cookie 和精确
Origin，且会从标准 `Last-Event-ID` 之后继续发送。

## Web 前端工程、品牌投影与登录骨架

验证日期：2026-07-27

| 范围                         | 命令                                                                                             | 结果                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Host 类型检查                | `pnpm typecheck`                                                                                 | 通过                                                          |
| 公开品牌配置与真实 HTTP 接口 | `pnpm vitest run src/branding.test.ts src/web/server.test.ts`                                    | 通过，2 个测试文件、9 个测试                                  |
| 前端类型检查                 | `pnpm web:typecheck`                                                                             | 通过                                                          |
| 登录页与品牌回退组件测试     | `pnpm web:test`                                                                                  | 通过，1 个测试文件、2 个测试                                  |
| 前端生产构建                 | `pnpm web:build`                                                                                 | 通过，生成 Hash CSS/JavaScript Asset；生产包不包含 Source Map |
| 新增文件格式                 | `pnpm exec prettier --check ...`                                                                 | 通过                                                          |
| Host 新增代码 Lint           | `pnpm exec eslint src/branding.ts src/branding.test.ts src/web/server.ts src/web/server.test.ts` | 通过，无错误；保留 `readBrandVar` 原有的 1 条 catch-all 警告  |

品牌接口测试验证登录前只暴露经过校验的显示名、同源 Logo 路径和主题颜色，不返回 Secret、
Namespace、Token 或 Cookie。前端只允许 `VITE_WEB_PROXY_TARGET` 进入公开环境变量，API Client
使用同源 Cookie，并把 CSRF Token 仅保存在页面内存。

组件测试验证登录页会先读取公开品牌配置，飞书 SSO 使用浏览器顶层导航；认证失败页面只显示通用
错误，不泄露 Provider Code、Token 或 OAuth State。生产构建成功生成可发布的 `web/dist/`。

## Web 生产静态资源发布

验证日期：2026-07-27

| 范围                               | 命令                                                                          | 结果                              |
| ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| Host 与 Web 同版本生产构建         | `pnpm build`                                                                  | 通过，生成 `dist/` 与 `web/dist/` |
| 静态资源真实 HTTP 契约             | `pnpm vitest run src/web/server.test.ts`                                      | 通过，1 个测试文件、7 个测试      |
| 前端格式、类型、组件回归           | `pnpm web:format:check && pnpm web:typecheck && pnpm web:test`                | 通过，5 个测试文件、10 个测试     |
| 静态服务、Web Server 新增代码 Lint | `pnpm exec eslint src/web/static.ts src/web/server.ts src/web/server.test.ts` | 通过，无警告                      |
| Host 全量回归                      | `pnpm test`                                                                   | 通过，93 个测试文件、926 个测试   |

静态服务测试使用临时生产目录和真实回环 HTTP Server，验证 `/login`、会话列表和 Lane 页面都只
回退到短缓存的 `index.html`；带内容 Hash 的 JavaScript 使用一年不可变缓存，品牌资源使用一小时
缓存，并正确支持 `HEAD`。API 保持 JSON 身份边界，未知路由不会返回 HTML；Source Map 和指向
`web/dist/` 外部的软链接均返回 `404`。

## Web 会话交互、安全 Markdown 与实时客户端

验证日期：2026-07-27

| 范围                                                                        | 命令                                   | 结果                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| 前端类型检查                                                                | `pnpm web:typecheck`                   | 通过                                                                 |
| 会话列表/创建、发送/稳定重试 ID、403、SSE 重放、Session 撤销、安全 Markdown | `pnpm web:test`                        | 通过，5 个测试文件、10 个测试                                        |
| 前端生产构建                                                                | `pnpm web:build`                       | 通过；登录主包 410.68 KB、按需会话包 338.97 KB，均低于 500 KB 警告线 |
| Host 类型检查                                                               | `pnpm typecheck`                       | 通过                                                                 |
| 主题格式与 WCAG AA 对比度回退                                               | `pnpm vitest run src/branding.test.ts` | 通过，4 个测试                                                       |
| 桌面可视检查                                                                | 本机 Vite + Mock API，1280×720         | 通过；双栏、混合消息、GFM、代码高亮与输入区无溢出                    |
| 窄屏可视检查                                                                | 本机 Vite + Mock API，390×844          | 通过；消息页/列表页切换、返回按钮、代码横向区域和底部输入可用        |

SSE 测试使用浏览器 EventSource 替身验证同一个 Event ID 只触发一次刷新，重连 URL 携带最后的内存
Cursor，服务端 `session-revoked` 会关闭连接并返回登录页。消息测试验证首发失败后点击重试仍使用
同一个 `clientMessageId`；`403` 显示权限变化说明，而不是误报为未登录或普通网络错误。

Markdown 测试验证 Script 被删除、`javascript:` 链接不会变为可点击链接、外链带
`noopener noreferrer`，GFM 表格和带复制按钮的语法高亮代码块正常渲染。主题测试额外证明：
即使颜色字符串是合法十六进制，只要与白字或页面背景不足 4.5:1，也会回退到推荐 Token。

## Web 浏览器端到端与视觉回归

验证日期：2026-07-27

| 范围                       | 命令                                                     | 结果                                           |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| 品牌 Logo 缺失与无障碍回退 | `pnpm web:test`                                          | 通过，6 个测试文件、12 个测试                  |
| 前端类型检查               | `pnpm web:typecheck`                                     | 通过                                           |
| Mock 飞书 + Chromium E2E   | `pnpm --dir web exec playwright test`                    | 通过，桌面/手机共 7 个通过、1 个按设备条件跳过 |
| 桌面与手机视觉基线         | `pnpm --dir web exec playwright test --update-snapshots` | 生成并人工检查 4 张基线图，无横向溢出          |

E2E 使用只监听 `127.0.0.1` 的 Mock 飞书 Provider：浏览器从登录页跳转到授权页，再以 HttpOnly
测试 Cookie 回到 Web 会话。消息提交后由 Mock Host 持久化用户消息、异步生成 Agent 回复并发出
SSE Event；页面刷新后仍能恢复历史。主动断开 SSE 后，测试确认第二次连接携带最后 Cursor；服务端
发送 `session-revoked` 后页面回到登录页。

桌面和手机视觉基线都包含品牌 Logo、深青/暖白主题、会话导航、飞书来源标记和输入区域。手机测试
额外验证从消息页返回列表；`prefers-reduced-motion: reduce` 下，Agent 处理状态的 Logo 动画
计算值为 `none`。正式运营 Logo 的批准仍属于任务 5.9，不因测试资产通过而自动视为完成。

## 跨端逐轮回复路由与群聊隐私

验证日期：2026-07-27

| 范围                                               | 命令                                                                                                                         | 结果                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Delivery 逐轮来源路由、持久化事件、基础 Session DB | `pnpm exec vitest run src/delivery.test.ts src/db/session-db.test.ts src/web/conversations.test.ts src/channels/web.test.ts` | 通过，4 个测试文件、29 个测试                        |
| Host 类型检查                                      | `pnpm typecheck`                                                                                                             | 通过                                                 |
| 新增代码 Lint                                      | `pnpm exec eslint src/db/session-db.ts src/delivery.ts src/delivery.test.ts`                                                 | 通过，无错误；12 条为这些旧文件已有的 catch-all 警告 |
| Host 全量回归                                      | `pnpm test`                                                                                                                  | 通过，93 个测试文件、927 个测试                      |

Delivery 测试在同一个 Alice Lane 中依次写入 Web 和飞书入站行，并故意让对应出站行携带相反的
旧地址。Host 最终仍根据 `in_reply_to` 指向的 Host 单写入站行，分别只投递到 Web 和原飞书
会话；两条回复都产生幂等 Web History 可用事件。该结果证明 Session 初始 Messaging Group 和
Container 提供的地址都不能覆盖当前 Turn 的可信来源。

隐私回归同时覆盖两个边界：Alice/Bob 即使位于同一个飞书群也解析到不同的用户 Lane；测试向
Alice 根 Session 注入带 Bob `origin_user_id` 的异常行后，Alice 的 Web History 仍会 Fail
Closed 地过滤该行。`shared`、`agent-shared` 等多人 Session 也不会自动关联到用户 Lane。

## 用户显式飞书回复订阅与持久化镜像投递

验证日期：2026-07-27

| 范围                                                      | 命令                                                                                                             | 结果                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Host 类型检查                                             | `pnpm typecheck`                                                                                                 | 通过                                    |
| 订阅迁移、身份绑定、镜像投递、飞书幂等和 Bot Self Filter  | `pnpm vitest run src/channels/feishu-webhook.test.ts src/delivery.test.ts src/db/delivery-subscriptions.test.ts` | 通过，3 个测试文件、42 个测试           |
| Web 订阅 API、Owner/Organization 门和浏览器伪造收件人拒绝 | `pnpm vitest run src/web/server.test.ts src/web/conversations.test.ts src/db/delivery-subscriptions.test.ts`     | 通过，3 个测试文件、13 个测试           |
| Web 组件、显式开关与前端生产构建                          | `pnpm web:test && pnpm web:build`                                                                                | 通过，6 个测试文件、13 个测试；构建成功 |
| Host 全量回归                                             | `pnpm test`                                                                                                      | 通过，95 个测试文件、933 个测试         |
| Mock 飞书 SSO + Chromium 桌面/手机端                      | `pnpm web:e2e`                                                                                                   | 9 个通过、1 个按设备条件跳过            |

订阅默认关闭，且只有当前 Lane Owner 能开关。API 只接受布尔值，服务端从相同飞书 App Scope
下已经验证的 `open_id` 推导私聊地址；测试证明浏览器附带 Bob、伪造 `platformId` 或伪造
`externalIdentityId` 都不能改变 Alice 的收件人，Bob 也不能关闭 Alice 的订阅。

Delivery 测试覆盖飞书来源仍回复原飞书并进入 Web History、Web 来源默认只回复 Web、显式开启后
额外发送 Alice 飞书私聊、重复 Drain 不产生第二条镜像，以及关闭后立即停止新镜像。中央账本只保存
Session/出站行引用和状态，不保存正文。

飞书 Adapter 测试证明相同稳定 Delivery ID 的重试会生成相同且不超过 50 字符的 `uuid`。飞书
`sender_type=app` 事件在进入 Router 前被过滤，并记录 `cross_channel_loop_suppressed` 审计；
重复 Callback 仍由现有入站去重表收敛。

受限沙箱内首次运行 Host 全量回归时，项目已知的 `scripts/q.test.ts` 子进程 IPC 限制导致 7 个
失败，另有 2 个 Worker 被系统终止；在允许本地 IPC 的同一环境中复跑后 933/933 全部通过。

## 飞书多维表格 Gateway 机器契约

验证日期：2026-07-27

| 范围                                             | 命令                                                                                                       | 结果                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Runner 类型检查                                  | `pnpm typecheck`（`container/agent-runner`）                                                               | 通过                            |
| Operation、输入/输出、批量语义和封闭错误针对测试 | `pnpm test src/mcp-tools/feishu-bitable-contract.test.ts src/mcp-tools/gateway-contract.test.ts`（Runner） | 通过，2 个测试文件、22 个测试   |
| Runner 全量回归                                  | `pnpm test`（`container/agent-runner`）                                                                    | 通过，29 个测试文件、328 个测试 |
| 契约与文档格式                                   | `pnpm exec prettier --write ...`                                                                           | 通过                            |

新增机器契约覆盖 11 个 `feishu.bitable.*` Operation，并为每个 Operation 提供可执行 Zod 输入/输出
Schema、`/describe` 元数据和安全 Conformance Fixture。输入只允许逻辑 `resource` 别名，不存在
`app_token`/`table_id` 字段；严格对象 Schema 会在进入真实 Gateway Adapter 前拒绝这类额外参数。

Agent 读取页默认 20 条、最大 100 条；单个批次最大 100 条。Batch 必须显式声明 `atomic` 或
`best-effort`，输出 Schema 会拒绝错位索引、虚假的 `ok`/`partial` 和原子批次的部分提交声明。
Gateway 封闭错误新增资源白名单、确认、上游认证、Not Found、Conflict 和 Rate Limit 分类，其中
Conflict/Rate Limit 默认可重试。

Conformance Runner 新增 `GATEWAY_REQUIRE_FEISHU_BITABLE=true` 开关；开启后会检查 `/describe`
是否发布完整多维表格 Operation Catalog。该开关默认关闭，因此不影响未启用多维表格的通用
Gateway。此阶段只证明契约可校验，真实飞书 API Adapter 和 Token 隔离属于后续任务 7.4–7.11。

## 飞书多维表格参考 Gateway Adapter

验证日期：2026-07-27

| 范围                                     | 命令                                                                                   | 结果                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Adapter/Server JavaScript 语法           | `node --check examples/reference-gateway/{feishu-bitable-adapter,server}.mjs`          | 通过                                               |
| Mock 飞书 API 安全与行为回归             | `pnpm test:reference-gateway`                                                          | 通过，10 个测试                                    |
| 带多维表格 Mock 配置的真实 Gateway 契约  | `GATEWAY_REQUIRE_FEISHU_BITABLE=true pnpm exec tsx scripts/gateway-conformance.ts ...` | 通过，9/9 Endpoint                                 |
| Host 类型检查                            | `pnpm typecheck`                                                                       | 通过                                               |
| Host 全量回归（已包含参考 Gateway 测试） | `pnpm test`                                                                            | 通过，95 个 Host 文件/933 测试；10 个 Adapter 测试 |

参考 Adapter 使用应用凭证获取并缓存 `tenant_access_token`，Token 只存在模块闭包，且响应、错误、
Discovery 和审计都不返回凭证。环境配置不完整会在进程启动时 Fail Closed；完全未配置时
`/describe` 不发布多维表格 Operation。测试证明 Agent 附带原始 `app_token`/`table_id` 会在调用
飞书前被严格输入校验拒绝，Table Discovery 也只返回运营者配置的逻辑资源。

每次调用都使用规范 `requester.userId` 和资源 Readers/Writers 策略授权；未知资源、Bob 访问
Alice 资源和 `requesterSource='agent-asserted'` 写均未触发飞书请求。Record/List Cursor 使用
HMAC 签名并绑定资源与查询条件，不暴露或允许跨查询复用飞书 `page_token`。

字段写入使用 TTL Schema 缓存，未知字段会在写前刷新一次以处理 Schema 漂移；仍不合法的字段、
只读字段、类型、选项和必填错误均在调用写 API 前拒绝。Best-effort Batch 把单条本地校验或上游
失败放入索引对齐结果，只有部分提交时才报告 `partial=true`。Atomic 默认关闭，只有运营者明确把
已验证为原子的 Provider 路径加入 `atomicBatchOperations` 后才允许，避免用多次飞书调用伪装事务。

所有写 Operation 共用稳定幂等记录；相同 Key/输入重放返回首次结果，不同输入复用 Key 返回
`CONFLICT`。Delete 和配置的高影响 Update 使用由可信确认服务签发的 HMAC 凭据，绑定规范用户、
Operation、逻辑资源、排序后的 Record 集、字段集和有效期；缺失或错绑确认不会调用飞书。

Mock 测试还验证飞书认证、文档权限、Validation、Not Found、写冲突、超时和限流被转换到平台封闭
错误，`Retry-After` 被限制在 30 秒以内。审计只记录规范用户、Operation、逻辑资源、结果、耗时、
幂等键和 Input Hash；测试值中的单元格正文、真实资源映射及 Token 均未进入审计。

首次 Conformance 刻意只配置 Table 级别名，检查正确报告缺少 `feishu.bitable.table.list`；补充
App 级逻辑别名后，`/describe` 与其余 8 个 Endpoint 全部通过。这证明 Gateway 只宣传实际配置的
能力，不会因为代码存在就虚假声明可用。

## 统一消息端到端与真实容器链路

验证日期：2026-07-27

| 范围                                 | 命令                                                                                        | 结果                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 真实 Host HTTP + Mock 飞书身份提供方 | `pnpm exec vitest run src/web/unified-messaging.e2e.test.ts`                                | 通过，Web/飞书同一规范用户复用同一 Lane 和根 Session          |
| Runner Mock Provider 明确测试标记    | `pnpm test src/providers/mock.test.ts`（Runner）                                            | 通过，3 个测试                                                |
| Host ↔ Runner ↔ SQLite 容器往返      | `CONTAINER_IMAGE=agentdesk-agent-v2-69585351:verify-current pnpm e2e:container`             | 通过，真实容器跨挂载写入 `outbound.db`                        |
| 真实容器 A2A + Gateway               | `CONTAINER_IMAGE=agentdesk-agent-v2-69585351:verify-current pnpm e2e:container:a2a-gateway` | 通过，Frontdesk 与 Worker 两个真实容器完成多跳和 Gateway 审计 |

Web E2E 使用真实 Cookie、CSRF、Router、中央数据库和 Session DB，验证飞书与 Web 入站最终都属于
`user-e2e`。测试还发现并修复了 History 把 Agent 出站 Channel 误信为容器地址的问题：现在只根据
`in_reply_to` 指向的 Host 单写入站行确定来源，并过滤指向其他用户入站行的异常回复。

真实容器链路从 Web 规范身份开始，经过 Frontdesk A2A 委派到 Worker，再调用生产 Gateway MCP
Handler 和本地 HTTP Gateway，最终在容器出站审计和 Host 中央 `gateway_audit` 同时验证
`requesterSource=session`、原始用户、Thread、`feishu.bitable.record.list` 和逻辑资源。

标准 `pnpm container:build` 已实际重试。基础 Node Layer 下载成功，Debian Chromium/GTK
依赖已下载至第 172 个包，但 Docker Desktop 在解包大型 LLVM/Chromium 依赖时以
`cannot allocate memory` 终止；第一次尝试还遇到 Debian 软件源连接超时。为区分本机镜像构建
资源问题与应用回归，本轮复用已有的浏览器/容器运行时系统层，删除旧 `node_modules`，再根据当前
`package.json` 与 `bun.lock` 重新安装 173 个 Runner 包，生成
`agentdesk-agent-v2-69585351:verify-current`。构建日志确认镜像包含 OTel `0.221.0/2.10.0`
和当前锁文件；上述两组真实容器测试均使用该镜像。正式发布流水线仍应在内存和网络充足的构建机
上从标准 Dockerfile 重建、签名并发布镜像，本地 OOM 不属于代码或契约验证通过的替代结论。

## 迁移兼容、独立发布开关和回滚演练

验证日期：2026-07-27

| 范围                                   | 命令                                                                                                                                                                                                | 结果                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 034 版本旧库升级与只读旧查询           | `pnpm exec vitest run src/db/migrations/unified-messaging-compat.test.ts`                                                                                                                           | 通过，1 个测试            |
| Web、Lane、撤销工具和迁移回滚组合      | `pnpm exec vitest run src/web/config.test.ts src/feature-flags.test.ts src/router.conversation-lane.test.ts scripts/revoke-web-sessions.test.ts src/db/migrations/unified-messaging-compat.test.ts` | 通过，5 个文件、20 个测试 |
| Gateway 多维表格开关与 Provider 零调用 | `node --test examples/reference-gateway/feishu-bitable-adapter.test.mjs`                                                                                                                            | 通过，12 个测试           |
| Host 类型检查                          | `pnpm typecheck`                                                                                                                                                                                    | 通过                      |

迁移测试先用真实迁移计划构造 034 版本数据库，写入旧 `feishu:<id>` 用户、旧 Feishu-only
`per-user` Session 和全局 NULL Organization Role，再执行当前升级。升级没有重写用户或 Session，
没有自动猜测 Lane；升级后仍能插入/读取 NULL-org 兼容 Agent Group。数据库加入 Lane 与 Web
Session 数据后，旧字段投影可以只读打开，证明加性 Schema 的紧急代码回滚查询兼容。

四个开关都默认关闭并严格解析。`WEB_ENABLED` 未设置时不产生 Web 配置；关闭 Lane 时，飞书即使
已有 Identity/Binding 也继续使用旧 Session Key，而已由 Web Server 授权的 Web-only Lane 仍可
使用。Gateway 读/写开关分别控制 Discovery 与执行，关闭的 Operation 返回
`OPERATION_NOT_FOUND`，Mock Provider 调用数保持为 0。

回滚工具在临时中央数据库中先 Dry-run 两个用户，再实际撤销两个 Web Session；最终活动 Session
为 0，并产生两条 `web_sessions_revoked` Enterprise Audit。完整的 SSO、反向代理、Cookie/CSRF、
身份、Lane 隐私、多维表格、五阶段灰度和回滚步骤记录在
`docs/web-feishu-unified-messaging-operations.md`。发布开关的权限边界决策记录在 ADR-0065。

## 最终发布门验证

验证日期：2026-07-27

| 范围                      | 命令/检查                                                                                                                           | 结果                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Host 格式                 | `pnpm format:check`                                                                                                                 | 通过                                                               |
| Host Lint                 | `pnpm lint`                                                                                                                         | 通过，0 个错误；195 条为项目现有 Warning                           |
| Host 类型检查与生产构建   | `pnpm typecheck`、`pnpm build`                                                                                                      | 通过                                                               |
| Host 全量测试             | `pnpm test`                                                                                                                         | 通过，102 个测试文件、972/972 个测试                               |
| 参考 Gateway 测试         | `pnpm test:reference-gateway`                                                                                                       | 通过，12/12 个测试                                                 |
| Web 格式、类型与生产构建  | `pnpm web:format:check`、`pnpm web:typecheck`、`pnpm web:build`                                                                     | 通过                                                               |
| Web 单元/组件测试         | `pnpm web:test`                                                                                                                     | 通过，6 个测试文件、13/13 个测试                                   |
| Web Chromium 端到端       | `pnpm web:e2e`                                                                                                                      | 9 个通过、1 个按设备条件跳过                                       |
| Runner 类型检查与全量测试 | `bun run typecheck`、`bun test`（`container/agent-runner`）                                                                         | 通过，30 个测试文件、331/331 个测试                                |
| Host 生产依赖审计         | `pnpm audit --prod --audit-level high`                                                                                              | 退出码 0；2 个中危，1 个已记录且在当前静态 SPA 中不可达的 RSC 高危 |
| Runner 高危依赖审计       | `bun audit --audit-level=high`（`container/agent-runner`）                                                                          | 通过，无高危通告                                                   |
| 严格 Gateway Conformance  | 启用 Bitable 读写 Flag、App/Table 逻辑别名和 `GATEWAY_REQUIRE_FEISHU_BITABLE=true` 的完整检查                                       | 9/9 个 Endpoint 通过，11 个 `feishu.bitable.*` Operation 完整发布  |
| 真实容器 Smoke            | 分别运行带 `CONTAINER_IMAGE=agentdesk-agent-v2-69585351:verify-current` 的 `pnpm e2e:container` 与 `pnpm e2e:container:a2a-gateway` | 两组通过，覆盖 DB 往返、A2A 身份传播、多维表格 Gateway 与审计      |
| OpenSpec 严格校验         | `openspec validate add-web-feishu-unified-messaging --strict --no-interactive`                                                      | 通过                                                               |

依赖审计没有隐藏失败：`react-router-dom` 已固定为当前仓库可安装的 `7.18.1`。审计工具所报
`GHSA-qwww-vcr4-c8h2` 只影响 React Server Components 请求解码，而本项目 Web 端是 Vite 构建的
同源静态 SPA，不包含 React Server Components 服务端运行路径；上游宣称的修复版 `8.3.0` 在本次
验证时尚未发布。该例外及升级触发条件记录在 `SECURITY.md`。其余可达高危依赖已通过 OTel、
`gaxios`、`axios`、`fast-uri` 等版本升级或锁文件 Override 清除。

任务 9.4 的全部代码、契约、依赖和真实容器 Smoke 检查已经完成。任务 5.9 继续保持未勾选：
仓库中的 Logo 组件和测试资产已实现，但用户提供的低分辨率位图不能自动等同于运营者批准的正式
SVG/高分辨率品牌资产；正式素材到位并完成品牌审批后才能关闭该项。

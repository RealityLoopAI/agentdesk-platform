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

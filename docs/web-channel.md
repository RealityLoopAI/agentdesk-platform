# Web Channel

Web Channel 是与飞书 Channel 并列的浏览器入口。它不是第二套 Agent 系统：浏览器消息最终仍进入
同一个 Router、同一个 Conversation Lane、同一个根 Session，以及同一对 `inbound.db` /
`outbound.db`。

## 组件边界

```text
浏览器
  → 独立 Web HTTP Listener（Cookie、CSRF、Origin、限流）
  → Web Conversation Service（用户/Lane/Agent Group 访问门）
  → Web Channel Adapter（Host 可信 Envelope）
  → 通用 Router（Persist-before-route）
  → Lane 根 Session
```

- `src/web/server.ts`：HTTP 信任边界，不与 Webhook 或 Metrics Listener 共用路由。
- `src/web/conversations.ts`：会话列表/创建、分页历史和消息幂等接入。
- `src/web/events.ts`：SSE 连接、断线重放、连接上限、背压和 Session 撤销检测。
- `src/channels/web.ts`：把服务器已经认证的消息转成通用 `InboundEvent`。
- `src/db/web-message-receipts.ts`：只保存客户端重试键和服务端消息 ID，不保存消息正文。
- `src/db/web-events.ts`：只保存已持久化资源的通知引用和顺序，不复制聊天正文。

## 身份与授权

飞书 SSO Cookie 只证明“当前请求是谁”。每次列会话、创建会话、读历史和发消息时，Host 都会重新
执行 `canAccessAgentGroup`，其中包含 Agent Group Membership 和 Organization 隔离。

浏览器提交的 `userId`、`organizationId`、`sessionId`、`conversationLaneId` 和实际
`platformId` 都不能成为权威上下文。服务器从 Web Session 取得规范用户，从 URL 中的 Lane 重新
读取 Owner/Agent Group，并从数据库中的 Web Binding 取得路由地址。只有服务器可以在
`InboundEvent.authenticatedUserId` 与 `conversationLaneId` 上盖章。

## 会话 API

所有 `/api/*` 接口都要求有效的 HttpOnly Web Session。写接口还要求精确同源 Origin 和绑定该
Session 的 CSRF Header。

```text
GET  /api/me
GET  /api/conversations
POST /api/conversations/reconcile
POST /api/conversations
GET  /api/conversations/:laneId/messages
POST /api/conversations/:laneId/messages
GET  /api/conversations/:laneId/delivery-subscription
POST /api/conversations/:laneId/delivery-subscription
GET  /api/events
POST /api/logout
```

`GET /api/conversations` 只返回当前用户拥有且此刻仍有权访问的 Lane，同时返回可创建会话的
Agent Group。`POST /api/conversations` 接受一个待选择的 `agentGroupId`，但 Host 会重新检查
权限；成功后创建用户自有 Lane、专属 Web Messaging Group 和 `per-user` Wiring。

飞书 SSO 成功后，Host 会按当前用户和同一飞书 App Scope 的已验证 `open_id` 做一次最多 50 条的
有界历史协调。新版前端还会通过 `POST /api/conversations/reconcile` 按 Cursor 续跑，再刷新只读
会话列表；该写接口要求 Cookie、CSRF、精确 Origin、限流和每个候选 Agent Group 的当前访问权。
协调按旧根 Session 确定性建 Lane，不扫描或复制正文。`GET /api/conversations` 本身没有协调副
作用。

飞书来源 Lane 起初可以只有飞书 Binding。用户第一次从该 Lane 在 Web 发消息时，Conversation
Service 会在事务内重新执行 Owner、Agent Group 与 Organization 访问门，然后幂等创建私有 Web
Messaging Group/Binding。这个入口只让已授权用户发送消息，不创建 Role 或 Membership；无效
`clientMessageId` 或空正文不会触发创建。

历史接口从 Lane 根 Session 的 `inbound.db` 与 `outbound.db` 合并记录，以服务端时间、Sequence
和消息 ID 形成确定性不透明 Cursor。即使底层文件因异常含有其他 `origin_user_id` 的入站行，
Web History 也会 Fail Closed 地过滤掉。

消息 POST 只读取 `text` 和稳定的 `clientMessageId`。中央
`web_message_receipts` 通过 `(user_id, lane_id, client_message_id)` 唯一约束让并发重试收敛到
同一服务端消息 ID；正文仍只写入 Session DB，不在中央数据库复制 Transcript。

## SSE 实时事件

`GET /api/events` 建立一个用户级 Server-Sent Events（SSE）连接。SSE 是服务器持续向浏览器发送
通知的标准 HTTP 流；浏览器发消息仍使用普通 POST。该接口要求有效 Cookie 和同源证明，不接受
跨站凭证流。请求带有 `Origin` 时必须与 `WEB_PUBLIC_ORIGIN` 完全一致；原生同源
`EventSource` 没有发送 `Origin` 时，Host 只接受同时满足以下条件的请求：

- `Host` 与 `WEB_PUBLIC_ORIGIN` 的 Host（包括非默认端口）完全一致；
- 浏览器生成的 `Sec-Fetch-Site` 精确等于 `same-origin`。

显式 Origin 的判断优先，错误 Origin 或 `Origin: null` 不能通过兼容分支；缺少 Fetch Metadata，
或其值为 `same-site`、`cross-site`、`none` 时同样返回 `403`。POST 写请求仍使用精确 Origin 和
CSRF，不采用这条 SSE 兼容规则。Host 建立流后立即发送 `: connected` 注释帧，让浏览器和代理尽快
确认连接；该帧不进入业务事件或聊天历史。

中央 `web_events` 表持久化 `event_id`、规范用户、Lane、事件类型、服务端资源 ID 和顺序号，
不保存消息正文。浏览器收到事件后根据 `laneId` 重新校验相应 History Query，所以 Session
`inbound.db` / `outbound.db` 仍是唯一消息真相源。

重连时浏览器通过标准 `Last-Event-ID` Header（首连也可使用 `cursor` 查询参数）提交最后看到的
不透明 Cursor。Host 只按该规范用户读取后续事件，并对每条事件重新执行 Lane Owner、
Agent Group 与 Organization 访问门；撤权后未发送的事件不会因为旧 Cursor 泄露。

每个用户最多建立 `WEB_SSE_MAX_CONNECTIONS_PER_USER` 条连接。`ServerResponse.write()` 报告
Backpressure 时，Host 会立即关闭慢连接，由浏览器带 Cursor 重连；不会让慢标签页持续占用 Host
内存。心跳会检查绑定的 Web Session，过期或撤销时发送不含敏感信息的 `session-revoked` 通知并
关闭连接。Host 停机时也会先关闭所有 SSE 流，避免 Listener 无法优雅退出。

Web Agent 回复只有在 `messages_out` 已存在后才进入 Web Adapter；Host 会附带可信的
`messageId/sessionId` 投递引用，Adapter 用它校验 Lane 根 Session 并写入
`conversation.message.available` 事件。重复投递由事件唯一键收敛，不会产生多条通知。

## 跨端回复的默认投递

同一个 Lane 可以连续收到飞书和 Web 消息，但它只对应一个根 Session。因此
`sessions.messaging_group_id` 只表示创建 Session 时的入口，不能代表当前这一轮应回复到哪里。
对于普通用户可见回复，Delivery 会读取出站行的 `in_reply_to`，再从 Host 单写的
`messages_in` 行取得本轮的 `channel_type`、`platform_id` 和 `thread_id`。Container 写入的出站
地址即使过期或错误，也会被这个可信来源地址覆盖。

默认投递规则如下：

- 飞书入站触发的回复投递到原飞书会话，同时写入只含消息引用的 Web Event，浏览器重新读取
  History 后可以看到回复；
- Web 入站触发的回复只投递到该用户自己的 Web Binding，不会因为 Session 最初来自飞书而发送到
  飞书；
- 来源行的 `origin_user_id` 如果与 Lane Owner 不一致，投递会 Fail Closed；
- Web Event 写入失败不会把已经成功发送到外部渠道的消息重新投递，避免制造重复消息。

Web History 仍按 Lane Owner 过滤 `messages_in.origin_user_id`，也拒绝把 `shared`、
`agent-shared` 等多人 Session 自动关联到用户 Lane。因此“飞书回复在 Web 可见”只复用同一用户
已经隔离的根 Session，不会把群内其他参与者或旧 Shared Session 的内容带入浏览器。

### 用户显式开启飞书回复提醒

Web 页面中的“飞书提醒”开关默认关闭。开启后，只有“由 Web 入站触发、已经成功进入 Web History
的 Agent 纯文字回复”会额外发送到该用户自己的飞书私聊；Web 用户消息、卡片、操作消息和附件不会
被镜像。关闭开关不会改变飞书入站回复飞书的默认规则，也不会断开 Lane 的共享历史。

浏览器的 POST Body 只允许 `{ "enabled": true | false }`。服务器从 Web Session 取得规范用户，
重新检查 Lane Owner 和 Agent Group/Organization 访问权，再从相同飞书 App Scope 下已验证的
`user_identities.open_id` 推导私聊地址。浏览器即使附带 `userId`、`platformId` 或
`externalIdentityId` 也不会影响收件人。

额外投递使用中央引用账本持久化重试，但正文继续从 Session `outbound.db` 读取。每次发送前会再次
核对活跃订阅、Lane 和身份；关闭订阅或身份失效会抑制待发送记录。稳定 Delivery ID 同时成为飞书
请求幂等键的来源，避免 Host 重试产生重复私聊。

## 前端工程与品牌

`web/` 是 React + Vite + TypeScript 单页应用。React Router 让当前 Lane 体现在
`/conversations/:laneId` URL 中；TanStack Query 保存服务器返回的会话与消息状态。Tailwind CSS
负责语义化主题 Token，仓库自有的 shadcn 风格组件与 Radix UI 原语负责可访问交互。开发期运行
`pnpm web:dev`，类型、组件测试和生产构建分别运行 `pnpm web:typecheck`、`pnpm web:test` 与
`pnpm web:build`。

浏览器请求只使用 `/api/*` 和 `/auth/*` 相对路径，并携带同源 HttpOnly Cookie。CSRF Token 只保留
在页面内存，不写入 Local Storage、Session Storage 或 IndexedDB。Vite 的公开环境变量只允许
`VITE_WEB_PROXY_TARGET`，它仅供本机开发代理使用；变量名或值疑似包含 Secret 时构建会失败。

登录前可访问的 `GET /api/branding` 只返回显示用途的品牌投影：

- `displayName`：来自 `BRAND_NAME`，控制字符或超长值回退为通用名称；
- `logoPath`：来自 `BRAND_UI_LOGO_PATH`，只接受不含查询参数的同源 SVG/PNG/WebP 路径；
- `theme`：只接受六位十六进制颜色，非法值逐项回退。

默认主题把运营者提供 Logo 的深青色与连结感用于重点动作，正文区域保持暖白色以减少长时间阅读
疲劳。前端以 CSS 变量应用公开 Token，Logo 加载失败时显示文字回退，不会执行远程脚本或读取本机
文件路径。可选主题变量为 `BRAND_UI_PRIMARY`、`BRAND_UI_PRIMARY_HOVER`、
`BRAND_UI_PRIMARY_ACTIVE`、`BRAND_UI_SURFACE_SUBTLE`、`BRAND_UI_BORDER`、
`BRAND_UI_CANVAS`、`BRAND_UI_SURFACE`、`BRAND_UI_NEUTRAL_BORDER`、
`BRAND_UI_TEXT_PRIMARY`、`BRAND_UI_TEXT_SECONDARY`、`BRAND_UI_STATUS_SUCCESS`、
`BRAND_UI_STATUS_WARNING` 和 `BRAND_UI_STATUS_DANGER`。

后端除检查颜色格式外，还会检查主要文字、品牌按钮和状态色是否达到 WCAG AA 的 4.5:1 对比度；
合法但对比度不足的自定义值也会回退。前端的全局 `prefers-reduced-motion` 规则会关闭非必要动画。

## 前端会话与实时状态

桌面端使用会话侧栏和消息区双栏布局；窄屏只显示其中一页，并通过 URL 与返回按钮切换。侧栏只呈现
`GET /api/conversations` 当前返回的 Lane 与 Agent Group，创建会话仍由 Host 重新授权。当前 Lane
始终写入 `/conversations/:laneId`，所以刷新或复制同源 URL 后可以恢复选择。

会话页以飞书已有对话为主流程：协调完成后直接列出助手名称、来源渠道和最后活动时间，打开历史不
出现选择助手步骤。“新建 Web 对话”是次要操作；没有可用助手时提示联系管理员，只有一个助手时
直接创建，多个助手时才打开选择框。终端文案使用“助手”，不显示 Agent Group 或 Lane 等内部名词。

历史记录由 TanStack Query 分页读取并按服务端时间、Sequence、方向和消息 ID 确定性排序。用户发送
消息时生成稳定 `clientMessageId`：本地先显示发送中，POST 返回后绑定服务端消息 ID，随后与 History
和 SSE 通知归并。失败气泡保留原始客户端 ID，点击重试不会创建新的幂等键。

整个应用只有一个用户级 EventSource。Cursor 和最近 Event ID 只存在页面内存；重连时把最后 Cursor
作为 `/api/events?cursor=...` 提交。重复 Event 会被忽略，断线采用带抖动的有界指数退避；恢复后只
触发权威 Query 刷新，不把 SSE Payload 当作消息正文。`session-revoked` 会清除内存 CSRF 并返回
登录页。

Agent 正文使用 `react-markdown`、GFM、`rehype-sanitize` 和安全代码高亮。JavaScript 等危险链接不会
生成可点击锚点，远程图片不会加载；外链使用新窗口隔离属性。代码块带语言高亮、横向滚动和复制按钮，
表格在窄屏可横向滚动。

## 运行配置

Web Listener 默认关闭。启用时至少需要配置 `WEB_ENABLED=true`、精确的
`WEB_PUBLIC_ORIGIN`、强随机 `WEB_SESSION_SECRET` 和飞书 SSO 应用参数。完整配置项与校验规则见
`src/web/config.ts`。本机开发如果使用 HTTP，必须显式开启仅限回环地址的
`WEB_ALLOW_INSECURE_HTTP`。

当前登录流程只使用飞书返回的应用内 `open_id`，因此 `FEISHU_SSO_SCOPE` 默认留空，授权地址也不会
强制附加 `scope` 参数。只有确实需要额外用户字段或 API、并已在飞书开放平台审批相应权限时才填写
该变量；它与身份映射中表示 App 边界的 `provider_scope` 不是同一概念。

跨渠道自动关联由独立的 `CROSS_CHANNEL_LANES_ENABLED` 控制，默认关闭。关闭时，Web 中经过授权的
Lane 仍可正常使用，但原生飞书消息继续命中旧 Session Key，不会仅因数据库中已有 Binding 就合并
历史。完整的反向代理、SSO、Cookie/CSRF、身份关联、灰度顺序和回滚操作见
[Web 与飞书统一消息运维手册](web-feishu-unified-messaging-operations.md)。

生产发布先运行 `pnpm build`，它会同时生成 Host `dist/` 与前端 `web/dist/`。Host 从该固定相对
目录提供静态文件：带 Vite 内容 Hash 的 Asset 使用一年不可变缓存，HTML 使用 `no-cache`，品牌
文件使用一小时缓存。`/login`、`/conversations` 和 `/conversations/:laneId` 支持 SPA 回退；
`/api`、`/auth`、`/healthz` 与未知路径保持自己的 HTTP 语义，不会返回 HTML。Source Map 不进入
生产构建，真实路径越过 `web/dist/` 的软链接会被拒绝。

浏览器端回归使用 `pnpm web:e2e`。测试会启动仓库内的本地 Mock 飞书身份提供方，不连接真实飞书
或读取真实用户；随后分别以桌面和手机尺寸验证 SSO 重定向、消息往返、刷新恢复、SSE 断线游标
重连、Session 过期、低动态模式与视觉基线。首次准备本机环境需执行
`pnpm --dir web exec playwright install chromium`。

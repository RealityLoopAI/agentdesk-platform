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
POST /api/conversations
GET  /api/conversations/:laneId/messages
POST /api/conversations/:laneId/messages
GET  /api/events
POST /api/logout
```

`GET /api/conversations` 只返回当前用户拥有且此刻仍有权访问的 Lane，同时返回可创建会话的
Agent Group。`POST /api/conversations` 接受一个待选择的 `agentGroupId`，但 Host 会重新检查
权限；成功后创建用户自有 Lane、专属 Web Messaging Group 和 `per-user` Wiring。

历史接口从 Lane 根 Session 的 `inbound.db` 与 `outbound.db` 合并记录，以服务端时间、Sequence
和消息 ID 形成确定性不透明 Cursor。即使底层文件因异常含有其他 `origin_user_id` 的入站行，
Web History 也会 Fail Closed 地过滤掉。

消息 POST 只读取 `text` 和稳定的 `clientMessageId`。中央
`web_message_receipts` 通过 `(user_id, lane_id, client_message_id)` 唯一约束让并发重试收敛到
同一服务端消息 ID；正文仍只写入 Session DB，不在中央数据库复制 Transcript。

## SSE 实时事件

`GET /api/events` 建立一个用户级 Server-Sent Events（SSE）连接。SSE 是服务器持续向浏览器发送
通知的标准 HTTP 流；浏览器发消息仍使用普通 POST。该接口同时要求有效 Cookie 和精确
`Origin`，不接受跨站凭证流。

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

## 运行配置

Web Listener 默认关闭。启用时至少需要配置 `WEB_ENABLED=true`、精确的
`WEB_PUBLIC_ORIGIN`、强随机 `WEB_SESSION_SECRET` 和飞书 SSO 应用参数。完整配置项与校验规则见
`src/web/config.ts`。本机开发如果使用 HTTP，必须显式开启仅限回环地址的
`WEB_ALLOW_INSECURE_HTTP`。

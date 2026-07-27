# ADR-0062: 用用户级 Lane 承载飞书与 Web 连续会话

- **Status**: Accepted
- **Date**: 2026-07-27
- **Decider(s)**: 用户（确认 Web 与飞书消息互通方案）；coding agent（提案与执行）
- **Tags**: `web`, `channels`, `session-isolation`, `identity`, `db`, `sse`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

现有 Session Resolver 会把渠道 Messaging Group 纳入用户级 Session 查询，因此同一个规范用户从
飞书和 Web 进入时仍会落到两个 Session。把 Web 接到 `agent-shared` 会让互不信任的用户共享上下文，
不可接受。

ADR-0039 已明确 `conversation_thread_id` 是 Host 拥有的纯观测关联字段，禁止把它用于授权、路由或
结构查询。本变更需要一个新的、明确属于单一用户和 Agent Group 的结构键，同时保持三 DB 单写者和
Organization Host 门控不变。

## Options Considered

- **Option A：复用 `conversation_thread_id`。** 字段已经存在，但这直接违背 ADR-0039，并会让
  可选观测数据成为消息路由的承重结构。
- **Option B：使用 `agent-shared` Session。** 无需新 Schema，但会混合不同终端用户的历史和身份。
- **Option C：新增用户级 Conversation Lane 和经过验证的 Channel Binding。** 能明确表达所有权、
  可见性和投递地址；需要加性 Schema 与 Resolver 扩展。

## Decision

> **拍板**：选择 Option C，并为 Web 使用独立 HTTP Listener、POST 入站与 SSE 出站。

`conversation_lanes` 由 `owner_user_id + agent_group_id` 确定所有权并指向一个根 Session；
`conversation_bindings` 保存经过验证的 Web/飞书入口和投递模式；`sessions` 增加
`conversation_lane_id`。Organization 不复制到 Lane，而是继续从不可变的 Agent Group 关联推导。

只有 `per-user` 与 `per-user-per-thread` Session 可以显式关联。`shared`、`per-thread` 和
`agent-shared` 不得自动合并。跨渠道查询必须使用 Lane ID 或根 Session 等结构键，**不得使用
`conversation_thread_id`**。

Lane 继续复用现有 `inbound.db` 与 `outbound.db` 作为消息真相源，不新增第二份可写 Transcript。
每条入站消息保留自己的渠道、Platform、Thread、外部消息 ID 和规范用户；Agent 回复默认回到触发
该 Turn 的地址。Web 发出的消息默认只回 Web，飞书私聊镜像只能由用户显式启用，群聊不自动镜像。

Web Server 在单一 Host 进程中使用独立 `WEB_PORT`，与 Webhook/Metrics Listener 隔离。写入用
认证 POST；只有持久化完成后的事件才能进入 SSE；Cursor 重放读取权威持久化数据。

浏览器重试使用中央 `web_message_receipts` 做幂等收敛，唯一键为规范用户、Lane 和
`client_message_id`。该表只记录服务器消息 ID 和处理状态，不保存正文；Transcript 仍只存在于
Lane 根 Session 的 DB Pair。Web SSO 得到的规范用户通过 Host-only
`InboundEvent.authenticatedUserId` 传给 Router，不从 Agent 可见的浏览器 JSON 推导。

## Consequences

- **Positive**: 同一用户可在飞书与 Web 继续一个 Agent 上下文，同时保持 Alice/Bob、群聊和
  Organization 隔离。
- **Negative**: Resolver、投递路由、历史合并和迁移逻辑复杂度上升；需要明确处理 SQLite NULL
  唯一语义和旧 Session 关联。
- **Neutral / Trade-offs**: “消息互通”首先表示共享历史和上下文，不表示把每条 Web 私密消息自动
  发布到飞书群。

## Implementation Notes

- 新增 Lane/Binding 表、Partial Unique Index 和 `sessions.conversation_lane_id`。
- 新增不含正文的 Web 消息回执表，使并发重试返回同一个服务端消息。
- Web Adapter 必须先认证并由服务端解析用户/Lane，浏览器字段不能覆盖上下文。
- 回复路由从触发入站行读取来源，不再把 `sessions.messaging_group_id` 当作唯一地址。
- SSE 只通知已持久化事件，支持授权后 Cursor 重放、连接上限和 Backpressure。
- 增加 `conversation_thread_id` 禁止用于 Lane 查询的守卫测试。
- 依赖 ADR-0022、ADR-0039、ADR-0052。

## References

- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- ADR-0022、ADR-0039、ADR-0052

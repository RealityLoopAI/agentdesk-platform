# ADR-0066: 飞书已有会话作为 Web 主流程，并以根 Session 做确定性协调

- **Status**: Accepted
- **Date**: 2026-07-28
- **Decider(s)**: 用户（确认飞书已有对话自动进入 Web 为主流程）；coding agent（提案与执行）
- **Tags**: `web`, `feishu`, `conversation-lane`, `identity`, `privacy`, `reconciliation`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0061 和 ADR-0062 已确定规范外部身份与 Conversation Lane，但最初的 Web 入口仍以“选择助手并
新建 Web 会话”为主要交互。真实产品流程相反：用户通常先在飞书里与已经 Wiring 好的机器人或
多维表格助手聊天，再登录 Web 查看和继续原对话。要求用户再次选择助手既重复了飞书端已经完成的
路由决定，也无法让升级前已经存在的个人飞书 Session 自动出现。

不能把“同一用户 + 同一 Agent Group”的所有历史直接合并，因为同一用户可能在不同飞书私聊、群聊
或线程中拥有多条独立根 Session。也不能扫描消息正文猜测归属，或把 `shared`、`per-thread`、
`agent-shared` 等多人上下文回填到个人 Web。

## Options Considered

- **Option A：保持 Web-first，用户选择助手后新建会话。** 实现简单，但看不到既有飞书历史，且让
  浏览器重复决定原本由飞书 Wiring 决定的 Agent Group。
- **Option B：按用户和 Agent Group 合并全部历史。** 列表简洁，但会把多个独立上下文静默拼接；
  对共享模式尤其会造成隐私泄露。
- **Option C：新飞书入站自动关联，旧个人 Session 按根 Session 定向协调。** 保留原有上下文边界，
  同时让飞书成为主入口；需要有界、幂等、可审计的协调服务和冲突处理。

## Decision

> **拍板**：选择 Option C。

当 `CROSS_CHANNEL_LANES_ENABLED=true` 时，飞书入站 Router 只有在 Adapter 身份已验证、
Messaging Group Wiring 已确定 Agent Group、规范用户已解析、Host 访问门已通过且 Session Mode
为 `per-user` 或 `per-user-per-thread` 后，才确定性创建或复用 Lane 与飞书 Binding。自动关联
不得创建 `user_roles`、`agent_group_members` 或 `organization_members`。

每条既有合格飞书根 Session 映射到自己的 Lane。相同 Session 或精确 Binding 重试必须收敛到同一
Lane；同一用户与同一助手下的不同根 Session 不得合并。协调只查询中央数据库中的结构字段，不读取、
复制或搜索 `inbound.db` / `outbound.db` 正文；历史仍从该根 Session 的权威 DB 对组装。

SSO 成功后执行一次最多 50 条的用户定向协调。已登录浏览器通过有 CSRF、Origin、限流和逐请求权限
检查的 `POST /api/conversations/reconcile` 分页续跑；`GET /api/conversations` 保持只读。运营者
可在停止 Host 后使用默认 Dry Run 的 CLI 做有界回填。冲突 Fail Closed 并写指标与 Enterprise
Audit，不因协调失败撤销已经成功的 SSO 登录。

飞书来源 Lane 第一次从 Web 发消息时，Host 在事务内重新检查 Owner、Agent Group 与 Organization
访问门，再按需创建私有 Web Messaging Group 和 Binding。该步骤只增加路由入口，不授予任何权限。
撤权后 Lane 立即从列表和历史 API 隐藏；恢复原权限后仍复用原 Lane。

Web UI 登录后先协调再读取列表，直接展示飞书已有会话，并显示助手、来源和最后活动时间。“新建 Web
对话”保留为次要操作：零个助手时提示联系管理员，一个助手时直接创建，多个助手时才让用户选择。

## Consequences

- **Positive**: 用户登录 Web 即可看到已有飞书对话；新旧会话都不需要复制 Transcript；不同用户、
  不同根 Session 和共享模式继续保持隔离；读取 API 无写副作用。
- **Negative**: 首次登录可能只协调一个有界批次，前端或运营命令需要按 Cursor 续跑；飞书来源 Lane
  首次从 Web 发言会产生一组私有 Web 路由记录。
- **Neutral / Trade-offs**: `CROSS_CHANNEL_LANES_ENABLED` 只门控原生飞书入站自动关联。受认证
  SSO、显式协调 API 和运营 CLI 是独立的定向回填入口；灰度时必须分别观察其指标。关闭开关不会
  删除已经建立的 Lane 或历史。

## Implementation Notes

- 入站关联与历史协调：`src/conversation-reconciliation.ts`
- Router 信任门：`src/router.ts`
- Lane/Binding 结构约束：`src/db/conversation-lanes.ts`
- SSO 与显式协调 API：`src/web/feishu-sso.ts`、`src/web/server.ts`
- Web 按需入口：`src/web/conversations.ts`
- 运营 CLI：`scripts/reconcile-feishu-conversations.ts`
- 指标：`agentdesk_conversation_reconciliations_total{trigger,outcome}`
- 端到端验收：`src/web/unified-messaging.e2e.test.ts`

## References

- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- `openspec/changes/add-web-feishu-unified-messaging/specs/web-channel/spec.md`
- ADR-0061、ADR-0062、ADR-0065

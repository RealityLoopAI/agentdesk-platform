# ADR-0068: 多维表格试点允许可信规范用户读取和单条新增

- **Status**: Accepted
- **Date**: 2026-07-29
- **Decider(s)**: 平台运营者；coding agent（提案与执行）
- **Tags**: `gateway`, `feishu`, `bitable`, `authorization`, `pilot`, `fail-closed`
- **Supersedes**: —
- **Superseded by**: —
- **Extended by**: ADR-0073（Update 确认路径；Read/Create 决策继续有效）

---

## Context

ADR-0063 已决定飞书多维表格只能通过 Backend Gateway 访问。首轮试点需要让飞书与 Web
进入同一会话 Lane 的用户读取记录并新增单条记录，同时避免在尚未建立细粒度业务角色前把
更新、删除或批量写入一起开放。

已知约束：

- Host 产生并跨 A2A 传播的规范用户身份是授权输入；Agent 自报身份不可信。
- `app_token`、`table_id`、飞书应用凭据和租户 Token 只能存在于 Gateway。
- 参考 Gateway 的幂等缓存是进程内存，只适合试点。
- 飞书群聊上下文不能自动扩大写权限。

## Options Considered

- **Option A：按用户逐个维护白名单。** 权限粒度高，但试点阶段每新增用户都要改 Gateway
  配置，且容易造成飞书与 Web 身份映射后的不一致。
- **Option B：资源级 `"*"` 授予所有可信规范用户 Read + Create。** 配置简单且跨渠道一致；
  风险通过身份信任链、Operation 白名单、字段校验、显式确认与审计约束。
- **Option C：开放全部 Bitable 写 Operation。** 功能最完整，但会同时暴露 Update、Delete
  和 Batch，超出本轮需求和可接受的试点风险。

## Decision

> **拍板**：选 Option B。

单个逻辑资源显式配置 `readers:["*"]`、`writers:["*"]`，其中 `"*"` 仅匹配非空、由 Host
会话信任链提供的规范用户 ID。资源目录只发布 Read Operations 与
`feishu.bitable.record.create`；Update、Delete 和全部 Batch Operations 不进入目录，直接
执行也必须在到达飞书 API 前被 Gateway 拒绝。

Create 仍必须满足字段 Schema、稳定幂等键和面向用户的最终摘要确认。匿名请求以及
`requesterSource="agent-asserted"` 的写请求保持 Fail Closed。

## Consequences

- **Positive**: 所有已完成规范身份映射的飞书/Web 用户获得一致的试点读写体验；无需把
  用户名单或飞书资源 ID 注入 Agent。
- **Negative**: `"*"` 不是业务角色模型；任何可信规范用户都可新增到该试点资源，因此
  资源本身必须是低风险试验表。
- **Neutral / Trade-offs**: Prompt 级确认改善交互安全，但不等同于 Gateway 签名确认令牌；
  后续若扩大到高影响字段、更新或删除，必须另行设计并复审。

## Implementation Notes

- 当时的 Gateway 模板已随下一阶段改名为
  `examples/reference-gateway/bitable-query-create-update.env.example`
- Gateway 适配器与测试：`examples/reference-gateway/feishu-bitable-adapter.mjs`
- Worker：`groups/agentdesk-bitable-worker/`
- 运营说明：`docs/feishu-bitable-pilot.md`
- 上游决策：ADR-0063、ADR-0065、ADR-0017、ADR-0034。

## References

- `openspec/changes/enable-feishu-bitable-read-create/`
- `openspec/specs/feishu-bitable-operations/spec.md`

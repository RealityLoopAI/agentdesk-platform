# ADR-0063: 飞书多维表格只通过 Backend Gateway 访问

- **Status**: Accepted
- **Date**: 2026-07-27
- **Decider(s)**: 用户（确认多维表格 Agent 方案）；coding agent（提案与执行）
- **Tags**: `gateway`, `feishu`, `bitable`, `security`, `audit`, `contract`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

仓库的 `lab-frontdesk` 示例声称飞书 Channel 可以维护多维表格，但当前 Feishu Adapter 只负责聊天
认证、IM、Reaction、Image 和成员查询，没有多维表格 API、Agent Tool 或 Gateway Operation。

平台的承重不变量要求业务授权、执行和长期业务数据只能经过 Backend Gateway。多维表格应用凭证
通常拥有比单个用户更宽的权限，因此必须远离 Prompt、浏览器和可能被 Prompt Injection 接管的
Agent 容器。

## Options Considered

- **Option A：在 Feishu Channel Adapter 中直接调用多维表格。** 复用现有 Tenant Token 看似简单，
  但会把聊天传输层变成业务后端，Web 来源无法复用，并绕过 Gateway 授权与审计。
- **Option B：在 Agent 容器中运行持有凭证的多维表格 MCP。** 工具接入直接，但凭证靠近不可信
  Agent 执行环境，且形成平行业务授权路径。
- **Option C：定义 `feishu.bitable.*` Gateway Operation。** 所有来源共享一套授权、幂等、确认、
  限流和审计边界；需要扩展 Gateway 契约和参考实现。

## Decision

> **拍板**：选择 Option C。

Agent 仍只调用 `gateway_describe`、`gateway_authorize`、`gateway_execute` 和
`gateway_bulk_execute`。Gateway 通过可发现的 `feishu.bitable.*` Operation 覆盖 App/Table/Field
元数据及 Record List/Get/Create/Update/Delete 和批量操作。

首期使用 Gateway 内的飞书应用凭证。Agent 只能提交稳定逻辑资源别名，Gateway 将其映射到运营者
批准的 `app_token`/`table_id`。每次调用都根据规范请求者、Operation、逻辑资源和 Record Scope
执行后端业务授权；`requesterSource='agent-asserted'` 的写默认拒绝。

写操作必须进行字段 Schema 校验并使用稳定幂等键；删除和高影响更新需要绑定用户、资源、Record
集合和有效期的确认；批量返回索引对齐结果；飞书错误转换为封闭错误；审计记录安全 Input Hash，
不得记录 Token 或无界单元格明文。

Prompt 只能把多维表格描述为潜在能力。只有 `gateway_describe` 实际声明所需 Operation 后才能向
用户声称可用。

## Consequences

- **Positive**: 飞书和 Web 来源复用同一业务契约；凭证、授权、幂等、确认和审计集中在正确边界。
- **Negative**: 参考 Gateway 需要维护飞书 Token、Schema 缓存、限流与错误转换；应用凭证权限较宽，
  必须依赖资源白名单和逐请求策略补足。
- **Neutral / Trade-offs**: 首期不支持需要严格继承飞书原生个人 ACL 的用户委派 Token；该能力若
  需要，应另立凭证生命周期设计。

## Implementation Notes

- 扩展 Gateway 契约、Conformance Fixtures 和参考 Gateway。
- Operation Catalog 与输入/输出 Schema 写入 `docs/enterprise-erp-gateway.md`。
- Channel 和 Web 代码不得 import 多维表格客户端或持有相关 Token。
- 增加分页、Schema 漂移、限流、部分失败、幂等重放和未确认删除测试。
- 修正示例 Prompt，并让能力声明依赖 `gateway_describe`。
- 依赖 ADR-0028、ADR-0048；不修改 ADR-0052 的 Host Organization 边界。

## References

- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- ADR-0028、ADR-0048、ADR-0052

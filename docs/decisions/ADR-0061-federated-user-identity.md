# ADR-0061: 用外部身份映射连接规范用户与渠道身份

- **Status**: Accepted
- **Date**: 2026-07-27
- **Decider(s)**: 用户（确认飞书与 Web 互通方案）；coding agent（提案与执行）
- **Tags**: `identity`, `security`, `feishu`, `web`, `db`, `migration`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

平台当前将外部渠道身份直接编码进 `users.id`，例如 `feishu:ou_xxx`。这种形状可以安全地
支持单一飞书入口，却无法表达“同一个人通过飞书消息事件和飞书 SSO 登录”这两个经过不同
协议验证的外部身份，也无法表示不同飞书应用 Scope 下 `open_id` 的差异。

本变更必须让飞书和 Web 解析到同一个规范用户，同时保持以下约束：

- 浏览器不能自报或选择规范用户。
- ADR-0017 的 `origin_user_id` 交叉校验、HMAC 和审计链不得削弱。
- 既有 `users.id`、角色、成员关系、Session 和审计外键不得被高风险全量重写。
- OAuth Code、Access Token 和 Refresh Token 不得进入中央业务表、Session DB 或 Agent 容器。
- Organization 仍只用于 Host 访问门，不成为外部身份的一部分。

## Options Considered

- **Option A：继续把外部标识直接作为 `users.id`。** 无迁移成本，但无法区分 Provider Scope，
  也不能可靠表达一个用户的多个已验证身份。
- **Option B：将所有用户改写为新 UUID。** 模型表面最整洁，但需要重写角色、Session、审计和
  A2A 信任链引用，迁移风险远高于用户收益。
- **Option C：保留规范用户，增加唯一外部身份映射。** 加性迁移；既有 ID 继续合法；新身份通过
  Provider、Scope、类型和值唯一定位。代价是解析时多一次带索引查询。

## Decision

> **拍板**：选择 Option C。

新增 `user_identities`，每条记录只把一个经过可信协议验证的外部 Subject 关联到一个规范
`users.id`。唯一键必须包含 `provider`、`provider_scope`、`identifier_type` 和
`external_subject`，禁止根据姓名、邮箱或工号静默合并。

既有 `feishu:<id>` 用户在标识无歧义时只做加性回填，不改写用户主键。新用户可以使用不透明
`usr-*` ID。关联冲突一律 Fail Closed；重新关联必须是独立、受审计的管理动作，不能成为登录
副作用。

身份解析顺序固定为：

```text
可信渠道或 SSO 身份
  -> user_identities 唯一查询
  -> 安全的旧用户兼容回填
  -> 规范 users.id
  -> 既有 Host 访问门
```

表中只保存非敏感身份元数据和时间戳，不保存任何 OAuth 凭证。

## Consequences

- **Positive**: 飞书消息与 Web SSO 能归一到同一用户；支持未来增加其他渠道身份；旧授权记录
  和 Session 不需要重写。
- **Negative**: 身份解析增加一层数据模型和冲突处置流程；不同飞书应用的 `open_id` 不会自动
  合并，需要兼容 Scope 或管理员证明。
- **Neutral / Trade-offs**: 旧 `users.id` 仍可能带渠道形态，但新代码必须将其视为不透明主键，
  不再从字符串中推导业务语义。

## Implementation Notes

- 中央迁移创建 `user_identities` 和唯一索引。
- DB 模块负责查询、原子创建、Last Seen、冲突检测、受审计重新关联和安全回填。
- Feishu Channel 与 Web SSO 只向身份解析器提交各自经过验证的 Subject。
- 增加不同 Provider、Scope、标识类型、冲突和旧用户回填测试。
- 依赖 ADR-0017、ADR-0019、ADR-0052；不得修改 Gateway 的 Organization 输入。

## References

- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- ADR-0017、ADR-0019、ADR-0052

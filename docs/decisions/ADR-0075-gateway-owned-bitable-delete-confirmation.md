# ADR-0075: Gateway-owned 单条 Bitable Delete 确认与核验

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: RealityLoop（需求与真实表格授权），Codex（提案、实现与审计）
- **Tags**: `gateway`, `feishu`, `bitable`, `delete`, `confirmation`, `identity-trust-chain`, `idempotency`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0073 已为单条 Bitable Update 建立 Gateway Preview → Host 收集可信用户确认 → Gateway 签发绑定 Token → 提交前指纹校验的闭环。参考 Bitable Adapter 仍保留一个旧的直接 Delete Provider 调用和 v1 服务侧确认原语，但 Agent 没有可信方式取得该 Token；该路径不展示当前记录内容、不绑定记录指纹，也不核验删除后的状态，因此试点正确地没有发布 Delete。

用户现在要求在运营者指定的真实表格上跑通自然语言增删改查。已知约束是：

- Backend Gateway 仍是唯一业务访问和授权路径。
- Host 必须从可信 Session/A2A 身份链解析原请求者，不能信任 Agent 自报 Actor。
- 飞书群聊不能因为共享上下文扩大写权限。
- 真实 Provider ID 和凭据不能进入 Prompt、模型上下文、Web 或 Git。
- 三 DB 单写者和 ADR-0073 的 Token 私密投递边界不能弱化。
- 真实验收不得删除既有业务记录，只能删除本轮创建并核验的唯一测试记录。

## Options Considered

- **Option A：继续使用遗留 v1 Delete Confirmation**。改动小，但确认不是由 Gateway 当前记录预览驱动，不绑定指纹，也没有可信 Agent 获取路径；无法满足真实用户确认和并发安全。
- **Option B：由 Worker Get 后自行展示，再调用直接 Delete**。实现简单，但 Agent 可以让展示内容与最终目标漂移，Prompt 文字不能成为可验证授权事实。
- **Option C：为 Delete 增加独立 Gateway-owned v2 Preview/Token，并复用 Host Broker**。与 Update 保持相同信任模型，同时让 Delete Binding 不需要虚构 Patch；需要扩展 Gateway、Runner、Host 和 UI。

## Decision

> **拍板**：选择 Option C。

单条 Delete 使用独立的 `bitable-delete-preview` 与 `bitable-delete-confirmation` purpose。Preview 在 Gateway 授权后读取当前完整 Record，返回有界字段摘要和稳定指纹；Token 绑定规范用户、Agent Group、Operation、逻辑资源、`recordId`、预期指纹、有效期和 Nonce。Host 只收集原请求者确认并经既有签名代理请求 Gateway 签发，不形成第二套业务授权路径。

提交顺序固定为：幂等 Replay → Token 验证 → 重新 Get/指纹比较 → Provider Delete → Get 明确 `NOT_FOUND` 核验。相同稳定幂等键返回首次已核验结果；不同目标或指纹重绑定返回冲突。

## Consequences

- **Positive**: 用户看到的删除目标与 Token 可验证绑定；确认后记录变化会 Fail Closed；Delete 可安全进入飞书/Web 的既有确认体验。
- **Positive**: 删除结果包含 Delete/Get Audit 关联，不再把 Provider 返回 2xx 直接等同于已核验完成。
- **Negative**: Provider 没有条件 Delete 时，提交前重读到 Delete 之间仍有小 TOCTOU 窗口；参考实现不声称强锁。
- **Negative**: 参考 Gateway 的幂等和 Nonce 状态仍在进程内，重启后不能作为生产级事务保证。
- **Neutral / Trade-offs**: Update v2 格式保持不变；Delete 使用独立 Binding/Display 校验，换取更小回归面和更清楚的语义。

## Implementation Notes

- 契约：`container/agent-runner/src/mcp-tools/feishu-bitable-contract.ts`
- Gateway：`examples/reference-gateway/feishu-bitable-adapter.mjs`
- Host/Runner：`src/modules/gateway-confirmation/`、`container/agent-runner/src/mcp-tools/gateway-confirmation.ts`
- Central DB：以保留既有 Pending 数据的向前迁移扩展确认 `kind` 检查约束，允许 `delete`；列结构与单写者不变。
- Web：`web/src/conversations/GatewayConfirmationPanel.tsx`
- Worker/资源：`examples/bitable-pilot/`
- 真实 Provider 标识只写入忽略提交的运行时 `.env`，Tracked 示例使用占位符和逻辑别名。
- 回滚首先从资源 `allowedOperations` 移除 `feishu.bitable.record.delete`，不删除审计或待确认记录。

## References

- [ADR-0063](ADR-0063-feishu-bitable-through-gateway.md)
- [ADR-0068](ADR-0068-bitable-trusted-users-read-create-pilot.md)
- [ADR-0073](ADR-0073-host-mediated-gateway-confirmation.md)
- `openspec/changes/enable-feishu-bitable-real-record-crud/`

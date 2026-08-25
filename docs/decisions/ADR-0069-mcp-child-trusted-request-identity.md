# ADR-0069: MCP 子进程从 Host 入站行重建可信请求身份

- **Status**: Accepted
- **Date**: 2026-07-29
- **Decider(s)**: platform owner（要求真实 Bitable 新增），coding agent（运行时诊断与执行）
- **Tags**: `identity-trust-chain`, `gateway`, `agent-runner`, `mcp`, `fail-closed`

---

## Context

真实 Web → Frontdesk → Bitable Worker 验收发现：poll loop 已从 Host 写入的
`origin_user_id` 正确得到规范用户，但内置 Gateway MCP Server 是独立 `bun` 子进程，
父进程的 `getRequestIdentity()` 模块单例不会跨进程，因此请求被错误标为
`requesterSource="agent-asserted"`。参考 Gateway 按设计拒绝此类 Create。

身份不能通过模型工具参数或静态容器环境传递：前者可被提示注入伪造，后者无法表达每轮及
A2A 原始用户变化。修复必须保持 inbound.db 由 Host 单写、容器只读，且不能新增绕过
Backend Gateway 的业务路径。

## Options Considered

- **Option A：信任工具参数中的 userId/requesterSource**。改动最小，但直接削弱身份信任链，
  被拒绝。
- **Option B：容器启动时把用户身份写入环境变量**。跨进程可见，但 Session 可承载多轮、
  多用户和 A2A 来源，静态值会过期或错绑。
- **Option C：用本轮 processing message ID 定位 Host 入站行并重建身份**。沿用
  ADR-0048 已验证的跨进程 DB 锚点，身份仍只来自 Host 写入字段；缺失或混合批次可
  Fail Closed。
- **Option D：本轮同时扩展 Host 代签代理，用 session owner 强制覆盖 requester**。
  Host 权威性更强，但 owner-less/shared Session 与 A2A 语义需要单独设计，超出本次缺陷
  的最小修复范围。

## Decision

> **拍板**：选 Option C。

MCP 子进程先读取 outbound.db 中状态为 `processing` 的 message ID，再用参数化查询读取
inbound.db 的对应 Host 行，按现有 `resolveBatchIdentity()` 规则重建身份。只有全部 marker
都存在、同批无可信身份/路由冲突、且结果为非空 `source="session"` 时，Gateway 请求才携带
可信 Session 身份；否则继续使用 `agent-asserted`，由写入策略拒绝。

父进程内调用仍优先使用已固定的 `RequestIdentity`，保证现有行为不变。

## Consequences

- **Positive**：真实独立 MCP 进程可保留 A2A `origin_user_id`；模型自报 userId 不能覆盖；
  现有 Gateway Create 写门恢复可用。
- **Negative**：该桥接依赖工具调用发生在本轮 processing marker 有效期内；detached 和
  scheduled 调用没有可信用户时仍按 `agent-asserted` 处理。
- **Trade-off**：outbound marker 由容器写，但它只选择同一 Session 内 Host 已写入的行，
  不能制造新的 userId/origin；Host 代理对 requester 的更强交叉校验留给独立变更。

## Implementation Notes

- `container/agent-runner/src/mcp-tools/gateway.ts`
- `container/agent-runner/src/mcp-tools/gateway.test.ts`
- 回归覆盖独立子进程形状、A2A origin、伪造工具参数、缺失行和混合用户 Fail Closed。
- 依赖 ADR-0017（origin 交叉验证）和 ADR-0048（processing_ack 跨进程锚点）。

## References

- `openspec/changes/enable-feishu-bitable-read-create/`
- `docs/decisions/ADR-0017-identity-origin-crossvalidation.md`
- `docs/decisions/ADR-0048-stable-gateway-idempotency-key.md`

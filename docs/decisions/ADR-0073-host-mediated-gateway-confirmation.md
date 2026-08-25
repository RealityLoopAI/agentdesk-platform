# ADR-0073: Host-mediated Gateway 确认签发

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: RealityLoop；Codex（提案与执行）
- **Tags**: `gateway`, `confirmation`, `identity-trust-chain`, `interactive`, `feishu`, `fail-closed`

---

## Context

飞书多维表格试点已经支持安全读取和单条新增，但发布单条 Update
需要证明“用户看到并确认的目标与字段差异”就是 Gateway 最终执行的修改。现有
Adapter 内部 `issueConfirmation()` 没有可信用户交互入口；如果把它直接暴露为
Agent Tool，容器可以自行声称用户已确认。只依赖 Prompt 中的确认文字同样无法绑定
规范用户、目标记录、Patch 或预览时版本。

实现还必须保持以下约束：

- 请求者身份来自 Host 写入的 Session/Inbound 信任链，不信任容器自报字段。
- Backend Gateway 仍是业务授权、确认绑定和写入的唯一入口。
- Central DB 只由 Host 写，容器只通过既有 Outbound 协议提交交互意图。
- 飞书群聊不能让另一成员确认原请求者的写入。
- Gateway 未实现新增确认端点时必须 Fail Closed，不能退化为 Agent 自证确认。

## Options Considered

- **Option A：Agent/Prompt 直接传 `confirmed=true`**。改动最少，但字段可由容器伪造，
  无法证明确认者、展示内容和执行内容一致，拒绝。
- **Option B：Host 直接持有 Gateway 业务确认密钥并签 Token**。可以信任用户交互，
  但在 Host 引入第二套业务授权秘密与逻辑，削弱 Gateway 唯一路径，拒绝。
- **Option C：Host 收集可信用户确认，Gateway 签发绑定 Token**。Host 只负责身份与
  交互，Gateway 验证自身生成的 opaque Preview Request 并签发业务凭据，职责边界清晰。

## Decision

> **拍板**：选 Option C。

1. Update dry-run 由 Gateway 读取当前记录并返回字段级 Diff、稳定 Record
   Fingerprint、Binding Hash、到期时间和 opaque `confirmationRequest`。完整单元格明文
   不进入确认 Token 或审计。
2. Runner 的 `gateway_request_confirmation` 只把 opaque Request 与 Gateway 原始展示
   数据写入 Outbound；它不能声明可信用户、Operation、Resource 或 Binding。
3. Host 从 Session 和 Host 写入的入站记录重新解析规范用户，创建 Central DB Pending，
   绑定 Session、用户、Agent Group、来源路由、Preview、过期时间和状态。Host 是该表的
   唯一写者。
4. 飞书按钮、飞书文本确认和 Web 确认每次都重新解析 Actor；只有 Pending 绑定的原请求者
   可以完成确认。
5. 确认后 Host 通过 ADR-0034 的签名代理信任边界调用可选
   `POST /confirmation/issue`。Gateway 验证 opaque Request、规范用户、Agent Group 和
   有效期后签发短期一次性 Token。
6. Token 绑定规范用户、Agent Group、Operation、逻辑 Resource、`recordId`、Patch Hash、
   预览 Fingerprint、`exp` 和 Nonce。Nonce 只能被同一幂等绑定重放；不同绑定或幂等键复用
   必须拒绝。
7. 旧 Gateway 对 `/confirmation/issue` 返回 404、签名失败、Pending 过期或 Host 重启后
   状态无法恢复时，Update 保持 Fail Closed。不得回退到对话确认或 Adapter 本地签发。

Create 在本轮复用同一 Host Pending 的“原请求者确认”能力，但低风险 Create 暂不要求
Gateway Update Token。Delete 和 Batch 继续不发布。

## Consequences

- **Positive**：确认者、展示 Diff 和最终 Update 形成机器可验证绑定；A2A 后仍保留原始
  规范用户；飞书群聊跨用户确认结构性失败。
- **Positive**：Gateway 继续拥有业务授权和确认凭据，Host 不形成平行业务授权路径。
- **Negative**：新增 Pending 迁移、Runner 工具、Host 交互处理和 Gateway 端点，写入路径
  对 Host/Gateway 可用性更敏感。
- **Negative**：参考 Gateway 的 Nonce 与确认状态仍是进程内存，不代表生产级持久化。
- **Trade-off**：Provider 没有条件 Update 时，重读 Fingerprint 到写入之间仍有 TOCTOU
  窗口；生产 Adapter 应使用 ETag、版本条件或业务事务。

## Implementation Notes

- Wire Schema：`container/agent-runner/src/mcp-tools/gateway-contract.ts`
- Runner 工具：`container/agent-runner/src/mcp-tools/gateway-confirmation.ts`
- Host Pending 与迁移：`src/db/gateway-confirmations.ts`、
  `src/db/migrations/044-gateway-confirmations.ts`
- Host 确认 Broker：`src/modules/gateway-confirmation/`
- Host 签发代理：`src/gateway-signing-proxy.ts`
- 参考实现：`examples/reference-gateway/feishu-bitable-adapter.mjs`
- 试点 Worker：`examples/bitable-pilot/`
- 必测负向场景：跨用户、过期、重复点击、Host 重启、Gateway 404、签名失败、伪造 Preview、
  Token 换目标/Patch、Fingerprint 冲突。

## References

- ADR-0017：A2A 请求者身份交叉校验
- ADR-0034：Host 侧 Gateway 签名凭证代理
- OpenSpec：`enable-feishu-bitable-record-query-create-update`

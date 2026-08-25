# ADR-0078: Runner 私有保存 Bitable 确认预览

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: RealityLoop；Codex（故障分析与执行）
- **Tags**: `gateway`, `confirmation`, `agent-runner`, `llm-boundary`, `feishu`, `fail-closed`

---

## Context

真实飞书 P2P Update 验收中，Gateway 正确生成的 opaque `confirmationRequest`
经过 OpenAI-compatible 外部模型复制后仍可解析出 Payload，但 HMAC 签名已被改写。
Host 把该值提交给 `/confirmation/issue` 时得到 `CONFIRMATION_REQUIRED`，因此用户已经
批准的修改仍无法执行。

`confirmationRequest` 是 Gateway 签发的短期 bearer capability。让模型读取并逐字回传
既没有业务价值，也把正确性建立在模型的字符串保真能力上。修复还必须保留：

- Gateway 是业务确认与授权的唯一签发者；
- Host 只能向原请求者收集确认；
- 模型不能自行构造或修改用户看到的 Preview；
- 不引入跨 Session 的共享确认状态；
- 缺失、过期或展示内容漂移时继续 Fail Closed。

## Options Considered

- **Option A：继续要求模型逐字复制 opaque Request**。无需代码改动，但真实验收已经证明
  模型可能改写签名，不能作为可靠协议。
- **Option B：把 opaque Request 放入 Prompt，并通过更强提示或编码要求保真**。降低部分
  误改概率，但仍把 bearer capability 暴露给模型，且无法提供机器保证。
- **Option C：Runner 私有保存完整 Preview，只向模型返回去掉 opaque Request 的展示
  Preview**。确认时按 Binding Hash 查找缓存，并逐字段比较模型提交的展示内容，匹配后才
  把原始完整 Preview 写入 Host Outbound。
- **Option D：Host 在 dry-run 时直接调用 Gateway 并持有 Preview**。可以完全绕过模型，
  但新增 Host 业务调用路径并改变现有 Gateway Tool 边界，工作量和契约变化更大。

## Decision

> **拍板**：选 Option C。

1. Runner 在成功解析 Update/Delete dry-run 响应后，严格验证完整 Gateway Preview，
   将其保存在当前 MCP 进程内的有界 TTL Cache。
2. 返回模型前删除 `confirmationRequest`；模型只看到 Record、Diff/字段摘要、Fingerprint、
   Binding Hash、到期时间和审计 ID。
3. `gateway_request_confirmation` 只接受模型可见 Preview。它使用
   `kind + bindingHash` 定位缓存，并比较除 opaque Request 外的全部展示字段。
4. 缓存缺失、过期、Schema 非法或任一展示字段不同都拒绝确认，要求重新 dry-run。
5. 匹配后 Runner 把缓存中的原始完整 Preview 写入 Host Outbound；模型从未读取或重复
   opaque Request。

## Consequences

- **Positive**：模型无法再意外损坏或主动替换 Gateway 签名；真实确认不依赖 LLM 字符串保真。
- **Positive**：opaque bearer capability 不再进入外部模型上下文，缩小了能力暴露面。
- **Positive**：Host/Gateway 的原请求者、Preview、Fingerprint 和 Token 绑定保持不变。
- **Negative**：Runner MCP 进程重启会丢失尚未确认的 Preview，用户需要重新 dry-run。
- **Negative**：缓存只适用于单 Session 的即时交互，不是生产级持久化确认队列。
- **Trade-off**：每个 MCP 进程最多保存 32 个未过期 Preview；超出时淘汰最旧项，宁可要求
  重新预览也不跨 Session 或无限保留业务数据。

## Implementation Notes

- 私有缓存：`container/agent-runner/src/mcp-tools/gateway-confirmation-preview-cache.ts`
- Gateway 响应去敏：`container/agent-runner/src/mcp-tools/gateway.ts`
- 确认解析：`container/agent-runner/src/mcp-tools/gateway-confirmation.ts`
- 展示 Schema：`container/agent-runner/src/mcp-tools/feishu-bitable-contract.ts`
- 必测场景：签名不进入模型结果、缓存命中恢复原始值、缓存缺失、展示字段漂移、过期与非法
  Preview 均 Fail Closed。

## References

- ADR-0034：Host 侧 Gateway 签名凭证代理
- ADR-0073：Host-mediated Gateway 确认签发
- ADR-0075：Gateway-owned Bitable Delete 确认与核验
- OpenSpec：`enable-feishu-bitable-real-record-crud`

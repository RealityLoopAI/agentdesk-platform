# ADR-0081: 用相关键连接确认卡投递事件与设备语音回执

- **Status**: Superseded by ADR-0083
- **Date**: 2026-07-30
- **Decider(s)**: 小环实验链路运营者；coding agent（提案、执行、验证）
- **Tags**: `gateway-confirmation`, `xiaohuan`, `tts`, `correlation`, `host-runtime`, `examples`
- **Supersedes**: 无
- **Superseded by**: ADR-0083

---

## Context

小环 Bridge 已能把实时语音结构化为实验 JSON，并经 Frontdesk、Bitable Worker 和
Host-mediated confirmation 生成飞书 Create 确认卡。操作者要求在确认卡真正弹出时，
通过设备局域网离线 TTS HTTP 接口播报“收到”。

已知约束：

- 平台核心不得硬编码小环地址、实验业务字段或播报文本。
- “已播报”不是批准、授权或写表证据，TTS 故障不得改变确认状态。
- Bridge 与确认请求跨越 Agent/容器边界；仅凭相同字段或用户查询中央 DB 会形成脆弱耦合。
- 硬件用 `request_id` 做进程内幂等，播放期间会短暂停止麦克风和 RTP。

## Options Considered

- **Option A：Bridge 入站成功后立即播报。** 改动最小，但只能证明消息已路由，不能证明确认卡已投递，语义早于用户要求。
- **Option B：Bridge 轮询中央确认表并按字段匹配。** 不改容器协议，但把 operator 示例耦合到中央 DB Schema；相同字段并发时无法可靠区分。
- **Option C：Create 确认携带相关键，Host 在卡片投递成功后发通用进程内事件。** 需要加性扩展 container→host 协议，但能精确表达时序，核心保持业务无关。

## Decision

> **拍板**：选 Option C。

Create confirmation preview 增加可选、最长 128 字符的 `correlationId`。它只用于
观察性关联，不参与用户解析、授权、确认、Gateway 输入或审计判定。Host 仅在渠道适配器
成功接收确认卡后发出通用 `GatewayConfirmationDeliveredEvent`。

Bridge 在内存中登记本轮 request fingerprint，并要求事件的 correlation ID、可信用户、
飞书 P2P 路由和逻辑资源完全匹配。匹配项在 TTS I/O 前原子消费，并用
`xiaohuan-confirm-<fingerprint>` 作为硬件请求 ID。

## Consequences

- **Positive**: 语音回执与“卡片已成功投递”对齐；无需查询中央 DB；其他确认调用完全兼容。
- **Positive**: 核心只增加业务无关事件，设备地址、文本和 HTTP 客户端仍在 `examples/`。
- **Negative**: Bridge 流程依赖 Worker 原样透传相关键；LLM 未遵循时只是不播报，不影响确认安全。
- **Negative**: 事件是进程内、非持久化观察面；Host 在投递后立即崩溃可能丢失回执。
- **Neutral / Trade-offs**: 监听器错误被隔离，不能让已投递卡片进入重试；因此 TTS 不自动重试，依赖设备 request ID 和下一次真实流程验证。

## Implementation Notes

- 通用事件：`src/modules/gateway-confirmation/events.ts`
- Host 发出事件：`src/modules/gateway-confirmation/index.ts`
- Runner 相关键协议：`container/agent-runner/src/mcp-tools/gateway-confirmation.ts`
- Bridge 登记与匹配：`examples/xiaohuan-bitable-bridge/adapter.ts`
- TTS 客户端：`examples/xiaohuan-bitable-bridge/tts-ack.ts`
- 相关上游：ADR-0063、ADR-0073、ADR-0077、ADR-0078
- 验收：无相关键/不匹配/重复事件不调用硬件；HTTP 202 且 request ID 相同才记为受理。

## References

- `TTS_HTTP_API.md`（硬件同事提供的 133 离线语音播报 HTTP 接口）
- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`

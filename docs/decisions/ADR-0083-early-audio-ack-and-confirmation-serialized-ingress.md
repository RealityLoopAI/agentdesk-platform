# ADR-0083: 完整 WAV 立即回执并按确认生命周期串行投递语音草稿

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 小环实验链路运营者；coding agent（提案、执行、验证）
- **Tags**: `xiaohuan`, `tts`, `gateway-confirmation`, `queue`, `vad`, `host-runtime`, `examples`
- **Supersedes**: ADR-0081
- **Superseded by**: 无

---

## Context

真实联调发现两个相关但不同的时序问题：设备“收到”要等方舟转写、Agent 处理和确认卡
投递后才播放，反馈过慢；同时 Bridge 仅串行等待 `onInboundEvent` 返回，后续语句仍会
在上一条等待用户确认时启动新的 Agent turn，导致上一条批准响应无法按预期继续写表。

已知约束：

- “收到”只能表示本机已完整接收一句音频，不能表示转写、确认或写入成功。
- Bridge 不得绕过 Host/Gateway 确认、身份链或直接写 Bitable。
- 实时监听可以继续切句和处理模型，但同一确认会话不能同时存在多个 Bridge 草稿。
- 队列和等待必须有界；辅助事件或 TTS 失败不能改变授权状态。

## Options Considered

- **Option A：暂停整个 RTP/VAD/方舟管线直到确认结束。** 状态简单，但确认期间会丢失用户已说出的音频，也无法利用模型处理时间。
- **Option B：继续并发投递所有 Agent turn，只在提示词要求排队。** 不需要 Host 事件，但提示词无法提供可靠的进程级互斥，已被真实联调否定。
- **Option C：WAV 就绪即异步回执，模型可继续；Bridge 在 Agent 入站边界按 Host 确认终态事件单飞。** 保留音频接收能力，并在确定的本地边界阻止确认抢占。

## Decision

> **拍板**：选 Option C。

VAD 在 WAV 已写入并通过格式、大小和时长校验后、调用方舟处理器前发出
`onWavReady`。Bridge 用本次运行 nonce 和 capture ID 的 SHA-256 派生
`xiaohuan-received-<receiptKey>`，异步请求设备播报“收到”，不等待 TTS 网络结果再
启动方舟。

Bridge 在 Host 入站前标记一个 active draft，后续结构化结果进入容量不超过 VAD
`maxQueue` 的 FIFO。已有 `GatewayConfirmationDeliveredEvent` 只负责把 request
fingerprint 绑定到 Host confirmation ID；新增通用
`GatewayConfirmationResolvedEvent` 在批准、拒绝、过期或失败时发出。只有匹配的
confirmation ID、规范用户和 P2P 路由才能释放下一条。15 分钟未形成完整确认生命周期
时按超时释放，队列溢出则丢弃新草稿并记录安全错误。

## Consequences

- **Positive**: 用户在本机确认拿到完整音频后立即听到反馈，不再受方舟或 Agent 延迟影响。
- **Positive**: 后续语句可以继续完成音频和模型处理，但不会抢占当前确认。
- **Positive**: 核心事件保持业务无关且只读，不改变身份、授权、确认或 Gateway 执行路径。
- **Negative**: 等待确认时结构化结果占用有界内存；长时间不确认会触发队列溢出并丢弃新草稿。
- **Negative**: active draft 若在确认卡之前失败，只能依赖 15 分钟保护超时释放；当前没有通用 Agent turn 终态事件。
- **Neutral / Trade-offs**: 批准终态释放下一条时，上一条 Worker 可能仍在执行 Create/Get；Host 会话消息串行性负责保持顺序，本 ADR 不把“收到”或队列释放解释为写入完成。

## Implementation Notes

- WAV 就绪回调：`examples/xiaohuan-doubao-audio/vad-listening-service.ts`
- 早期 TTS 与单飞队列：`examples/xiaohuan-bitable-bridge/adapter.ts`
- TTS receipt key：`examples/xiaohuan-bitable-bridge/tts-ack.ts`
- 通用确认终态事件：`src/modules/gateway-confirmation/events.ts`
- Host 发出终态：`src/modules/gateway-confirmation/index.ts`
- 相关上游：ADR-0073、ADR-0077、ADR-0081、ADR-0082
- 验收：WAV ready 先于方舟处理；第二条在匹配终态前零 Agent 入站；无关事件不释放；TTS 失败不影响后续链路。

## References

- `TTS_HTTP_API.md`
- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`

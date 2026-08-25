# ADR-0074: 用方舟原生音频模型单阶段提取 WAV 实验信息

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 产品/项目负责人，Codex（验证与执行）
- **Tags**: `doubao`, `ark`, `multimodal`, `audio`, `structured-output`, `examples`
- **Supersedes**: ADR-0072
- **Superseded by**: 无

---

## Context

ADR-0072 选择豆包语音 ASR → 方舟文本模型两阶段方案。真实凭证验证发现运营方只有方舟 API Key；该 Key 调用语音产品 endpoint 会返回 `45000010 Invalid X-Api-Key`，但可以调用方舟 `doubao-seed-2-0-lite-260428`。

Capability spike 进一步证明 Responses API 接受本地 WAV data URI，内容形状为 `{type:"input_audio", audio_url:"data:audio/wav;base64,..."}`。继续坚持两阶段将要求额外申请、分发和运维另一套凭证，并使现有试点无法真实运行。

## Options Considered

- **Option A：保留 ADR-0072 两阶段方案。** 转写和提取故障可独立定位，但需要当前不存在的语音产品凭证，并固定产生两次调用。
- **Option B：方舟原生音频模型单阶段返回 transcript + JSON。** 与现有 Key 匹配，只需一次调用；缺点是转写和提取共享故障边界。
- **Option C：同时保留两条运行路径并自动回退。** 兼容面最大，但凭证、费用、错误语义和测试组合翻倍，且自动回退可能产生不可解释的重复费用。

## Decision

> **拍板**：选择 Option B，拒绝自动回退。

operator-specific 示例固定使用一次方舟 Responses API 调用。默认模型为已实测支持音频的 `doubao-seed-2-0-lite-260428`。请求携带完整 `experiment-audio.v1` Schema，响应由本地再次校验。

平台核心、通用 Provider、DB、Gateway 和飞书通道保持不变。未来业务持久化仍必须通过 Backend Gateway。

## Consequences

- **Positive**：一枚现有 Key 即可运行；减少一次网络调用、一个凭证域和中间状态；没有自动回退产生的重复费用。
- **Negative**：ASR 与提取质量无法独立归因；模型输出无效时整次调用失败。
- **Neutral / Trade-offs**：结果仍保留 transcript 供人工核对；本轮只验证结构，不做实验业务正确性校验。

## Implementation Notes

- 示例：`examples/xiaohuan-doubao-audio/`
- 请求：`POST <DOUBAO_ARK_BASE_URL>/responses`
- 模型：`doubao-seed-2-0-lite-260428`
- 音频：`input_audio.audio_url` data URI
- OpenSpec：`openspec/changes/add-xiaohuan-doubao-wav-experiment-extraction/`
- ADR-0072 标记为 `Superseded by ADR-0074`。

## References

- 火山方舟 Responses API capability spike，2026-07-30
- `openspec/changes/add-xiaohuan-doubao-wav-experiment-extraction/design.md`

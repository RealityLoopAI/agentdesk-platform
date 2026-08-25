# ADR-0085: 将语音摘要显式同步到固定飞书私聊

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 小环实验链路运营者；coding agent（提案、执行、验证）
- **Tags**: `xiaohuan`, `feishu`, `voice`, `privacy`, `host-runtime`, `examples`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

Bridge 把完整结构化 envelope 作为可信 Host 入站写入飞书来源的 Conversation
Lane。Web 直接读取该入站行，因此能显示 `displayText`；真实飞书私聊中没有对应的
用户消息，只有后续 Agent 回复和确认卡。运营者要求飞书与 Web 都立即出现本次语音
文本，同时不能把完整 JSON、物理表标识或新凭证发送到飞书。

目标必须继续由 operator 配置固定，不能由 transcript、模型输出或 envelope 覆盖。
摘要同步失败也不能被误解为授权失败或改变确认、Gateway 执行结果。

## Options Considered

- **Option A：仅保留 Web 入站展示。** 无额外出站，但无法满足飞书端同步需求。
- **Option B：让 Agent 在提示词中复述 transcript。** 受模型行为和处理延迟影响，
  还可能改写文本，不能保证与 Web 一致。
- **Option C：Bridge 通过 Host 已初始化的飞书适配器向固定 P2P 投递相同摘要。**
  不新增凭证，目标不可由语音控制，且与 Agent/Gateway 业务执行解耦。

## Decision

> **拍板**：选 Option C，并使用默认关闭的显式配置开关。

开启 `XIAOHUAN_BITABLE_FEISHU_TRANSCRIPT_MIRROR_ENABLED=true` 后，Bridge 在
Host 入站成功后投递 `语音指令：<transcript>`。完整 envelope 仍只供 Agent 使用。
投递只指向已经通过启动校验的 `XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID`。

## Consequences

- **Positive**: Web 和飞书立即显示同一份语音摘要，便于现场核对识别结果。
- **Positive**: 不新增飞书凭证、物理资源标识或 Gateway 旁路。
- **Negative**: 飞书 API 瞬时失败时本轮摘要可能缺失；失败会产生结构化日志，但不
  阻断后续确认流程。
- **Neutral / Trade-offs**: 摘要属于新的外部披露面，因此默认关闭，由运营者对每个
  部署显式开启。

## Implementation Notes

- 配置：`examples/xiaohuan-bitable-bridge/config.ts`
- 投递：`examples/xiaohuan-bitable-bridge/adapter.ts`
- 运营说明：`examples/xiaohuan-bitable-bridge/README.md`
- 验收：飞书只收到精简摘要；Web 仍显示摘要；Agent 仍收到完整 envelope；失败不
  释放或批准草稿。

## References

- ADR-0083
- ADR-0084
- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`

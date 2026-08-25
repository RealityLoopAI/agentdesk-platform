# ADR-0082: 以原始证据和实时表 Schema 约束语音字段归一化

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（需求与边界确认），Codex（提案与执行）
- **Tags**: `xiaohuan`, `bitable`, `asr`, `normalization`, `agent`, `idempotency`, `examples`

---

## Context

真实小环录音被方舟转写为“批次测试四号，使用列路测试，无水氯化铜五克”。
transcript 保留了批次事实，但结构化 `sampleIds` 为空；设备值“列路测试”与实时
单选项“链路测试”仅有常见 ASR 同音字差异。原 Bridge 把结构化字段当最终事实，
并要求 Worker 逐字验证，因此整句在确认卡之前失败。

已知约束：

- Field List 是字段类型和单选 options 的唯一真相源，Bridge 不得复制表 Schema。
- Bridge 不得直连 Gateway 或飞书 Bitable，写入仍需原用户确认。
- 原始 transcript 必须保留；数字、单位和新字段不得由模型猜测。
- 同一句重放必须保持稳定幂等，归一化漂移不得造成双写。

## Options Considered

- **Option A：继续严格逐字匹配。** 确定性最好，但真实中文 ASR 的同音字和结构化漏提取会让大量有效输入在确认前丢失。
- **Option B：让 Bitable Worker 在实时 Field List 内做证据约束归一化。** 不新增模型调用或 Schema 副本，可利用 transcript、结构化结果和真实 options；需要明确禁止猜测和歧义选择。
- **Option C：Bridge 再调用一次模型并配置候选词表。** 行为更集中，但增加延迟和费用，复制实时表 options，Schema 漂移时仍可能输出过期值。

## Decision

> **拍板**：选 Option B。

Bridge envelope 改为携带目标字段锁定的 `fieldMapping` 和 best-effort partial
`fields`。空数组、未解析 selector 或空值仅省略初步字段，不再丢弃包含 transcript
证据的整句话。

Worker 必须先取得实时 Field List；只可为 `fieldMapping` 声明的目标字段：

- 从明确字段标记后的单一连续文本恢复漏提取值；
- 在语音上下文只支持一个 live option 时，把同音/近音 ASR 文本归一到该 exact option；
- 使用 transcript 或 measurement 中明确出现的数字和单位。

多候选、证据冲突或缺少数值证据时停止并澄清。最终字段仍由原用户确认。
fingerprint 改为绑定 capture、resource、transcript、experiment 和 fieldMapping；
若同一来源重试得到不同最终字段，Gateway 的幂等输入冲突检查失败关闭。

## Consequences

- **Positive**: “列路测试”及结构化漏掉“测试四号”这类输入能进入确认链路，而不是在 Bridge/Worker 前置校验中丢失。
- **Positive**: 使用实时 Field List，无需把表格 options 复制进 Bridge 配置，也不增加第二次方舟调用。
- **Negative**: 归一化质量依赖 Worker 模型；必须依靠原始证据、歧义停止和人工确认共同控制风险。
- **Neutral / Trade-offs**: partial fields 不再是最终字段；消费 `xiaohuan-bitable-bridge.v1` 的提示约束和测试必须同步更新。

## Implementation Notes

- `examples/xiaohuan-bitable-bridge/mapper.ts`
- `examples/xiaohuan-bitable-bridge/envelope.ts`
- `examples/xiaohuan-bitable-bridge/adapter.ts`
- `examples/bitable-pilot/agent-group/CLAUDE.local.md`
- `groups/agentdesk-bitable-worker/CLAUDE.local.md`
- `examples/lab-frontdesk/CLAUDE.local.md`
- `scripts/xiaohuan-bitable-bridge-*.test.ts`

验收必须包含真实失败 transcript、空 partial fields 仍投递、指纹稳定性、Worker
唯一 option 纠正边界和缺失数字/歧义失败关闭。

## References

- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`
- ADR-0081（确认卡投递相关键与设备 TTS 回执）

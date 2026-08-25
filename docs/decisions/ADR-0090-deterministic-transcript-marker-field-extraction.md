# ADR-0090: 用配置化 transcript 标记选择器补齐关键语音字段

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（要求修复批次漏提取），Codex（设计与执行）
- **Tags**: `xiaohuan`, `bitable`, `audio`, `normalization`, `deterministic-mapping`, `examples`

---

## Context

真实小环语音被方舟忠实转写为“批次测试十号，使用链路测试设备，无水氯化铜四克”，
但 Schema 合法的结构化结果仍返回空 `sampleIds`。原设计允许 Bitable Worker 从
transcript 恢复“测试十号”，但这使一个语法边界明确的关键字段依赖第二个模型 turn；
当 Frontdesk 委派异常时，批次恢复也随之消失。

已知约束：

- Bridge 只能生成运行时映射声明的目标字段，不能硬编码具体表结构。
- 原始 transcript 是可信度有限但必须保留的证据；不得做模糊匹配或自由文本重抽取。
- 零命中、多命中和超长值必须失败关闭。
- 实时 Field List、原用户确认和 Gateway 仍是最终写入边界。

## Options Considered

- **Option A：只增强方舟 prompt。** 改动最小，但模型仍可能返回 Schema 合法的空数组，无法提供确定性保证。
- **Option B：继续完全依赖 Worker 补偿。** 已有提示规则，但增加上下文、委派和第二次模型推理依赖。
- **Option C：增加配置化 `text-after-marker` 选择器。** 对显式 marker 后的有界短语做机械提取；需要扩展字段映射契约和测试。

## Decision

> **拍板**：选 Option C，并同时采用 Option A 作为上游质量增强。

`text-after-marker` 只允许配置在 `transcript` 源路径，接受 1–8 个唯一、有界的精确
marker。它从唯一 marker 后读取到下一个中英文句读符或 transcript 末尾，去除首尾空白
后作为候选值。零命中、多命中或空短语在 candidate mapper 中省略，在 complete mapper
中失败关闭。

最长 marker 在同一位置优先，使 `["批次", "批次为"]` 可确定性解析“批次为测试十二号”。
选择器不做同音纠正、别名翻译、单位换算或第一项选择。方舟 prompt 另行明确
“批次测试十号”不得从 `sampleIds` 漏掉，但 Bridge 不把该模型行为当可靠性前提。

## Consequences

- **Positive**: 即使方舟返回空 `sampleIds`，“批次测试十号”也能稳定生成 `批次: "测试十号"`。
- **Positive**: 规则由部署字段映射声明，不把“批次”或目标表字段硬编码到平台核心。
- **Negative**: 自然语言没有句读且 marker 后还包含其他事实时，结果可能过宽；运营者应选择更具体 marker，最终仍由字段校验和确认卡把关。
- **Neutral / Trade-offs**: 多次出现 marker 时不合并也不选第一项，必须进入澄清或后续补偿路径。

## Implementation Notes

- `examples/xiaohuan-bitable-bridge/mapper.ts`
- `examples/xiaohuan-doubao-audio/ark-multimodal.ts`
- `examples/xiaohuan-bitable-bridge/.env.example`
- `examples/xiaohuan-bitable-bridge/README.md`
- `scripts/xiaohuan-bitable-bridge-config.test.ts`
- `scripts/xiaohuan-doubao-audio.test.ts`

验收句式为“批次测试十号，使用链路测试设备，无水氯化铜四克”，且结构化
`sampleIds` 人为设为空；候选字段必须仍包含批次、设备和测量三项。

## References

- ADR-0082（证据约束的语音字段归一化）
- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`

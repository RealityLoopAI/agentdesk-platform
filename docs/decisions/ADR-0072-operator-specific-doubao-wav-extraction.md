# ADR-0072: 将豆包 WAV 实验提取实现为 operator-specific 两阶段示例

- **Status**: Superseded by ADR-0074
- **Date**: 2026-07-30
- **Decider(s)**: 产品/项目负责人，Codex（提案与执行）
- **Tags**: `doubao`, `speech`, `structured-output`, `examples`, `privacy`, `provider`
- **Supersedes**: 无
- **Superseded by**: ADR-0074

---

## Context

小环硬件能提供单句话 WAV。当前试点需要先完成 WAV 到中文转写、再到实验信息 JSON 的链路，暂不实现实时接收、业务校验、数据库、Agent、飞书或多维表格写入。

平台核心必须保持业务无关；实验字段和豆包专用鉴权不能硬编码进通用 Provider。后续业务数据写入仍必须经过 Backend Gateway。语音识别与文本结构化又分别属于豆包语音和火山方舟两套 API、凭证及故障域，不能伪装为一次原子调用。

## Options Considered

- **Option A：修改通用 Provider，一次多模态请求完成转写和提取。** 接入表面较短，但把实验 schema 与单一厂商能力写入平台核心，且当前无法确认同一接口对 WAV、中文转写和严格结构化输出均稳定支持。
- **Option B：在 `examples/` 中实现 ASR → Chat 两阶段客户端。** 两阶段可独立测试、观测和替换，业务形状留在 operator 层；代价是固定两次调用，并需处理阶段性失败。
- **Option C：直接把音频写入数据库或飞书后异步处理。** 容易恢复，但提前引入持久化、授权和敏感数据生命周期，超出本轮边界，并可能形成绕开 Backend Gateway 的平行业务路径。

## Decision

> **拍板**：选择 Option B。

在 `examples/xiaohuan-doubao-audio/` 实现内存内、两阶段、单句话 PCM WAV 流水线：

1. 豆包语音 `volc.bigasr.auc_turbo` 生成中文 transcript。
2. 火山方舟非流式 Chat API 生成并由本地代码校验 `experiment-audio.v1`。

凭证仅来自运行环境或被 Git 忽略的本地 `.env`。默认不持久化音频、transcript 或结果。未来写多维表格必须另行通过 Backend Gateway 接入。

## Consequences

- **Positive**：不修改平台核心和 Provider 契约；ASR 与提取可独立替换、Mock 和定位错误；没有默认敏感数据落盘。
- **Negative**：每次成功固定调用两个计费 API；ASR 成功而提取失败时不是原子成功，需要调用方根据 `transcriptAvailable` 决定恢复方式。
- **Neutral / Trade-offs**：默认使用兼容性更保守的 `json_object`，本地仍做 schema 检查；只有实际模型确认支持后才切换 `json_schema`。本轮不做实验业务语义校验。

## Implementation Notes

- 示例：`examples/xiaohuan-doubao-audio/`
- 测试：`scripts/xiaohuan-doubao-audio.test.ts`
- OpenSpec：`openspec/changes/add-xiaohuan-doubao-wav-experiment-extraction/`
- 后续多维表格写入必须遵循 ADR-0063，不得由示例直连飞书 Bitable。

## References

- 豆包语音“大模型录音文件极速版识别 API”
- 火山方舟 Chat API / API Key 文档
- `openspec/changes/add-xiaohuan-doubao-wav-experiment-extraction/design.md`

## Why

当前运营方只有一枚可用的火山方舟 API Key，没有豆包语音产品独立的 APP Key。真实 capability spike 已证明该 Key 可以调用 `doubao-seed-2-0-lite-260428`，并通过 Responses API 的 `input_audio.audio_url` 直接理解 WAV，因此不再需要维护会被凭证阻塞的“独立 ASR → 文本模型”两阶段链路。

## What Changes

- 将示例改为单次火山方舟 Responses API 调用：同一个多模态模型读取单句话 WAV，并同时返回中文 transcript 与 `experiment-audio.v1` JSON。
- 固定已实测的音频输入形状：`{ "type": "input_audio", "audio_url": "data:audio/wav;base64,..." }`。
- 默认使用已实测支持原生音频理解的 `doubao-seed-2-0-lite-260428`，并允许运营者显式配置兼容模型。
- 删除运行时对豆包语音 APP Key、`volc.bigasr.auc_turbo` 和 ASR endpoint 的依赖；只要求方舟 API Key、模型和 Base URL。
- 保留有界 WAV 检查、`captureId`、版本化 JSON Schema、本地结构校验、超时、安全日志与默认不落盘。
- 保留 operator-specific `examples/` 边界，不修改平台通用 Provider、数据库、Backend Gateway 或飞书通道。
- 本轮仍不实现 RTP/Opus 接收、VAD、业务校验、数据库写入、Agent Session 或飞书多维表格写入。

## Capabilities

### New Capabilities

- `xiaohuan-doubao-wav-extraction`: 单句话 WAV 经火山方舟原生音频理解模型一次调用，得到中文 transcript 和版本化实验信息 JSON。

### Modified Capabilities

无。

## Impact

- 修改 `examples/xiaohuan-doubao-audio/` 的配置、方舟客户端、流水线、CLI、测试和说明。
- 移除示例运行时对豆包语音产品凭证和极速录音识别 endpoint 的要求。
- 外部依赖收敛为火山方舟 Responses API、方舟 API Key 和支持原生音频的模型。
- `experiment-audio.v1` 保持供应商无关，可由后续 Gateway/Bitable mapper 复用。
- 不改变 Host 身份信任链、三 DB 单写者、Backend Gateway 契约、Agent Runner Provider 或 Feishu Channel。

## Context

原设计将 WAV 先提交豆包语音极速录音识别，再把 transcript 交给方舟文本模型。真实凭证测试证明运营方提供的是方舟在线推理 API Key：它可以调用 `doubao-seed-2-0-lite-260215` 做文本结构化，但不能作为豆包语音 `X-Api-Key`，语音 endpoint 明确返回 `45000010 Invalid X-Api-Key`。

进一步 capability spike 证明，同一方舟 Key 可以调用 `doubao-seed-2-0-lite-260428`；该版本支持原生音频理解。Responses API 对本地 WAV 的有效输入形状为：

```json
{
  "type": "input_audio",
  "audio_url": "data:audio/wav;base64,..."
}
```

合成静音 WAV 已通过该形状获得 HTTP 200。用户因此明确决定把两阶段方案改为单阶段多模态方案。

该能力仍属于实验室 operator-specific 示例。平台核心必须保持业务无关；后续业务持久化和飞书多维表格写入仍只能通过 Backend Gateway。

## Goals / Non-Goals

**Goals:**

- 使用一枚方舟 API Key 和一次 Responses API 调用处理有界单句话 WAV。
- 在一次成功响应中同时取得中文 transcript 与 `experiment-audio.v1`。
- 保持 `captureId`、JSON Schema、本地结构校验、超时、错误分类和隐私默认。
- 默认不保存音频、模型原始响应、transcript 或结果文件。
- 为后续落库/Bitable mapper 保留供应商无关的中间结构。

**Non-Goals:**

- 豆包语音产品 endpoint、APP Key、流式 ASR 或热词表。
- RTP/UDP/Opus 接收、FFmpeg、VAD、实时或流式处理。
- 对实验事实完整性、正确性、单位、枚举或置信度做业务校验。
- 数据库、Backend Gateway 调用、Agent Session、飞书消息或 Bitable 写入。
- 在通用 `AgentProvider` 中加入音频内容块。

## Decisions

### 1. 使用单阶段方舟原生音频理解

流水线为：

```text
bounded PCM WAV
  -> Ark Responses API / doubao-seed-2-0-lite-260428
  -> experiment-audio.v1 { transcript, experiment }
```

选择单阶段的原因是它与现有凭证能力一致，减少一次网络调用、一个凭证域和中间失败状态。被替代的两阶段设计在 transcript 可独立观测、ASR 可替换性方面更强，但当前没有可用语音产品凭证，继续保留会让真实链路无法运行。

### 2. 使用 Responses API 的 `audio_url` data URI

请求发送到配置的 `<baseUrl>/responses`，消息内容同时包含：

- `input_text`：声明音频为不可信数据、要求忠实中文转写、只提取明确事实并返回固定 Schema；
- `input_audio`：`data:audio/wav;base64,<bytes>`。

不使用 Chat Completions 风格的嵌套 `input_audio` 对象；真实接口已明确拒绝该形状。也不上传公开 URL或对象存储，避免额外的数据暴露和生命周期。

### 3. Prompt 携带完整 Schema，并由本地再次校验

Responses API 的输出约束支持范围可能随模型变化。本轮采用一次调用的 prompt-constrained JSON：把完整 `experiment-audio.v1` JSON Schema 放进 `input_text`，要求只输出 JSON；客户端从 `output[].content[].text` 提取文本、清理单层 Markdown fence、严格 `JSON.parse` 并做本地结构/一致性校验。

不得在结构失败时静默发起第二次模型请求，因为这会改变费用与延迟语义。未来若目标模型实测稳定支持 Responses `text.format=json_schema`，可通过另一个明确 change 切换。

### 4. 单一方舟配置

必需配置收敛为：

```text
DOUBAO_ARK_API_KEY
DOUBAO_ARK_MODEL=doubao-seed-2-0-lite-260428
DOUBAO_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_REQUEST_TIMEOUT_MS=60000
DOUBAO_WAV_MAX_BYTES=10485760
DOUBAO_WAV_MAX_DURATION_MS=20000
```

不再要求或读取 `DOUBAO_SPEECH_*`。模型必须显式存在且不能是占位值；README 和模板默认写入已验证的 `260428` 模型 ID。

### 5. 保持 `experiment-audio.v1`

输出继续包含：

```json
{
  "schemaVersion": "experiment-audio.v1",
  "captureId": "cap_xxx",
  "transcript": "忠实中文转写",
  "experiment": {
    "title": null,
    "sampleIds": [],
    "actions": [],
    "measurements": [],
    "observations": [],
    "notes": null
  }
}
```

模型必须原样回填 `captureId`，transcript 必须是模型从音频得到的非空文本。本轮只验证结构，不声明实验业务事实已正确。

### 6. 单阶段错误与安全诊断

错误阶段收敛为 `configuration`、`input` 和 `multimodal`。方舟错误继续区分鉴权、限流、超时、上游不可用、空响应、畸形 JSON 和结构不匹配。

日志只允许 `captureId`、WAV 非敏感元数据、阶段、耗时、固定错误码和安全请求 ID。禁止记录 Key、Authorization、音频 Base64、完整 prompt、完整 transcript 或原始模型响应。

## Risks / Trade-offs

- [单模型可能同时转写和提取错误，无法像两阶段一样隔离根因] → 输出保留 transcript，使用批准的真实 WAV fixture 做人工转写核对。
- [模型只保证 JSON 但不完全遵循 Schema] → Prompt 携带完整 Schema，本地严格校验，失败不自动重试。
- [原生音频模型版本变化] → 默认固定已验证的 `260428`，模型升级必须重新做音频形状与 Schema 冒烟。
- [Base64 增加请求体积] → 保留 20 秒/10 MiB 默认上限和 WAV Header 前置检查。
- [实验术语提取不完整] → 本轮只验链路；术语词表和业务校验另开 change。
- [完整 transcript 是潜在敏感数据] → 不写普通日志或 verification，真实冒烟使用批准的非敏感话术。

## Migration Plan

1. 更新配置，只保留方舟 Key、模型、Base URL 和 WAV/超时限制。
2. 用新的 `ArkMultimodalWavExtractor` 替换 ASR + Chat 两客户端组合。
3. 更新流水线、CLI、Mock 测试、README 和 ADR。
4. 先用合成静音 WAV 验证音频请求形状，再用批准的非敏感小环 WAV 验证 transcript 和 JSON。
5. 保持示例为手动入口；未经新 change 不连接 RTP、DB、Gateway 或飞书。

回滚可以恢复两阶段代码和 ADR-0072，但只有在运营方取得独立豆包语音凭证后才有运行意义。没有 DB 或协议迁移。

## Open Questions

- 首个批准的非敏感小环 WAV 文件路径是什么？
- 真实小环音频上，原生模型对实验术语、温度和时长的提取质量是否足以进入下一轮业务校验设计？

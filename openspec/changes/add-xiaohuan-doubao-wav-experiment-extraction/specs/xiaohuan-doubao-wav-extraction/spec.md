## ADDED Requirements

### Requirement: 有界单句话 WAV 输入
示例流水线 SHALL 接受调用方提供的本地 PCM WAV 和非空 `captureId`，并在任何外部调用前拒绝不存在、为空、无法解析、超过配置大小或超过最长话语时长的输入。本轮 SHALL 不负责 RTP 接收、VAD 分句或自动转码。

#### Scenario: 接受合格 WAV
- **WHEN** 调用方提供存在、非空、可解析且处于大小和时长限制内的 PCM WAV
- **THEN** 流水线有界读取音频并进入方舟多模态阶段

#### Scenario: 拒绝不合格 WAV
- **WHEN** WAV 不存在、为空、无法解析、超过大小限制或超过最长时长
- **THEN** 流水线返回 `input` 错误且不调用方舟 API

### Requirement: 方舟单阶段音频理解
流水线 SHALL 使用一枚方舟 API Key 和支持原生音频的配置模型，通过一次 Responses API 请求同时处理 WAV 与提取指令。WAV SHALL 以 `input_audio.audio_url` data URI 提交，且同一次业务调用不得静默回退到第二个模型请求。

#### Scenario: 单次多模态调用成功
- **WHEN** 方舟接受 WAV 并返回完成响应
- **THEN** 一次上游调用产生同时包含中文 transcript 和实验信息的候选 JSON

#### Scenario: 方舟调用失败
- **WHEN** 方舟发生鉴权、限流、超时、请求格式或服务端错误
- **THEN** 流水线返回安全可分类的 `multimodal` 错误，不发起第二次模型调用

### Requirement: 版本化 transcript 与实验 JSON
流水线 SHALL 要求并校验 `experiment-audio.v1`，其根 SHALL 包含 `schemaVersion`、`captureId`、非空 `transcript` 和 `experiment`；`experiment` SHALL 提供 `title`、`sampleIds`、`actions`、`measurements`、`observations` 与 `notes`。本轮 SHALL 不判断实验业务字段是否完整或正确。

#### Scenario: 返回结构化结果
- **WHEN** 模型输出可解析且符合最小结构
- **THEN** 流水线返回 `experiment-audio.v1`，并确认 `captureId` 与本次调用一致

#### Scenario: 信息没有明确出现
- **WHEN** 音频没有明确提供某个实验字段
- **THEN** 结果使用 `null` 或空数组表达缺失，不得补造事实

#### Scenario: 模型输出无效
- **WHEN** 模型响应为空、不是 JSON、transcript 为空、capture ID 不一致或缺少必需结构
- **THEN** 流水线返回 `multimodal` 结构错误，不把候选内容报告为成功

### Requirement: 单一方舟凭证与隐私
示例 SHALL 只要求方舟 API Key、支持音频的模型和 HTTPS Base URL，不得要求豆包语音 APP Key。方舟 Key、Authorization、音频 Base64、完整 prompt、完整 transcript 和原始响应 SHALL 不进入仓库、普通日志或错误消息。

#### Scenario: 缺少方舟配置
- **WHEN** 方舟 Key 或模型缺失、为占位值，或 Base URL 不是 HTTPS
- **THEN** 流水线在读取或编码 WAV 前失败关闭

#### Scenario: 安全日志
- **WHEN** 流水线成功或失败
- **THEN** 日志只包含 capture ID、非敏感 WAV 元数据、阶段、耗时、固定错误码和安全请求 ID

### Requirement: 无业务副作用的 MVP
本轮示例 SHALL 只把最终 `experiment-audio.v1` 写到 CLI stdout，不得复制调用方 WAV、默认生成结果文件、创建 Agent Session、写平台数据库、调用 Backend Gateway、发送飞书消息或读写多维表格。

#### Scenario: 完整单阶段流水线成功
- **WHEN** WAV 理解和 JSON 提取成功
- **THEN** 调用方收到结构化结果，且平台数据库、Gateway 和飞书均无业务副作用

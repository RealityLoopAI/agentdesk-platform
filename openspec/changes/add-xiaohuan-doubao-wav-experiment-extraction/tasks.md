## 1. 决策、能力与基线

- [x] 1.1 运行原两阶段实现的类型检查、专项测试和全仓基线，并记录既有沙箱失败
- [x] 1.2 用运营方现有 Key 验证方舟 Responses API、`doubao-seed-2-0-lite-260428` 和 `input_audio.audio_url` data URI
- [x] 1.3 新增 ADR，明确单阶段方舟多模态方案 supersede ADR-0072 的两阶段选择，并更新决策索引

## 2. 配置与 WAV 复用

- [x] 2.1 保留有界 PCM WAV Header 解析、大小/时长限制和安全 capture ID
- [x] 2.2 将配置收敛为方舟 Key、音频模型、HTTPS Base URL、超时与 WAV 上限，删除运行时 `DOUBAO_SPEECH_*` 要求
- [x] 2.3 更新无秘密模板和 README，默认模型改为 `doubao-seed-2-0-lite-260428`

## 3. 单阶段多模态客户端

- [x] 3.1 实现 `ArkMultimodalWavExtractor`，向 `<baseUrl>/responses` 发送 `input_text` 和 WAV `input_audio.audio_url`
- [x] 3.2 Prompt 携带完整 `experiment-audio.v1` Schema，要求忠实中文 transcript、仅提取明确事实并只输出 JSON
- [x] 3.3 从 `output[].content[].text` 读取候选 JSON，支持单层 fence 清理并执行本地结构、capture ID 和非空 transcript 校验
- [x] 3.4 将鉴权、限流、超时、网络、空响应、畸形 JSON 和结构错误映射为固定 `multimodal` 分类
- [x] 3.5 确保一次 `processWav` 恰好一次模型调用，不自动重试或回退到 ASR/第二模型

## 4. 流水线与 CLI

- [x] 4.1 将 `processWav` 改为输入检查 → 单次方舟多模态调用 → `experiment-audio.v1`
- [x] 4.2 更新 CLI 和安全阶段日志，stdout 只写最终 JSON，stderr 不写 transcript、Base64、Prompt、原始响应或 Key
- [x] 4.3 删除或隔离旧 ASR/文本提取运行路径，证明核心平台、DB、Gateway、Feishu 和 Bitable 无新增依赖

## 5. 自动化验证

- [x] 5.1 添加 Responses API Mock 测试，覆盖 audio data URI、模型、Schema Prompt、成功中文 transcript 和实验 JSON
- [x] 5.2 覆盖配置缺失、输入拒绝、401/403、429、5xx、超时、空响应、畸形 JSON、错误 capture ID 和空 transcript
- [x] 5.3 添加隐私与范围守卫，证明日志/错误不泄漏 Key、Authorization、Base64、Prompt、原始响应或 transcript，且不落盘/不触碰平台业务路径
- [x] 5.4 运行示例类型检查、专项测试、平台 typecheck、相关不变量测试和 OpenSpec strict validation

## 6. 真实音频冒烟

- [x] 6.1 用合成静音 WAV 验证 `260428` 音频请求形状获得 HTTP 200，并只记录安全请求 ID 和耗时
- [ ] 6.2 获取批准的非敏感小环单句话 PCM WAV，记录格式、时长和文件位置但不提交音频
- [ ] 6.3 运行真实小环 WAV → `experiment-audio.v1`，人工核对中文 transcript，并记录耗时、模型和安全请求 ID
- [x] 6.4 在 `verification.md` 记录最终自动化与真实冒烟证据，不写 Key、Base64、完整 transcript 或原始模型响应

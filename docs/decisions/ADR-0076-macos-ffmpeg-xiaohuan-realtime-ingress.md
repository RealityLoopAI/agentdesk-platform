# ADR-0076: macOS 使用 FFmpeg 接收小环实时 RTP 音频

**状态**：Accepted
**日期**：2026-07-30

## 背景

ADR-0074 已验证完整 WAV 可以通过方舟单阶段得到 transcript 与实验 JSON，但小环实际持续发送 RTP/UDP Opus。硬件提供的 macOS SDP 指向 `192.168.66.113:50020`；平台需要一个 operator-specific 接收层，而不是把设备协议写入通用 channel 或 provider。

## 决策

1. 在 `examples/xiaohuan-doubao-audio/` 由 Node 子进程监管本机 FFmpeg，以固定 `file,udp,rtp` 协议白名单接收 SDP/RTP/Opus。
2. FFmpeg 输出固定时长、16 kHz、单声道、16-bit PCM WAV 分段；Node 只消费已完成且通过现有 WAV 校验器的分段。
3. 默认只在本机 capture。只有同时显式提供 process 模式和外部上传确认，才复用 ADR-0074 的方舟管线。
4. 模型处理严格串行，完成分段队列、段数、无首包等待和子进程退出均有界；溢出或 0 帧必须失败，不静默丢段或把空 WAV 当成功。
5. 第一版用固定时长分段，不实现语义 VAD；VAD 参数待真实实验室音频采样后另行决策。

## 后果

- **Positive**：不新增原生 Opus 依赖，直接复用成熟的 RTP/Opus 解码与重采样能力。
- **Positive**：实时接收保持在 operator 示例内，不改变平台核心、身份链或 Backend Gateway 边界。
- **Positive**：默认不会因为启动监听而自动把现场语音上传到外部服务。
- **Negative**：目标 macOS 必须预装 FFmpeg并允许 UDP 入站；硬件发送 IP 配错时只能超时失败。
- **Negative**：固定分段可能切断句子，且方舟处理慢于短分段产生速度时只能运行有界短会话。

## 被否决方案

- 在 Node 中自行实现 RTP/Opus：增加协议、抖动和原生解码维护面。
- 默认收到音频即上传方舟：扩大隐私授权，且容易误上传持续环境音。
- 第一版直接做 VAD：没有真实噪声样本时阈值不可验证，容易吞字或无法切句。

## Why

当前已验证链路只能处理录制完成的 WAV，无法直接消费小环持续发送的 RTP/UDP Opus。硬件实际把音频发往本机 macOS `192.168.66.113:50020`，因此需要一个本机 operator-specific 接收层，将实时流可靠地解码、切成有界单句话 WAV，并复用现有方舟处理链路。

## What Changes

- 在 `examples/xiaohuan-doubao-audio/` 增加 macOS RTP/Opus 实时接收入口。
- 根据 SDP 启动并监管 FFmpeg，将 48 kHz Opus 流解码为 16 kHz、单声道、16-bit PCM WAV 分段。
- 先提供固定时长分段作为确定性 MVP，并通过串行队列把完成的分段交给现有单阶段方舟管线；不并发处理同一实时会话。
- 提供只接收/落临时分段的 capture-only 模式，便于在不上传音频时验证硬件链路。
- 对 SDP、FFmpeg、输出目录、分段时长、队列上限、信号退出和异常进行有界、可观测且不泄漏音频内容的处理。
- 更新 macOS 操作说明和真实设备验证步骤。

## Capabilities

### New Capabilities

- `xiaohuan-macos-realtime-audio-ingress`: 在 macOS 接收小环 RTP/UDP Opus，生成有界 PCM WAV 分段，并可选串行提交到现有 transcript + JSON 管线。

### Modified Capabilities

无。

## Impact

- 影响范围限定在 operator-specific 示例、对应脚本、测试、OpenSpec 和 ADR，不修改平台核心、数据库、Backend Gateway、Feishu 或 Bitable。
- 运行时依赖本机已安装的 FFmpeg/ffprobe，以及硬件提供的 SDP；不新增 npm 生产依赖。
- capture-only 模式不会调用外部模型；process 模式沿用已有本地方舟 `.env`。
- 实时接收需要 macOS 防火墙允许 FFmpeg/Node 接收 UDP 50020，且硬件发送目标必须是本机实际局域网地址。

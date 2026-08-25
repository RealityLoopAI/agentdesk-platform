## Why

当前 realtime CLI 必须人工协调“先启动、再说话”，并按固定 20 秒切段；真实测试已经证明启动时序不正确会漏掉整句或只录到句尾。需要把小环接收器改成长期运行、自动检测一句话起止的服务，让操作员直接说实验内容即可触发 transcript + JSON。

## What Changes

- 新增长期运行的 macOS listening service，保持一个 FFmpeg RTP/Opus → 16 kHz PCM 流持续打开。
- 在 Node 内实现有界能量 VAD：噪声门限、连续起句帧、预录缓冲、尾静音、最短语音和最长语句。
- VAD 完成一句后生成临时 PCM WAV，并进入与监听解耦的有界串行处理队列。
- 默认 capture-only；只有显式启用 process 并确认外部上传时，才自动调用现有方舟 transcript + JSON 管线。
- 提供安全状态日志、句子编号、失败隔离、SIGINT/SIGTERM 优雅退出和临时文件清理。
- 用已验证的小环电平范围校准默认参数，并提供实时调参/排障说明。

## Capabilities

### New Capabilities

- `xiaohuan-vad-listening-service`: 常驻接收小环 PCM 流，自动检测单句话边界并可选串行提交方舟处理。

### Modified Capabilities

无。

## Impact

- 修改范围限定在 `examples/xiaohuan-doubao-audio/`、专项测试、OpenSpec 和 ADR。
- 复用本机 FFmpeg 与现有方舟客户端，不新增 npm 生产依赖。
- 不修改平台核心、数据库、Backend Gateway、Feishu 或 Bitable。
- 常驻 process 模式会持续把检测到的语句发送到外部方舟，因此必须显式确认并设置队列、最长语句和临时文件边界。

## 1. 决策与配置

- [x] 1.1 新增 ADR，记录 macOS operator-specific FFmpeg RTP ingress、capture-only 默认和固定分段选择
- [x] 1.2 实现 realtime CLI 参数与配置校验，覆盖 SDP、FFmpeg、段长、首段超时、段数、队列、输出和上传确认
- [x] 1.3 提供无秘密的 macOS SDP 示例，并校验 payload 96、Opus 48 kHz 和音频端口声明

## 2. RTP 接收与分段

- [x] 2.1 实现无 shell 的 FFmpeg 参数构造，固定协议白名单和 PCM WAV 输出格式
- [x] 2.2 实现 FFmpeg 子进程启动、错误尾部收集、首段超时、优雅停止和强制退出宽限
- [x] 2.3 实现完成分段发现，确保不读取仍在写入的当前段，并在退出时处理最终非空段
- [x] 2.4 复用 `loadWav` 验证每个分段，拒绝空 Header、损坏、超时和超限音频

## 3. Capture 与处理模式

- [x] 3.1 实现默认 capture-only 模式，不加载方舟 Key、不发外部请求
- [x] 3.2 实现 `--process --allow-external-upload` 双重显式开关并复用现有 `processWav`
- [x] 3.3 实现串行处理和有界队列，达到段数上限时优雅停止，溢出时不静默丢段
- [x] 3.4 实现默认临时目录清理、显式保留目录和安全 JSON Lines/阶段日志

## 4. 测试与文档

- [x] 4.1 添加配置、SDP 和 FFmpeg 参数单元测试
- [x] 4.2 添加模拟 FFmpeg 分段、最终段、无首包、异常退出、信号和清理测试
- [x] 4.3 添加 capture-only 零外部请求、上传确认、串行队列、上限与溢出测试
- [x] 4.4 更新 README，写明 macOS 地址、UDP 50020、FFmpeg 命令、隐私边界和排障
- [x] 4.5 运行示例类型检查、专项测试、平台 typecheck、相关守卫和 OpenSpec strict validation

## 5. 真实硬件验证

- [x] 5.1 用提供的 macOS SDP 启动本机 FFmpeg 探测，记录 0 帧/空 WAV 结果并确认不得假成功
- [x] 5.2 确认硬件发送目标为 `192.168.66.113:50020` 且 macOS 放行入站 UDP
- [x] 5.3 capture-only 接收至少一个真实小环分段，核对 PCM 格式、时长和可听内容
- [x] 5.4 经明确外部上传确认后，将一个真实小环分段送入方舟并核对 transcript + JSON
- [x] 5.5 在 `verification.md` 记录自动化和真实硬件证据，不记录音频、Key、完整 transcript 或原始响应

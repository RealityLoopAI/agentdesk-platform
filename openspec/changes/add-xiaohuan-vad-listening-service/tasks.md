## 1. 决策与配置

- [x] 1.1 新增 ADR，记录持续 PCM + Node 能量 VAD、默认阈值和有界队列决策
- [x] 1.2 实现 VAD service CLI 配置，覆盖阈值、帧长、预录、起句、尾静音、最短/最长句、队列和上传确认
- [x] 1.3 实现无 shell 的 FFmpeg 持续 raw PCM 输出参数与启动校验

## 2. VAD 核心

- [x] 2.1 实现 20 ms PCM 帧累积和 RMS dBFS 计算
- [x] 2.2 实现 idle/speech 状态机、连续起句帧、预录和尾静音切句
- [x] 2.3 实现短脉冲丢弃、最长句强制结束和 shutdown 最终句规则
- [x] 2.4 实现 PCM utterance → 合法 16 kHz mono PCM WAV 编码并复用现有校验

## 3. 常驻服务

- [x] 3.1 实现 FFmpeg stdout 持续消费、首 PCM 超时、ready 事件和异常退出
- [x] 3.2 实现监听与串行 worker 解耦的有界 utterance 队列
- [x] 3.3 实现 capture-only 默认与 process + external-upload 双重显式授权
- [x] 3.4 实现单句失败隔离、JSON Lines 输出、安全日志和临时文件生命周期
- [x] 3.5 实现 SIGINT/SIGTERM 停止 FFmpeg、最终句判定、队列排空和清理

## 4. 测试与文档

- [x] 4.1 添加 dBFS、跨 chunk 帧、起句、预录、尾静音、短脉冲和最长句单元测试
- [x] 4.2 添加模拟持续 FFmpeg、首包超时、异常退出、信号和临时清理测试
- [x] 4.3 添加慢模型不停监听、严格串行、单句失败继续和队列溢出测试
- [x] 4.4 更新 README，提供常驻 capture/process 命令、参数校准、隐私和运行限制
- [x] 4.5 运行示例类型检查、全部音频专项测试、平台 typecheck、安全守卫和 OpenSpec strict validation

## 5. 真实小环验证

- [x] 5.1 用已确认的真实小环 WAV 回放校准默认 VAD，证明完整句恰好切一次
- [x] 5.2 启动真实 capture-only 常驻服务，连续说两句话并得到两个自动 WAV
- [x] 5.3 经持续上传明确授权后，连续两句话自动得到两个 transcript + JSON
- [x] 5.4 在 `verification.md` 记录延迟、边界和安全请求 ID，不存音频、完整 transcript 或原始响应

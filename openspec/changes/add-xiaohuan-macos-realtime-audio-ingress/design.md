## Context

小环持续发送 RTP/UDP Opus：payload type 96、48 kHz RTP 时钟、20 ms 帧、CBR 64 kbps、单声道。硬件同事提供的 macOS SDP 将接收地址配置为本机 `192.168.66.113:50020`。现有示例只接受完整 PCM WAV，并用一次方舟 Responses 请求返回 transcript 与实验 JSON。

2026-07-30 在本机用该 SDP 做了 8 秒目标的 FFmpeg 探测。进程可启动，但超时前收到 0 个媒体帧，只留下 110 字节空 WAV。这说明实现必须把“监听成功”和“收到有效音频”分开，并为无首包提供明确错误；真实验收仍依赖硬件发送目标和 macOS 入站网络状态。

## Goals / Non-Goals

**Goals:**

- 在 macOS 上安全启动和监管 FFmpeg，接收小环 RTP/Opus。
- 输出符合现有管线要求的 16 kHz、单声道、16-bit PCM WAV 完整分段。
- 默认只在本机 capture；只有显式确认外部上传时才把分段送到方舟。
- 处理完成分段而非仍在写入的文件；队列、磁盘、运行时长和子进程退出均有界。
- 复用当前 `processWav`，保持 transcript + `experiment-audio.v1` 契约不变。

**Non-Goals:**

- 本轮不实现逐字流式 ASR、WebRTC、设备控制协议或修改硬件固件。
- 本轮不承诺语义 VAD；固定时长分段是确定性 MVP。
- 不写数据库、Backend Gateway、Feishu 或 Bitable。
- 不把 operator-specific RTP 行为加入平台通用 channel/provider 核心。

## Decisions

### 1. 由 Node 监管本机 FFmpeg，不在 Node 内实现 RTP/Opus

接收器使用 `child_process.spawn` 参数数组且 `shell: false`，协议白名单固定为 `file,udp,rtp`。FFmpeg 负责 SDP/RTP/Opus、重采样和 WAV mux；Node 负责配置校验、完成分段发现、队列、信号和安全日志。

这复用了本机已验证的 FFmpeg 能力，不引入原生 Opus npm 依赖，也避免在示例里重写 RTP 丢包、时间戳和解码逻辑。代价是运行环境必须安装 FFmpeg。

### 2. 固定时长 WAV segment 是第一版切句边界

FFmpeg segment muxer 输出编号文件，格式固定为 PCM s16le、16 kHz、单声道。只有观察到后续编号文件或 FFmpeg 正常退出后，前一个文件才被视为完成；完成后仍复用 `loadWav` 检查 Header、非空数据、大小和时长。

选择固定时长而非首版 VAD，是因为 VAD 阈值会受实验室噪声和设备增益影响，需要真实样本调参。默认分段必须不超过现有 `DOUBAO_WAV_MAX_DURATION_MS`。

### 3. capture-only 默认，外部上传需要双重显式选择

默认模式只生成本地 WAV。处理模式要求同时提供 `--process` 和 `--allow-external-upload`，然后才加载方舟配置和调用现有 `processWav`。这避免“开始监听”被误解为同意持续上传现场语音。

临时目录默认由程序创建并在正常退出后清理；显式 `--output-dir` 或 `--keep-segments` 才保留音频。结果以 JSON Lines 写 stdout，运行状态写不含音频内容的 stderr。

### 4. 串行处理、有界等待、不静默丢段

process 模式一次只处理一个完成分段。待处理队列达到配置上限时，接收器停止 FFmpeg并返回 `QUEUE_OVERFLOW`，而不是无限占用磁盘或静默丢弃音频。因为当前模型耗时约 22 秒而短分段可能更快产生，process 模式适合有界冒烟和短会话，不承诺无限持续吞吐。

`--max-segments` 限制一次运行完成的段数；`--first-segment-timeout-ms` 限制无首包等待。到达上限或收到 SIGINT/SIGTERM 时先请求 FFmpeg 优雅结束，等待最后完整段，再在有界宽限期后强制结束。

### 5. SDP 和路径均视为配置，不拼接 shell

SDP 必须是有界、可读的常规文件，并包含目标音频媒体、payload 96 与 `opus/48000`。输出目录必须是明确路径；文件名由程序生成，capture ID 只使用安全字符。FFmpeg stderr 只保留有界尾部用于错误分类，不写普通成功日志。

## Risks / Trade-offs

- **硬件仍向旧 Windows IP 发送** → 接收器在首段超时后明确报 `NO_AUDIO_RECEIVED`；操作员核对发送目标为 `192.168.66.113`。
- **macOS 防火墙丢弃 UDP 50020** → 文档提供防火墙和 `lsof`/FFmpeg 探测步骤，不把空 WAV 当成功。
- **固定分段切断一句话** → 首版使用适合单句话的可配置段长；真实采样后再增加 VAD。
- **方舟慢于分段产生速度** → 串行有界队列，溢出时停止而非丢数据；capture-only 可持续验证接收。
- **进程中断留下临时文件** → 信号处理先终止 FFmpeg，默认临时目录在最终清理阶段删除；显式保留模式除外。
- **FFmpeg 行为跨版本不同** → 启动前验证可执行文件，参数构造和退出分类用测试固定，真实 macOS 版本记录在 verification。

## Migration Plan

1. 保持现有文件 CLI 和 API 不变，新增独立 realtime CLI。
2. 先用模拟 FFmpeg/预制 segment 测试生命周期与队列。
3. 用本机 SDP 跑 capture-only 单段测试。
4. 确认音频非敏感并显式允许上传后，跑单段 process 冒烟。
5. 回滚只需停止 realtime CLI；原 WAV CLI 不受影响。

## Open Questions

- 真实实验室背景噪声下的 VAD 阈值和静音持续时间，需要取得小环实采样本后决定。
- 硬件发送目标是否已从旧 Windows `192.168.66.32` 固定切换为本机 `192.168.66.113`，当前 0 帧探测尚不能确认。

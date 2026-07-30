# 小环单句话 WAV → 方舟多模态 → 实验 JSON

这是 operator-specific MVP 示例。它把一个有界 PCM WAV 作为 data URI 提交给火山方舟 `doubao-seed-2-0-lite-260428`，用一次 Responses API 调用同时取得中文 transcript 和 `experiment-audio.v1`。

示例不修改 AgentDesk 通用 Provider、数据库、Backend Gateway 或飞书通道。成功结果只写 stdout，安全阶段日志写 stderr；默认不复制音频、不生成结果文件。

## 配置

现有凭证必须是[火山方舟 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apikey)，不是豆包语音产品 APP Key。先复制模板：

```bash
cp examples/xiaohuan-doubao-audio/xiaohuan-doubao-audio.env.example \
  examples/xiaohuan-doubao-audio/.env
```

只在被 Git 忽略的 `examples/xiaohuan-doubao-audio/.env` 填写：

```dotenv
DOUBAO_ARK_API_KEY=
DOUBAO_ARK_MODEL=doubao-seed-2-0-lite-260428
DOUBAO_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_REQUEST_TIMEOUT_MS=60000
DOUBAO_WAV_MAX_BYTES=10485760
DOUBAO_WAV_MAX_DURATION_MS=20000
```

程序不读取 `DOUBAO_SPEECH_*`。缺 Key、缺模型、占位 Key、非 HTTPS Base URL 或非法限制都会在读取 WAV 前失败关闭。

## 运行

```bash
node \
  --env-file=examples/xiaohuan-doubao-audio/.env \
  --import tsx \
  examples/xiaohuan-doubao-audio/cli.ts \
  /absolute/path/to/utterance.wav \
  --capture-id lab-capture-001
```

CLI 会：

1. 校验 PCM WAV Header、大小和时长。
2. 向 `<DOUBAO_ARK_BASE_URL>/responses` 发起一次调用。
3. 发送 `input_text` Schema 指令和 `{type:"input_audio", audio_url:"data:audio/wav;base64,..."}`。
4. 从 `output[].content[].text` 解析并校验 `experiment-audio.v1`。

stdout 只包含最终 JSON：

```json
{
  "schemaVersion": "experiment-audio.v1",
  "captureId": "lab-capture-001",
  "transcript": "样品测试一号，在二十五摄氏度静置三十分钟。",
  "experiment": {
    "title": null,
    "sampleIds": ["样品测试一号"],
    "actions": [{ "name": "静置", "target": "样品测试一号" }],
    "measurements": [
      { "name": "温度", "value": 25, "unit": "摄氏度" },
      { "name": "时长", "value": 30, "unit": "分钟" }
    ],
    "observations": [],
    "notes": null
  }
}
```

## 在本机 macOS 实时接收小环 RTP

当前本机局域网地址是 `192.168.66.113`。仓库内的
`xiaohuan-realtime-macos.sdp` 监听该地址的 UDP 50020，声明 payload type
96、Opus 48 kHz。硬件发送目标也必须是 `192.168.66.113:50020`；旧文档里的
Windows 地址 `192.168.66.32` 不再适用。

先确认依赖和端口：

```bash
ffmpeg -version
lsof -nP -iUDP:50020
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```

默认 capture-only，不读取方舟 Key，也不上传音频。下面接收一个 8 秒分段并保存在指定目录：

```bash
node --import tsx \
  examples/xiaohuan-doubao-audio/realtime-cli.ts \
  --sdp examples/xiaohuan-doubao-audio/xiaohuan-realtime-macos.sdp \
  --segment-seconds 8 \
  --max-segments 1 \
  --output-dir /tmp/xiaohuan-captures
```

接收到的分段固定转换成 16 kHz、单声道、16-bit PCM WAV。没有 `--output-dir`
时使用程序临时目录，并在结束后清理；加 `--keep-segments` 可保留该临时目录。
30 秒内没有完成首段会返回 `NO_AUDIO_RECEIVED`，空 WAV Header 不算成功。

只有已确认现场音频允许发往方舟时，才同时提供两个显式开关：

```bash
node \
  --env-file=examples/xiaohuan-doubao-audio/.env \
  --import tsx \
  examples/xiaohuan-doubao-audio/realtime-cli.ts \
  --sdp examples/xiaohuan-doubao-audio/xiaohuan-realtime-macos.sdp \
  --segment-seconds 8 \
  --max-segments 1 \
  --process \
  --allow-external-upload
```

process 模式串行处理完成分段，并把每段的 `experiment-audio.v1` 作为一行
JSON 写 stdout。`--max-queue` 默认 4；如果方舟处理慢于分段产生速度导致积压
超过上限，程序停止接收并返回 `QUEUE_OVERFLOW`，不会静默丢音频。

录制时说一句批准的非敏感测试话术：

```text
样品测试一号，在二十五摄氏度静置三十分钟，观察到溶液变蓝。
```

检查保留的文件：

```bash
ffprobe -v error \
  -show_entries stream=codec_name,sample_rate,channels,bits_per_sample \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 \
  /tmp/xiaohuan-captures/segment-000000.wav
```

不要用设备自身的 `POST /api/tts/speak` 播放测试话术：设备播报期间会暂停 USB 麦克风采集和 RTP 推流。

## 常驻监听与 VAD 自动切句

`vad-service-cli.ts` 保持一个 FFmpeg RTP 连接长期运行。看到
`xiaohuan_vad_ready` 后可以直接说实验句；服务检测到起句和尾静音后自动生成
WAV，不需要人工同步启动，也不按固定 20 秒切段。

默认 capture-only：

```bash
node --import tsx \
  examples/xiaohuan-doubao-audio/vad-service-cli.ts \
  --sdp examples/xiaohuan-doubao-audio/xiaohuan-realtime-macos.sdp \
  --output-dir /tmp/xiaohuan-vad-captures
```

服务会一直运行，按 `Ctrl-C` 优雅停止。每句输出一行
`xiaohuan_vad_utterance` JSON，并把 WAV 保留在指定目录。调试时可用
`--max-utterances 2` 在检测两句后自动结束。

经过当前小环样本校准的默认 VAD 参数：

- 20 ms PCM 帧；
- `-43 dBFS` 起句门限；
- 连续 5 帧（100 ms）超过门限才起句；
- 300 ms 预录；
- 800 ms 尾静音；
- 400 ms 最短有效语音；
- 20 秒最长单句；
- 最多排队 4 句。
- 写 WAV 前归一化到 `-3 dBFS` 峰值，最大只增加 30 dB。

可用 `--threshold-db`、`--start-frames`、`--pre-roll-ms`、
`--trailing-silence-ms`、`--min-speech-ms`、`--max-utterance-ms` 和
`--max-queue` 覆盖。归一化可用 `--normalize-peak-db` 和
`--max-normalize-gain-db` 调整。持续噪声误触发时提高门限，例如从 `-43` 改成 `-38`；
轻声无法触发时降低门限，例如改成 `-46`。

只有明确同意本次服务生命周期内检测到的每句话都发送到方舟时，才启动 process
模式：

```bash
node \
  --env-file=examples/xiaohuan-doubao-audio/.env \
  --import tsx \
  examples/xiaohuan-doubao-audio/vad-service-cli.ts \
  --sdp examples/xiaohuan-doubao-audio/xiaohuan-realtime-macos.sdp \
  --process \
  --allow-external-upload
```

监听与模型 worker 解耦：方舟处理上一句时仍继续接收下一句，但模型调用严格串行。
单句失败不会停止监听；队列满会返回 `QUEUE_OVERFLOW` 并停止，绝不静默丢句。
不要在实验句前说“你好小环”，避免触发设备本机行为影响麦克风推流。

## 错误与隐私

- `configuration`：Key/模型/Base URL/限制错误。
- `input`：文件不存在、空文件、损坏、非 PCM、超出大小或时长。
- `multimodal`：方舟鉴权、限流、超时、上游、空响应、畸形 JSON 或结构错误。
- `realtime`：无首包、FFmpeg 启动/退出、队列溢出或实时生命周期错误。

一次 `processWav` 恰好一次模型调用，不自动重试或回退。Key、Authorization、音频 Base64、完整 Prompt、完整 transcript 和原始模型响应不进入普通日志或错误消息。

模型输出只做结构、schema 版本、capture ID 和非空 transcript 校验；本轮不判断实验事实是否完整或正确。

实时 RTP/VAD 仍是 operator-specific 本机示例，不是平台通用 channel。本轮不实现
数据库、Gateway 操作、Agent、飞书消息或多维表格写入。后续 Bitable 写入必须通过 Backend Gateway。

## 验证

```bash
pnpm exec tsc -p examples/xiaohuan-doubao-audio/tsconfig.json
pnpm exec vitest run \
  scripts/xiaohuan-doubao-audio.test.ts \
  scripts/xiaohuan-realtime-audio.test.ts \
  scripts/xiaohuan-vad-service.test.ts
```

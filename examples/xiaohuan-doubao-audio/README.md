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

## 从小环 RTP 生成真实测试 WAV

小环向 Windows `192.168.66.32:50020` 持续发送 RTP/UDP Opus，48 kHz、20 ms 帧、payload type 96。先按硬件说明放行 UDP 50020，并确认 VLC 使用配套 SDP 可以听到声音。

在 SDP 所在目录用 FFmpeg 录制并转换为 16 kHz、单声道、16-bit PCM：

```powershell
ffmpeg -protocol_whitelist file,udp,rtp -i ".\小环实时音频_50020.sdp" -t 8 -vn -ac 1 -ar 16000 -c:a pcm_s16le ".\xiaohuan-smoke.wav"
```

录制时说一句批准的非敏感测试话术：

```text
样品测试一号，在二十五摄氏度静置三十分钟，观察到溶液变蓝。
```

检查文件：

```powershell
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,bits_per_sample -show_entries format=duration,size -of default=noprint_wrappers=1 ".\xiaohuan-smoke.wav"
```

不要用设备自身的 `POST /api/tts/speak` 播放测试话术：设备播报期间会暂停 USB 麦克风采集和 RTP 推流。

## 错误与隐私

- `configuration`：Key/模型/Base URL/限制错误。
- `input`：文件不存在、空文件、损坏、非 PCM、超出大小或时长。
- `multimodal`：方舟鉴权、限流、超时、上游、空响应、畸形 JSON 或结构错误。

一次 `processWav` 恰好一次模型调用，不自动重试或回退。Key、Authorization、音频 Base64、完整 Prompt、完整 transcript 和原始模型响应不进入普通日志或错误消息。

模型输出只做结构、schema 版本、capture ID 和非空 transcript 校验；本轮不判断实验事实是否完整或正确。

本轮不实现 RTP/VAD 服务、数据库、Gateway 操作、Agent、飞书消息或多维表格写入。后续 Bitable 写入必须通过 Backend Gateway。

## 验证

```bash
pnpm exec tsc -p examples/xiaohuan-doubao-audio/tsconfig.json
pnpm exec vitest run scripts/xiaohuan-doubao-audio.test.ts
```

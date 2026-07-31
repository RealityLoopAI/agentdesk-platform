# ADR-0088: 由硬件切句并以整句 HTTP WAV 接入语音链路

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 小环硬件与实验链路负责人；coding agent（提案、执行、验证）
- **Tags**: `xiaohuan`, `audio`, `http`, `wav`, `hardware`, `ark`, `examples`
- **Supersedes**: ADR-0083 的本机 TTS 回执部分
- **Superseded by**: 无

---

## Context

早期小环链路由 macOS 持续接收 RTP/Opus，再由 FFmpeg 和能量 VAD 切句。真实使用中，
环境噪声会产生无效 utterance，本机还需要协调 VAD、设备播报和录音恢复。硬件现在已经
具备唤醒、语音起止检测、拍照指令分流和本地提示音能力，并提供固定协议：向原 Mac 地址
的 TCP 50020 `POST /api/audio` 上传完整 16 kHz 单声道 PCM WAV。

已知约束：

- 普通语句最长约 60 秒、请求体最多 4 MiB；body 不携带身份或幂等元数据。
- 设备把任意 2xx 视为成功，失败最多重试三次。
- 固定规范用户、确认、授权、Gateway 与审计链不能由设备地址或音频内容替代。
- 本机不再播报“收到”；硬件拥有全部录音状态和听觉反馈。

## Options Considered

- **Option A：保留持续 RTP/VAD，同时增加硬件唤醒。** 可少改本机代码，但重复切句，
  仍会保留环境误触发、FFmpeg 生命周期和 UDP 端口竞争。
- **Option B：硬件写共享目录，本机轮询 WAV。** 边界直观，但需要共享文件系统、
  完成标记和额外权限，且与硬件已经交付的 HTTP 契约不一致。
- **Option C：Bridge 直接接收硬件整句 HTTP WAV。** 复用现有协议和方舟处理，
  去掉本机采集状态机；需要严格处理无鉴权局域网入口、队列和重试去重。

## Decision

> **拍板**：选 Option C。

Bridge 在 operator 配置的地址（当前为 `0.0.0.0:50020`）提供
`POST /api/audio` 与 `GET /healthz`。它只接受带明确 `Content-Length` 的原始
`audio/wav`，校验 4 MiB、PCM 16-bit little-endian、16 kHz、单声道和时长上限，
原子落盘后进入有界串行方舟队列并返回 202。

完整 WAV 的 SHA-256 用于派生稳定 capture ID 和进程内重复检测。相同字节流因 HTTP
响应丢失而重试时返回成功但不重复创建方舟、Agent 或 Bitable 意图。队列满时返回非 2xx，
让硬件执行自己的有界重试。

硬件负责唤醒、有效语句判断、句尾切分、拍照分流和所有提示音。本机不调用设备 TTS。
旧 RTP/VAD 实现保留为历史诊断工具，不再是 Bridge 生产入口。

## Consequences

- **Positive**: 本机不再持续采集环境音，也不再依赖 FFmpeg/VAD 参数和尾静音时序。
- **Positive**: 一次硬件语句对应一个 HTTP 请求和一个稳定业务意图，边界更易测试。
- **Positive**: 硬件提示音不再等待或干扰方舟、确认与写表链路。
- **Negative**: 当前 HTTP 协议无鉴权，只能部署在可信局域网且不得映射公网。
- **Negative**: 设备请求没有显式 utterance ID，只能用完整字节摘要识别精确重试。
- **Neutral / Trade-offs**: HTTP 202 只表示 WAV 已验证、持久化并进入本机队列，
  不表示方舟、确认或写表成功。

## Implementation Notes

- HTTP/WAV 服务：`examples/xiaohuan-doubao-audio/whole-utterance-http-service.ts`
- Bridge 配置与组合：`examples/xiaohuan-bitable-bridge/config.ts`,
  `examples/xiaohuan-bitable-bridge/adapter.ts`
- 运行说明：`examples/xiaohuan-bitable-bridge/README.md`
- 相关上游：ADR-0074、ADR-0082、ADR-0084
- 验收：正常上传 202；错误类型/长度/WAV 非 2xx；重复 payload 不重复处理；队满可重试；
  teardown 停止接收并排空；无设备 TTS 请求。

## References

- `小环整句语音HTTP接收接口.md`
- `xiaohuan_audio_receiver.py`
- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`

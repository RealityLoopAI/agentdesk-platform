## Why

现有系统已具备飞书消息入口、Agent 委派以及经 Backend Gateway 确认后写入飞书多维表格的能力，但尚不能把小环设备发送到 macOS 的实时 RTP/Opus 音频转换为可信的 Agent 输入。需要一个范围受控、可现场演示的最小闭环，验证“说话 → 飞书流式转写 → 实验信息提取 → 用户确认 → 多维表格新增记录”的技术可行性，同时不把实验室专用逻辑写入平台核心。

## What Changes

- 新增一个位于 `examples/` 的小环音频 Demo Channel 扩展：在 macOS 上接收单一批准设备发送的 RTP/UDP Opus 音频，解码并重采样为飞书流式语音识别要求的 16 kHz 单声道 PCM。
- 通过飞书流式语音识别 API 发送有序的 100–200 ms 音频分片，只把正常结束后取得的最终文本交给 Agent；原始音频与 Base64 PCM 不落盘、不进入日志。
- 使用简单能量 VAD、静音结束和最长语句限制切分话语；仅带配置唤醒词“记录实验”的最终文本触发 Agent。
- 将 Demo 固定绑定到一个运营者配置的规范用户和飞书 P2P 会话；设备 IP 或转写文本不得决定用户身份，群聊目标被拒绝。
- 复用现有 Frontdesk、专用多维表格 Worker 和 Backend Gateway：Agent 从转写中提取实验字段、在缺失时向 P2P 用户追问、展示新增预览，并且仅在用户明确确认后通过批准的逻辑资源新增一条记录。
- Demo 仅支持单设备、单活跃语音流、单用户、单表和 Record Create；不包含多用户映射、群聊、音频回放/上传、Record Update/Delete/Batch 或通用音频服务。
- 提供失败关闭配置检查、自动化测试和真实设备演示清单，覆盖无唤醒词、来源不符、识别失败、取消、重试幂等和写后校验。

## Capabilities

### New Capabilities

- `xiaohuan-feishu-audio-demo`: 小环 RTP/Opus 音频在 macOS 上接收、飞书流式转写、固定 P2P 身份路由，以及经现有 Agent/Gateway 确认后新增多维表格记录的受控演示闭环。

### Modified Capabilities

无。Demo 复用既有 `federated-user-identity` 与 `feishu-bitable-operations` 契约，不改变其要求。

## Impact

- 新增 operator-specific 示例扩展、配置样例、测试和演示文档，预期位于 `examples/xiaohuan-audio-demo/`；平台核心保持业务无关。
- 运行时依赖 macOS 网络可达性、UDP 监听端口、FFmpeg 的 RTP/Opus 解码能力，以及支持流式语音识别的非免费飞书租户与 `speech_to_text:speech` 权限。
- 复用当前 `@larksuiteoapi/node-sdk`、ChannelAdapter 扩展机制、飞书 P2P 交互和 Backend Gateway 多维表格 Operation，不新增绕过 Gateway 的写路径。
- Demo 启用时 VLC 不得同时占用接收端口；所需固定用户、P2P 路由和逻辑表别名由环境配置提供且不得提交真实标识或凭证。

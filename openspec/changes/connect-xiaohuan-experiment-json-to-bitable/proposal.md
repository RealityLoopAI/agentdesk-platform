## Why

小环已经能够在硬件端完成唤醒、说话起止检测和拍照指令分流，并把普通完整语句作为 WAV 上传到 macOS。需要由 Host 侧 Bridge 接收这些整句音频，复用方舟结构化处理，再把结果作为受控的 Host 入站事件交给现有 Bitable Worker/Gateway，完成从语音到表格记录的最小闭环。

## What Changes

- 新增 operator-specific 小环 Bitable bridge，在原 `192.168.66.113:50020` 上以 HTTP/TCP 提供 `POST /api/audio` 和 `GET /healthz`，接收硬件上传的完整 WAV，并组合现有方舟处理器。
- 通过运行时配置把单台设备绑定到一个已存在的规范用户、飞书 P2P 路由和批准的 Bitable 逻辑资源；不得从音频、文本或设备地址推断身份。
- 每个有效 `experiment-audio.v1` 结果转换为一个受控 Agent 入站消息，携带 capture ID、transcript 和结构化实验字段，并要求仅向配置的逻辑资源创建记录。
- 复用现有 Frontdesk、Bitable Worker、`gateway_describe`、`gateway_authorize` 和 `gateway_execute`；Bridge 不持有飞书 Bitable 凭证、不使用物理 app/table ID，也不直连飞书 API。
- 字段映射由运行时配置和实时 `field.list` Schema 共同约束。Bridge 生成固定目标字段的部分候选草稿和映射计划；Worker 可在保留原始 transcript 的前提下，用实时字段类型/单选候选和语音证据修复常见同音字、近音字及结构化漏提取。归一化不得新增未配置字段、不得猜测数字或单位，无法唯一判断时仍失败关闭。
- 默认不启用；启用时必须同时确认硬件触发语音上传到方舟和 Agent/Bitable 投递。单句方舟失败或 Agent 入站失败不得静默写入，且不得绕过部署既有的 Create 确认策略。
- 硬件负责唤醒、有效语句判断、句尾切分和本地提示音。本机不再执行 VAD、FFmpeg/RTP 接收或任何“收到”TTS 回执。
- HTTP 入口只接受带明确 `Content-Length` 的 `audio/wav`，限制为 4 MiB、PCM signed 16-bit little-endian、16 kHz、单声道和不超过约 60 秒；完整校验并原子落盘后才返回 `202`，随后异步进入有界方舟队列。
- 对 WAV 内容计算稳定摘要并在进程内去重，使硬件因 HTTP 响应丢失而重试同一字节流时不会生成第二个 Agent/Bitable 意图。
- Bridge 对 Agent 草稿实行有界单飞：当前语句进入确认流程后，后续已完成的结构化结果先排队，只有当前确认被批准、拒绝、过期或失败后才投递下一条，避免后续自然语音抢占上一条确认。
- 添加模拟测试、真实错误 transcript 回归、配置样例和 macOS 联调手册；真实凭证、用户 ID、资源物理标识和录音不进入仓库。

## Capabilities

### New Capabilities

- `xiaohuan-experiment-bitable-bridge`: 将小环实时语音产生的 `experiment-audio.v1` 结果作为固定身份的 Host 入站事件交给现有 Agent/Gateway，并受控创建飞书多维表格记录。

### Modified Capabilities

无。

## Impact

- 新增 `examples/xiaohuan-bitable-bridge/` 示例扩展、专项测试、运行说明和环境变量模板。
- 复用 `examples/xiaohuan-doubao-audio/` 的 WAV 校验、方舟客户端和结构化 Schema，不新增音频或模型依赖。
- 复用现有 ChannelAdapter 扩展加载、Host RequestIdentity、Agent 路由、Gateway Bitable Operation 和审计链路。
- 为 Host-mediated Gateway confirmation 增加不承载授权语义的可选相关键以及通用“卡片已投递”“确认已解决”观察事件；硬件 HTTP 接收和草稿队列仍只存在于 operator-specific 示例。
- 不修改平台数据库 Schema、飞书 Channel、Gateway 公共契约或 Bitable Provider；真实写入依赖已有 Host、Frontdesk/Bitable Worker、Gateway 和逻辑资源配置。

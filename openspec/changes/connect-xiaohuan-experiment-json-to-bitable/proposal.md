## Why

小环常驻监听已经能够把每句话稳定转换为 `experiment-audio.v1` JSON，但结果目前只写到本机 stdout，不能进入 AgentDesk 的身份、授权、审计和飞书多维表格链路。需要把这份已结构化结果作为受控的 Host 入站事件交给现有 Bitable Worker/Gateway，完成从语音到表格记录的最小闭环。

## What Changes

- 新增 operator-specific 小环 Bitable bridge，把现有 RTP/VAD/方舟处理器组合进一个 Host 侧 Channel 扩展。
- 通过运行时配置把单台设备绑定到一个已存在的规范用户、飞书 P2P 路由和批准的 Bitable 逻辑资源；不得从音频、文本或设备地址推断身份。
- 每个有效 `experiment-audio.v1` 结果转换为一个受控 Agent 入站消息，携带 capture ID、transcript 和结构化实验字段，并要求仅向配置的逻辑资源创建记录。
- 复用现有 Frontdesk、Bitable Worker、`gateway_describe`、`gateway_authorize` 和 `gateway_execute`；Bridge 不持有飞书 Bitable 凭证、不使用物理 app/table ID，也不直连飞书 API。
- 字段映射由运行时配置和实时 `field.list` Schema 共同约束。Bridge 生成固定目标字段的部分候选草稿和映射计划；Worker 可在保留原始 transcript 的前提下，用实时字段类型/单选候选和语音证据修复常见同音字、近音字及结构化漏提取。归一化不得新增未配置字段、不得猜测数字或单位，无法唯一判断时仍失败关闭。
- 默认不启用；启用时必须同时确认持续音频上传和 Agent/Bitable 投递。单句方舟失败或 Agent 入站失败不得静默写入，且不得绕过部署既有的 Create 确认策略。
- 可选启用局域网离线 TTS 回执；每当本机完成一句 VAD 切句、写入并校验完整 WAV 后，立即以稳定幂等请求向配置的语音端播报“收到”，不等待方舟转写、结构化、确认或写表。回执失败不得改变后续处理状态。
- Bridge 对 Agent 草稿实行有界单飞：当前语句进入确认流程后，后续已完成的结构化结果先排队，只有当前确认被批准、拒绝、过期或失败后才投递下一条，避免后续自然语音抢占上一条确认。
- 添加模拟测试、真实错误 transcript 回归、配置样例和 macOS 联调手册；真实凭证、用户 ID、资源物理标识和录音不进入仓库。

## Capabilities

### New Capabilities

- `xiaohuan-experiment-bitable-bridge`: 将小环实时语音产生的 `experiment-audio.v1` 结果作为固定身份的 Host 入站事件交给现有 Agent/Gateway，并受控创建飞书多维表格记录。

### Modified Capabilities

无。

## Impact

- 新增 `examples/xiaohuan-bitable-bridge/` 示例扩展、专项测试、运行说明和环境变量模板。
- 复用 `examples/xiaohuan-doubao-audio/` 的 VAD、WAV、方舟客户端和结构化 Schema，不新增音频或模型依赖。
- 复用现有 ChannelAdapter 扩展加载、Host RequestIdentity、Agent 路由、Gateway Bitable Operation 和审计链路。
- 为 Host-mediated Gateway confirmation 增加不承载授权语义的可选相关键以及通用“卡片已投递”“确认已解决”观察事件；硬件 HTTP 地址、播报行为和草稿队列仍只存在于 operator-specific 示例。
- 不修改平台数据库 Schema、飞书 Channel、Gateway 公共契约或 Bitable Provider；真实写入依赖已有 Host、Frontdesk/Bitable Worker、Gateway 和逻辑资源配置。

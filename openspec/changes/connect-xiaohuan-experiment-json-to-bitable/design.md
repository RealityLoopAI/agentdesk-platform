## Context

`examples/xiaohuan-doubao-audio/` 已验证“小环 RTP/Opus → VAD → WAV → 方舟 → `experiment-audio.v1`”，但服务只输出 JSON Lines。平台已有完整的 Bitable Create 基础设施：Frontdesk/Worker 路由、Host 建立的 RequestIdentity、Gateway 能力发现与授权、字段 Schema 校验、同用户确认、稳定幂等、写后 `record.get` 和审计。

缺失的是两者之间的可信组合层。独立音频进程若直接调用 Gateway，会缺少 Host 建立的规范用户身份并形成平行业务写入路径；若直接调用飞书 API，则会把物理凭证和表标识扩散到音频服务。Bridge 必须作为 operator-controlled Host Channel 扩展运行，通过正常入站路由把结构化结果交给 Agent。

## Goals / Non-Goals

**Goals:**

- 在同一 Host 生命周期内复用现有持续 RTP/VAD/方舟处理器。
- 把每个通过 Schema 校验的 `experiment-audio.v1` 结果映射为目标字段锁定的部分候选草稿，并允许 Worker 在实时表 Schema 内进行有证据的语义归一化。
- 使用配置的规范用户、飞书 P2P 路由和逻辑资源产生正常 Host 入站事件。
- 复用现有 Bitable Worker/Gateway 的发现、授权、确认、创建、幂等、写后读取和审计。
- 单句失败隔离、持续监听、有界队列、安全日志和默认不启用。
- 在本机完成一句切句并校验完整 WAV 后，通过设备离线 TTS HTTP 接口尽早播报一次“收到”。
- 当前 Bridge 草稿的确认流程结束前，不向同一会话投递后续语句。

**Non-Goals:**

- 不从声音、transcript、设备 IP 或模型结果识别用户。
- 不让 Bridge 直连飞书 Bitable、持有 app token/table ID 或调用 Gateway `/execute`。
- 不实现独立人工纠错 UI、Update/Delete/Batch，也不把模型自报置信度当成事实保证。
- 不支持多设备动态认领、群聊身份映射或无人值守绕过确认。
- 不把实验字段名或表结构硬编码进平台核心。
- 不把小环设备地址、TTS 文本或回执策略硬编码进确认模块，不把播报成功解释为确认或写入成功。

## Decisions

### 1. 使用 operator-specific Host Channel 扩展作为可信组合层

新增 `examples/xiaohuan-bitable-bridge/`。扩展由现有 fork-free loader 加载，在 `setup()` 中启动一个可中止的 VAD/方舟服务，在 `teardown()` 中终止并排空。每个模型结果通过 `ChannelSetup.onInboundEvent` 投递到配置的飞书 P2P messaging group。

事件使用运行时配置的 `authenticatedUserId`，且启动时要求用户、P2P platform ID 和逻辑资源全部存在。设备与用户的绑定属于运营者部署信任，不从 Agent 可见的 message content 读取。选择扩展而不是 CLI socket，是为了避免把写入错误归因给 `cli:local`，并使回复、确认和审计继续属于真实 P2P 用户。

### 2. 音频与结构化处理继续复用现有实现

Bridge 直接组合 `validateVadServiceConfig`、`runVadListeningService`、`loadConfig` 和 `createAudioPipeline`，不复制 RTP、VAD、WAV 或方舟客户端。仍要求持续上传的双重显式配置，并沿用有界队列、最长语句、单句失败隔离和临时音频清理。

Bridge 默认关闭。启用但缺少方舟 Key、固定身份、P2P 路由、逻辑资源或字段映射时，扩展失败关闭且不监听 UDP。

### 3. 使用显式字段映射生成目标锁定的部分候选草稿

运行时配置 `XIAOHUAN_BITABLE_FIELD_MAP_JSON` 把固定逻辑路径映射到目标字段名。字符串值保留为简单映射简写；对象值声明确定性选择器。简单映射支持以下源路径：

- `captureId`
- `transcript`
- `experiment.title`
- `experiment.sampleIds`
- `experiment.actions`
- `experiment.measurements`
- `experiment.observations`
- `experiment.notes`

标量保持原值，`null` 字段省略；字符串数组用可配置但固定的分隔符连接；对象数组使用规范 JSON 序列化。映射必须非空、目标字段名唯一、源路径属于闭合集合，且生成值有大小上限。

为适配真实表的单选和数字字段，支持两种对象规则：

- `{ "field": "设备仪器", "selector": "action-target", "name": "使用" }`：在 `experiment.actions` 中按精确动作名筛选，唯一命中时取非空 `target`。
- `{ "field": "无水氯化铜（克）", "selector": "measurement-value", "name": "无水氯化铜", "unit": "克" }`：在 `experiment.measurements` 中按精确名称和可选精确单位筛选，唯一命中时取 `value`。

Bridge 的机械 mapper 仍不自行做模糊匹配、单位换算、别名翻译或取第一项。唯一精确命中时写入初步 `fields`；零匹配、多个匹配、空目标、空测量值和空数组改为省略该候选字段，而不是丢弃包含原始证据的整句话。Envelope 同时携带规范化的 `fieldMapping`，其目标字段集合固定且不含凭证或物理资源标识。

Worker 必须先调用 `feishu.bitable.field.list`，再把部分候选、原始 transcript、结构化 experiment 和 `fieldMapping` 一起用于证据约束的归一化。这样真实 Field List 仍是字段名、类型和选项的唯一真相源，不需要 Bridge 复制单选候选，也不增加第二次方舟调用。

### 4. 入站消息允许受控归一化而非自由文本重抽取

Bridge 把逻辑资源、capture ID、transcript、原始 `experiment-audio.v1` 和确定性 `fields` 草稿包装成有版本的 JSON 消息，并明确要求：

1. 只使用配置的逻辑资源；
2. 只允许为 `fieldMapping` 声明的目标字段，从 transcript/experiment 的明确证据修复漏提取或 ASR 近音错误；
3. 发现并验证字段，单选归一化值必须逐字来自 Field List options；
4. 对 Create 使用当前 Host-mediated 同用户确认策略；
5. 使用稳定幂等键；
6. 成功后 `record.get` 并返回 record ID/audit ID。

Worker 不进行不受控的整句重抽取。它只能在固定目标字段内归一化：优先保留已合法的初步值；文本漏提取可恢复 transcript 中明确标记的连续内容；单选错字可在语音上下文只支持一个 Field List option 时纠正；数值和单位必须在 transcript 或结构化 measurement 中明确出现。多个候选合理、证据冲突或无法定位时必须停止并请求澄清。最终字段完整展示在原用户确认卡中。

### 5. 幂等键绑定原始 capture、资源、实验结果和映射计划

Bridge 在消息中提供稳定 request fingerprint：对 `{captureId, resource, transcript, experiment, fieldMapping}` 做规范 JSON 和 SHA-256。Worker 使用该 fingerprint 派生 Create 幂等键。同一切句重放不会新增第二条；同一来源若归一化结果发生漂移，Gateway 对同一幂等键绑定不同 Create input 的冲突规则会失败关闭，不会双写。

### 6. 保留现有确认与身份链

Bridge 不自动批准 Create。确认必须由原规范 P2P 用户经 Host Pending 流完成；其他用户、群聊、超时或取消不得写入。Gateway 继续拒绝 `requesterSource=agent-asserted`、未授权 writer、未发布 Operation、非法字段和缺少幂等键的请求。

这满足“语音自动进入写表流程”，但不会把“自动切句”解释为“自动绕过写入确认”。若运营者未来需要特定低风险表免确认，应在 Gateway 业务策略中显式设计，而不是在 Bridge 中旁路。

### 7. 在完整 WAV 本地就绪后发送幂等的设备 TTS 回执

VAD 服务在切句结束、WAV 写入并通过本地格式/大小/时长校验后，且在调用方舟
`processUtterance` 之前发出 `onWavReady` 回调。Bridge 立即异步调用设备
`POST /api/tts/speak`，不把 TTS 网络等待串到方舟请求之前。请求使用由 Bridge
本次运行 nonce 与 capture ID 哈希派生的
`request_id=xiaohuan-received-${receiptKey}` 和可配置但有界的默认文本“收到”；
同一句回调重放仍使用同一 request ID。

TTS 地址、超时和文本只来自 operator 配置，默认关闭。客户端要求 HTTP 202、
`accepted=true` 和响应中的相同 `request_id`；429、超时、网络错误、畸形响应或
非 202 仅记录内容安全的 typed error，不重投确认卡、不改变 Pending 状态、更不执行写入。
TTS 回调只表示本机已完整收到该句，不表示转写成功、确认已批准或记录已写入。

### 8. 用确认生命周期事件实现有界单飞草稿队列

Bridge 在向 Host 提交一个结构化草稿前把它标记为 active，后续模型结果进入容量不超过
VAD `maxQueue` 的 FIFO 队列。Host 的 `gateway-confirmation-delivered` 事件用相关键、
可信用户和 P2P 路由把 active draft 绑定到 confirmation ID；Host 在批准、拒绝、过期
或失败后再发出不承载授权语义的 `gateway-confirmation-resolved` 观察事件。

Bridge 只有在 resolved 事件的 confirmation ID、可信用户和路由全部匹配时才释放 active
并投递下一条。若某个 Agent 流程始终没有产生确认卡，则 active 在与确认上限一致的
15 分钟后安全释放，避免永久死锁；队列溢出时丢弃新草稿并记录内容安全错误，不绕过单飞。
关闭服务时停止投递排队草稿，不等待人工确认。

## Risks / Trade-offs

- [Host 扩展与当前独立监听器同时绑定 UDP 50020] → 切换到 Bridge 前必须停止独立进程；启动端口冲突时失败关闭。
- [配置字段映射与真实表 Schema 漂移] → Worker/Gateway 每次按现有 TTL 策略发现并校验 Schema；失败不写入。
- [数组序列化不适合目标字段类型] → 文本字段继续使用 join/JSON；单选和数字字段只使用显式 action-target/measurement-value 选择器，并由 Gateway 校验最终类型与选项。
- [语义归一化把错误语音改成合法但错误的值] → 仅允许已配置目标字段、原始证据和实时 Field List 候选；禁止猜测数字/单位，歧义停止；最终结果仍须由原用户查看确认卡后批准。
- [Worker 重试产生不同归一化结果] → 指纹绑定原始证据和映射计划；同一幂等键对应不同最终字段时由 Gateway 冲突检查拒绝。
- [用户未及时确认导致记录未创建] → 保留待确认回复；不自动重试或代替用户批准。
- [模型或 Agent 处理慢导致积压] → VAD 队列继续有界且模型串行；Agent 入站按句提交，失败逐句报告。
- [扩展持有固定规范用户配置] → 仅允许 operator-controlled 配置，禁止从消息内容覆盖，并限定 P2P。
- [Agent 伪造或重放相关键提前释放队列] → 相关键无授权能力；卡片投递只绑定 Host 生成的 confirmation ID，释放还必须命中 Host resolved 事件、规范用户和 P2P 路由。
- [TTS 播放暂停设备麦克风/RTP] → 仅在完整切句已经本地落盘后播报短句“收到”；设备播放结束后按硬件服务约定恢复 RTP，不影响已经完整接收的本句。
- [确认前持续说话造成结构化草稿积压] → 模型处理可继续，但 Agent 入站严格单飞且 FIFO 有界；超限失败关闭，不并发启动新确认。

## Migration Plan

1. 保留当前独立 `vad-service-cli --process --allow-external-upload` 作为音频诊断入口。
2. 新增默认关闭的 Bridge、配置模板、mapper/adapter 测试和 contract selftest。
3. 在测试环境配置规范用户、飞书 P2P、逻辑资源和字段映射，确认 Gateway Read/Write Operation 已发布。
4. 停止独立监听器，加载 Bridge，先用模拟结果验证入站与零直连，再用真实小环完成一次取消和一次确认 Create。
5. 可选启用 TTS 回执，先检查 `/healthz`，再验证本地完整 WAV 就绪后、方舟结果返回前只播报一次“收到”。
6. 回滚时禁用 TTS 回执或整个 Bridge 并恢复独立监听器；无 DB Schema 或 Gateway 契约迁移需要撤销。

## Open Questions

- 真实测试表的逻辑资源别名、字段名和字段类型需要由运营者填入 `.env`，不会提交到仓库。
- 一个数组拆到多个目标列仍需为每个列声明独立的唯一选择规则；本轮不支持一条语音生成多行 Record。

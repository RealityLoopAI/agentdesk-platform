## Context

`examples/xiaohuan-doubao-audio/` 已验证“WAV → 方舟 → `experiment-audio.v1`”。硬件现在负责“你好小环”唤醒、起止检测、拍照指令分流和提示音，并把普通完整语句以 HTTP WAV 上传到 macOS。平台已有完整的 Bitable Create 基础设施：Frontdesk/Worker 路由、Host 建立的 RequestIdentity、Gateway 能力发现与授权、字段 Schema 校验、同用户确认、稳定幂等、写后 `record.get` 和审计。

缺失的是两者之间的可信组合层。独立音频进程若直接调用 Gateway，会缺少 Host 建立的规范用户身份并形成平行业务写入路径；若直接调用飞书 API，则会把物理凭证和表标识扩散到音频服务。Bridge 必须作为 operator-controlled Host Channel 扩展运行，通过正常入站路由把结构化结果交给 Agent。

## Goals / Non-Goals

**Goals:**

- 在同一 Host 生命周期内接收硬件上传的整句 WAV，并复用现有方舟处理器。
- 把每个通过 Schema 校验的 `experiment-audio.v1` 结果映射为目标字段锁定的部分候选草稿，并允许 Worker 在实时表 Schema 内进行有证据的语义归一化。
- 使用配置的规范用户、飞书 P2P 路由和逻辑资源产生正常 Host 入站事件。
- 复用现有 Bitable Worker/Gateway 的发现、授权、确认、创建、幂等、写后读取和审计。
- 单句失败隔离、常驻 HTTP 监听、有界队列、安全日志和默认不启用。
- 严格实现硬件约定的 `POST /api/audio`、WAV 格式限制和 `GET /healthz`。
- 由硬件负责唤醒、切句和所有本地提示音；本机不调用设备 TTS。
- 当前 Bridge 草稿的确认流程结束前，不向同一会话投递后续语句。
- 区分“Agent turn 已结束”和“确认流程已结束”，使未产卡、Provider 失败和正常产卡都能终止当前草稿状态。
- 对可重试的上游模型失败进行同源幂等的有界重试，并保证所有错误回复仍绑定原始入站消息。
- 按完整模型请求而非仅 transcript 管理上下文预算，避免语音入口复用长会话后触发超大请求。

**Non-Goals:**

- 不从声音、transcript、设备 IP 或模型结果识别用户。
- 不让 Bridge 直连飞书 Bitable、持有 app token/table ID 或调用 Gateway `/execute`。
- 不实现独立人工纠错 UI、Update/Delete/Batch，也不把模型自报置信度当成事实保证。
- 不支持多设备动态认领、群聊身份映射或无人值守绕过确认。
- 不把实验字段名或表结构硬编码进平台核心。
- 不在本机实现唤醒、语义门控、VAD、提示音或 TTS 回执。

## Decisions

### 1. 使用 operator-specific Host Channel 扩展作为可信组合层

新增 `examples/xiaohuan-bitable-bridge/`。扩展由现有 fork-free loader 加载，在 `setup()` 中启动一个可中止的整句 HTTP/WAV/方舟服务，在 `teardown()` 中停止接收并排空已接受工作。每个模型结果通过 `ChannelSetup.onInboundEvent` 投递到配置的飞书 P2P messaging group。

事件使用运行时配置的 `authenticatedUserId`，且启动时要求用户、P2P platform ID 和逻辑资源全部存在。设备与用户的绑定属于运营者部署信任，不从 Agent 可见的 message content 读取。选择扩展而不是 CLI socket，是为了避免把写入错误归因给 `cli:local`，并使回复、确认和审计继续属于真实 P2P 用户。

### 2. 使用整句 HTTP WAV 入口取代 RTP/VAD

Bridge 在 `0.0.0.0:50020` 提供 `POST /api/audio` 与 `GET /healthz`。请求体必须是原始 WAV 字节，不接受 JSON、multipart、chunked body 或旁路身份元数据。入口要求 `Content-Type: audio/wav` 和明确 `Content-Length`，最多 4 MiB，并校验 PCM、16-bit little-endian、16 kHz、单声道、非空且不超过配置时长。校验成功后以临时文件 + fsync + 原子 rename 落盘，进入容量默认为 8 的单工方舟队列，再返回 `202`。

入口对完整 WAV 字节计算 SHA-256，以摘要派生稳定 capture ID，并用有界进程内集合识别硬件重试。相同字节流重复 POST 返回成功但不再次排队；队列已满时返回非 2xx，让硬件按自己的最多三次策略重试。`createAudioPipeline` 继续负责 WAV 上限复核、方舟调用和 `experiment-audio.v1` Schema 校验。

Bridge 默认关闭。启用但缺少方舟 Key、固定身份、P2P 路由、逻辑资源或字段映射时，扩展失败关闭且不监听 TCP。仍要求对方舟外部上传和 Agent 投递分别显式授权。旧 SDP、FFmpeg、VAD 和 TTS 环境变量不再属于 Bridge 配置。

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

真实联调发现方舟可能忠实转写“批次测试十号”，但仍把 `sampleIds` 返回为空。为避免
关键批次字段依赖第二个 Agent 补偿，Bridge 还支持配置化 transcript 标记选择器：

- `{ "field": "批次", "selector": "text-after-marker", "markers": ["批次"] }`：
  仅允许配置在 `transcript` 源路径上，从唯一一次精确 marker 后读取到下一个句读符的
  非空连续短语。例如“批次测试十号，使用离心机”确定性得到“测试十号”。

marker 数量、长度和结果字节数均有界；值由下一个句读符或 transcript 末尾封闭；
零命中、多命中或空短语时不猜测。
候选草稿省略该字段，完整草稿失败关闭。该选择器只声明显式文本边界，不进行同音纠正、
别名翻译或自由文本重抽取。

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

### 7. 硬件拥有唤醒、切句和本地反馈

设备只在唤醒后发送普通完整语句。拍照指令由设备本地处理且不上传；普通语句的“登”
等反馈也由设备完成。本机不再调用 `POST /api/tts/speak`，不根据 HTTP 接收、方舟、
确认或写表结果控制硬件播报。这样设备录音状态机与云端耗时解耦，也避免本机 TTS
插播影响下一次唤醒。

### 8. 用确认生命周期事件实现有界单飞草稿队列

Bridge 在向 Host 提交一个结构化草稿前把它标记为 active，后续模型结果进入容量不超过
HTTP 音频队列上限一致的 FIFO 队列。Host 的 `gateway-confirmation-delivered` 事件用相关键、
可信用户和 P2P 路由把 active draft 绑定到 confirmation ID；Host 在批准、拒绝、过期
或失败后再发出不承载授权语义的 `gateway-confirmation-resolved` 观察事件。

Bridge 只有在 resolved 事件的 confirmation ID、可信用户和路由全部匹配时才释放 active
并投递下一条。若某个 Agent 流程始终没有产生确认卡，则 active 在与确认上限一致的
15 分钟后安全释放，避免永久死锁；队列溢出时丢弃新草稿并记录内容安全错误，不绕过单飞。
关闭服务时停止投递排队草稿，不等待人工确认。

### 9. 把 Agent turn 终态作为独立的 Host 观察事件

Runner 在每个可信入站 turn 结束时写出带 `in_reply_to` 的
`agent-turn-resolved` system action，状态为 `completed`、`provider-failed`、
`cancelled` 或 `timed-out`。Host 将其转换为只读进程内事件，携带 session、
原始入站消息 ID、错误分类和 retryable 标志；它不承载授权能力，也不能代替确认。

Bridge 的 active draft 使用两阶段状态：`processing` 等待 Agent turn 结果；
若收到匹配的 confirmation delivered，则进入 `awaiting-confirmation` 并继续等待现有
resolved 事件；若 turn 正常结束且短暂 settle 窗口内没有确认卡，则释放当前草稿；
若 turn 失败则进入重试或失败终态。选择独立终态事件而不是缩短 15 分钟确认超时，
是为了避免慢 Agent 的迟到确认卡与下一句重叠。

### 10. Provider 失败采用相关键稳定、attempt ID 唯一的有界重试

Runner 的 provider error、用户可见错误、`/clear` 回执和 turn 终态消息都必须携带
当前 `turnRouting.inReplyTo`，确保 Host 可把错误投递到原始飞书会话，并让 Bridge
可靠关联本次尝试。

Bridge 对 `gateway_5xx`、`server_5xx`、`timeout` 和 `rate_limited` 最多追加两次
重试，默认退避 5 秒和 30 秒。重试保留相同 capture、request fingerprint 和最终
Create 幂等来源，但每次 Host 入站使用唯一 attempt message ID，避免消息去重吞掉重试。
不可重试错误或耗尽重试后释放 active，报告内容安全错误并继续 FIFO 下一句。

### 11. 上下文保护按完整 OpenAI 请求预算触发

OpenAI provider 在发送请求前计算 transcript、system instructions 和序列化 tools 的
总字符预算。总量超过可配置阈值时，先压缩旧 transcript；压缩失败或压缩后仍超限时，
按扣除 system/tools 固定开销后的剩余预算硬裁剪 transcript。这样语音 turn 即使落入
已有会话，也不会因为只检查 transcript 而把超大请求直接交给上游。

独立的 machine-ingress Frontdesk/session 仍是推荐部署拓扑，但本轮不引入第二条身份或
Gateway 路径；在该拓扑完成前，完整请求预算是兼容现有飞书 P2P 绑定的运行时保护。

## Risks / Trade-offs

- [Host 扩展与参考 Python 接收器同时绑定 TCP 50020] → 切换到 Bridge 前必须停止参考接收器；启动端口冲突时失败关闭。
- [配置字段映射与真实表 Schema 漂移] → Worker/Gateway 每次按现有 TTL 策略发现并校验 Schema；失败不写入。
- [数组序列化不适合目标字段类型] → 文本字段继续使用 join/JSON；单选和数字字段只使用显式 action-target/measurement-value 选择器，并由 Gateway 校验最终类型与选项。
- [语义归一化把错误语音改成合法但错误的值] → 仅允许已配置目标字段、原始证据和实时 Field List 候选；禁止猜测数字/单位，歧义停止；最终结果仍须由原用户查看确认卡后批准。
- [Worker 重试产生不同归一化结果] → 指纹绑定原始证据和映射计划；同一幂等键对应不同最终字段时由 Gateway 冲突检查拒绝。
- [用户未及时确认导致记录未创建] → 保留待确认回复；不自动重试或代替用户批准。
- [模型或 Agent 处理慢导致积压] → HTTP 音频队列有界且模型串行；队满返回非 2xx，由硬件执行有界重试；Agent 入站按句提交，失败逐句报告。
- [扩展持有固定规范用户配置] → 仅允许 operator-controlled 配置，禁止从消息内容覆盖，并限定 P2P。
- [Agent 伪造或重放相关键提前释放队列] → 相关键无授权能力；卡片投递只绑定 Host 生成的 confirmation ID，释放还必须命中 Host resolved 事件、规范用户和 P2P 路由。
- [无鉴权 HTTP 入口被非设备调用] → 仅绑定可信实验室局域网地址，不映射公网；严格限制方法、路径、类型、长度和 WAV 格式，身份仍只来自 operator 配置而非网络来源。
- [HTTP 成功响应丢失导致设备重试] → 对完整 WAV 字节做稳定摘要去重，相同 payload 不产生第二个模型/Agent/写表意图。
- [确认前持续说话造成结构化草稿积压] → 模型处理可继续，但 Agent 入站严格单飞且 FIFO 有界；超限失败关闭，不并发启动新确认。
- [Agent 正常结束但未产确认卡导致队列卡住] → turn 终态后保留短 settle 窗口；未绑定确认才释放，迟到或无关事件不能推进队列。
- [上游 5xx 重试造成重复写入] → 保持 request fingerprint/Create 幂等来源不变，只改变 attempt message ID；确认和 Gateway 幂等仍是最终防线。
- [system/tools 本身占用大量上下文] → 预算计算覆盖完整请求；固定开销已经超过阈值时失败关闭并报告配置问题，而不是无限裁剪用户输入。

## Migration Plan

1. 保留硬件同事提供的 Python HTTP 接收器作为 capture-only 诊断入口，但不得与 Bridge 同时绑定 TCP 50020。
2. 将 Bridge 接收层从 RTP/VAD 切换到默认关闭的整句 HTTP WAV 服务，保留方舟、mapper、确认和 Gateway 链路。
3. 在测试环境配置规范用户、飞书 P2P、逻辑资源和字段映射，确认 Gateway Read/Write Operation 已发布。
4. 停止 Python 接收器和旧 RTP/VAD 监听器，加载 Bridge，先用 curl/fixture 验证 `/healthz`、上传、拒绝和去重，再用真实小环完成一次取消和一次确认 Create。
5. 验证硬件自行完成唤醒、切句与反馈，本机没有任何 TTS 请求。
6. 回滚时禁用 Bridge 并恢复 Python 接收器；无 DB Schema 或 Gateway 契约迁移需要撤销。
7. 部署 turn 终态和重试后，先以模拟 provider-failed/无确认完成事件验证队列推进，再开启真实小环连续五句测试。
8. 将旧语音会话执行一次 `/clear`；后续可把 Bridge 迁移到独立 machine-ingress Frontdesk/session，回复仍通过可信 `replyTo` 返回飞书。

## Open Questions

- 真实测试表的逻辑资源别名、字段名和字段类型需要由运营者填入 `.env`，不会提交到仓库。
- 一个数组拆到多个目标列仍需为每个列声明独立的唯一选择规则；本轮不支持一条语音生成多行 Record。

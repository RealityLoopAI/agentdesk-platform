## ADDED Requirements

### Requirement: Demo 以示例扩展形式启用
系统 SHALL 将小环音频能力作为 operator-specific 示例 Channel 扩展提供，默认不启用，且不得把小环设备、实验字段、固定用户或固定表逻辑硬编码到平台核心。

#### Scenario: Demo 未启用
- **WHEN** `XIAOHUAN_AUDIO_DEMO_ENABLED` 未设置为启用
- **THEN** 系统不启动音频接收进程且不监听 Demo UDP 端口

#### Scenario: Demo 配置完整
- **WHEN** 运营者启用 Demo 并提供批准的端口、来源 IP、规范用户、飞书 P2P 路由和 Bitable 逻辑资源
- **THEN** 系统通过既有 ChannelAdapter 扩展机制启动接收器且不修改核心 Channel 行为

### Requirement: 启动自检必须失败关闭
Demo 启用时，系统 MUST 在接收音频前验证所有必填配置、FFmpeg 能力、UDP 端口可用性、飞书流式 ASR 租户/权限前提和 P2P 目标约束；任一前提不满足时不得进入可接收状态。

#### Scenario: VLC 占用接收端口
- **WHEN** VLC 或其他进程已占用配置的 UDP 端口
- **THEN** Demo 启动失败并报告端口冲突，且不得悄悄改用其他端口

#### Scenario: 缺少 ASR Scope
- **WHEN** 飞书应用没有 `speech_to_text:speech` 或租户不支持流式语音识别
- **THEN** Demo 启动或预检失败，且不得接收会触发 Agent 的音频

#### Scenario: 目标不是 P2P
- **WHEN** 配置的平台路由是群聊或与固定用户不匹配
- **THEN** Demo 拒绝启动且不创建任何合成入站事件

### Requirement: 仅接收批准来源的 RTP Opus
Demo SHALL 只在配置的 UDP 端口接收批准来源 IP 的 RTP 音频，并 SHALL 按受支持的 Opus 48 kHz、20 ms 帧输入解码为 PCM S16LE 16 kHz 单声道。来源 IP 只用于接收白名单，不得用于确定用户身份。

#### Scenario: 批准设备发送音频
- **WHEN** 配置来源 IP 通过配置端口发送符合约定的 RTP/Opus 数据
- **THEN** Demo 将其解码和重采样为 16 kHz 单声道 PCM 供 VAD 与 ASR 使用

#### Scenario: 未批准来源发送数据
- **WHEN** 与配置来源 IP 不同的主机向接收端口发送 RTP 数据
- **THEN** Demo 忽略或中止该输入、记录安全事件，且不启动 ASR 或 Agent turn

#### Scenario: 输入格式不受支持
- **WHEN** RTP Payload 或 Opus 参数无法按配置解码
- **THEN** Demo 中止当前 capture 并返回可诊断错误，且不把损坏音频交给 ASR

### Requirement: VAD 将音频切分为有界话语
Demo SHALL 使用可配置的能量 VAD 开始话语，并在连续静音达到默认 1200 ms 或话语达到默认最长 20 秒时结束；同一时间 MUST 最多存在一个活跃话语和一个 ASR 流。

#### Scenario: 语音后出现足够静音
- **WHEN** 已开始的话语后连续静音达到配置阈值
- **THEN** Demo 正常结束该话语并向 ASR 发送结束动作

#### Scenario: 话语超过最长时长
- **WHEN** 活跃话语达到配置的最长时长
- **THEN** Demo 有界结束或中止该话语、释放内存缓冲，且不继续无限收集音频

#### Scenario: 第二段语音与活跃流重叠
- **WHEN** 一个 ASR 流尚未结束又检测到新的开始条件
- **THEN** Demo 不创建第二个并发流，并按确定性单流策略合并、忽略或中止输入

### Requirement: 飞书流式 ASR 协议必须有序
Demo SHALL 把 PCM 聚合为 100–200 ms 分片并通过飞书流式语音识别发送。每句话 MUST 使用合法的 16 字符 `stream_id`、从 0 开始连续递增的 `sequence_id`、`format=pcm`、`engine_type=16k_auto`，以及 `action=1/0/2` 表达开始、继续和正常结束。

#### Scenario: 正常识别一句话
- **WHEN** VAD 检测到一段可正常结束的有效话语
- **THEN** 第一片使用 `sequence_id=0, action=1`，中间片按序使用 `action=0`，最后一片使用下一 sequence ID 和 `action=2`

#### Scenario: 本地或远端识别异常
- **WHEN** 解码、网络、超时、限流或 ASR 响应错误使流无法正常完成
- **THEN** Demo 在可行时发送 `action=3`、清理该流，且不发布最终 transcript 或触发 Agent

#### Scenario: sequence 状态非法
- **WHEN** 待发送分片缺失、重复或产生不连续 sequence ID
- **THEN** Demo 中止该流且不得尝试用乱序请求继续识别

### Requirement: 只有正常结束的最终文本可触发下游
系统 MUST 只使用 `action=2` 正常结束后取得的最终识别文本进行唤醒判断。部分文本、中间响应、中止流和失败流不得创建 Agent turn 或业务写入。

#### Scenario: ASR 返回中间文本
- **WHEN** `action=1` 或 `action=0` 请求返回识别文本
- **THEN** Demo 不向用户发布该文本且不触发 Agent

#### Scenario: ASR 正常返回最终文本
- **WHEN** `action=2` 成功并返回非空最终识别文本
- **THEN** Demo 将该文本交给确定性唤醒词过滤

#### Scenario: ASR 流被中止
- **WHEN** 当前流以 `action=3` 或错误结束
- **THEN** 系统不把该流的任何文本作为最终文本使用

### Requirement: 唤醒词确定性门控
Demo SHALL 在最终文本进入 Agent 前执行确定性前缀匹配。只有归一化后的最终文本以配置唤醒词开头且唤醒词后包含非空实验描述时，系统才可创建入站事件。

#### Scenario: 用户说出唤醒词和实验信息
- **WHEN** 最终文本为“记录实验”开头且后续包含非空描述
- **THEN** Demo 移除唤醒词并把剩余原文作为受控 Agent 输入

#### Scenario: 环境谈话没有唤醒词
- **WHEN** 最终文本不以配置唤醒词开头
- **THEN** Demo 不发送飞书消息、不创建 Agent turn 且不调用 Bitable Gateway

#### Scenario: 只有唤醒词
- **WHEN** 最终文本在移除唤醒词和允许的标点/空白后为空
- **THEN** Demo 不创建业务 Agent turn，并可向固定 P2P 用户发送不含业务写入的简短提示

### Requirement: 音频入口绑定固定可信身份
Demo MUST 只把通过所有门控的 transcript 路由给运营者配置的既有规范用户和匹配飞书 P2P 会话。设备 IP、transcript、姓名、邮箱和 Agent 推断 MUST NOT 创建、选择、关联或改变用户身份。

#### Scenario: 固定映射有效
- **WHEN** 批准设备产生有效唤醒 transcript 且配置用户与 P2P 路由匹配
- **THEN** Host 为该固定规范用户创建入站请求，并按既有身份信任链传播 `origin_user_id`

#### Scenario: 固定用户不存在
- **WHEN** 配置的规范用户无法在 Host 中解析
- **THEN** Demo 拒绝 transcript 且不自动创建新用户或猜测替代身份

#### Scenario: transcript 声称来自其他用户
- **WHEN** 音频内容包含另一用户的姓名或 ID
- **THEN** 系统仍只使用运营者配置的固定规范用户，不改变身份上下文

### Requirement: Agent 只能提取原文明确的实验信息
系统 SHALL 要求 Agent 只从最终 transcript 明确出现的内容提取实验字段，不得臆造缺失或不确定值。目标表字段 MUST 通过既有 Gateway Describe 和 Field Schema 发现及校验。

#### Scenario: transcript 包含完整字段
- **WHEN** Agent 能把原文明确内容映射到批准逻辑表的有效字段
- **THEN** 系统生成一份待确认的 Record Create 预览

#### Scenario: 必填字段缺失
- **WHEN** transcript 缺少目标 Schema 的必填信息
- **THEN** 系统在固定 P2P 会话向用户追问，且不得在补齐前提交 Create

#### Scenario: Agent 产生未知字段
- **WHEN** 提取结果包含 Schema 中不存在或不可写的字段
- **THEN** Gateway 校验拒绝该草稿且不进行部分写入

### Requirement: 创建记录前必须取得 P2P 用户明确确认
系统 MUST 在固定飞书 P2P 会话展示目标逻辑资源和字段预览，并且只有绑定的同一规范用户明确确认后才可调用 Bitable `record.create`。取消、超时、群聊响应或其他用户响应不得写入。

#### Scenario: 用户确认预览
- **WHEN** 固定 P2P 用户明确确认当前新增预览
- **THEN** Worker 通过 `gateway_authorize` 和 `gateway_execute` 对批准逻辑资源调用 `record.create`

#### Scenario: 用户取消
- **WHEN** 固定 P2P 用户取消当前预览
- **THEN** 系统关闭草稿且 Bitable 中不新增记录

#### Scenario: 确认超时
- **WHEN** 预览超过配置有效期仍未得到固定用户确认
- **THEN** 系统使草稿失效且后续迟到响应不得触发写入

#### Scenario: 群聊或其他用户尝试确认
- **WHEN** 确认来自群聊或与固定规范用户不匹配的身份
- **THEN** 系统拒绝确认且不调用 `record.create`

### Requirement: 创建必须幂等、写后校验并可审计
每个确认后的 Create MUST 使用稳定幂等键，并 MUST 在成功后通过 `record.get` 校验结果。用户回复和审计证据 SHALL 能关联规范请求者、逻辑资源、record ID、幂等键和安全 input hash，不得包含凭证或原始音频。

#### Scenario: 首次确认创建成功
- **WHEN** Gateway 成功新增记录并且 `record.get` 校验通过
- **THEN** 系统向固定 P2P 用户返回成功状态和 record ID，并生成可关联审计证据

#### Scenario: 相同逻辑请求重试
- **WHEN** 同一规范用户、逻辑资源和归一化草稿以相同幂等键重放
- **THEN** Gateway 返回首次提交结果且表中恰好存在一条对应记录

#### Scenario: 创建成功但写后读取失败
- **WHEN** `record.create` 返回成功但 `record.get` 未能完成校验
- **THEN** 系统不得宣称完整校验成功，并向用户返回可诊断的待核验状态而不重复创建

### Requirement: 原始音频不得持久化
Demo MUST 只在完成当前分片、VAD 和 ASR 所需的最短内存周期内保留 PCM；不得把 RTP Payload、PCM、Base64 音频或不受控的完整 transcript 写入文件、数据库、审计或常规日志。

#### Scenario: 一句话正常完成
- **WHEN** ASR 返回最终结果或唤醒词过滤结束
- **THEN** Demo 释放该 capture 的原始音频缓冲且磁盘上不存在录音副本

#### Scenario: 一句话异常中止
- **WHEN** 解码、VAD、ASR 或进程异常中止 capture
- **THEN** Demo 同样释放原始音频缓冲，并只记录不透明 capture ID、时长、字节数和安全错误类别

#### Scenario: 日志级别提高
- **WHEN** 运营者启用 debug 日志
- **THEN** 日志仍不得包含原始音频、Base64 音频、App Secret、Access Token 或不受限完整 transcript

### Requirement: Demo 范围外操作必须被拒绝
Demo SHALL 仅支持一个配置设备、一个活跃流、一个固定 P2P 用户、一个批准逻辑表和 Record Create。系统 MUST 拒绝通过该 Demo 请求 Record Update、Delete、Batch、任意表选择、群聊流程或音频回放。

#### Scenario: 语音请求修改或删除记录
- **WHEN** transcript 要求 Update、Delete 或 Batch
- **THEN** Agent 说明 Demo 仅支持新增且不调用对应 Gateway 写 Operation

#### Scenario: 语音指定未批准表
- **WHEN** transcript 包含原始 app token、table ID 或另一个表名
- **THEN** 系统仍只允许配置的逻辑资源，并拒绝任意资源选择

#### Scenario: 请求回放录音
- **WHEN** 用户要求播放或下载刚才的原始音频
- **THEN** 系统说明 Demo 不保留原始音频且不生成回放文件

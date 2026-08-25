## 1. 基线与联调决策

- [x] 1.1 按仓库指南运行 `pnpm typecheck && pnpm test`，记录并隔离任何既有失败后再开始实现
- [ ] 1.2 用当前 `@larksuiteoapi/node-sdk` 完成最小 ASR spike，验证 `streamRecognize` 的请求形状、租户权限、最终响应以及 `recognition_text` 的增量/累积语义
- [x] 1.3 与运营者确定 Demo 使用的 Bitable 逻辑资源别名、必填字段和测试数据，确保真实 token、table ID、用户 ID 与凭证不进入仓库
- [x] 1.4 为“Host 侧示例音频 Channel + FFmpeg 子进程 + 固定 Demo 身份映射”的架构选择新增 ADR，并更新 `docs/decisions/README.md`

## 2. 示例扩展与配置

- [x] 2.1 在 `examples/xiaohuan-audio-demo/` 建立 Channel 扩展清单、入口模块、README 和不含秘密的环境配置样例
- [x] 2.2 实现类型化配置解析，覆盖 enabled、UDP 端口、来源 IP、规范用户、P2P platform ID、逻辑表别名、唤醒词、VAD 静音和最长话语参数
- [x] 2.3 实现失败关闭启动校验：缺失配置、非 P2P 路由、用户/路由不匹配、端口冲突、FFmpeg/codec 缺失或 ASR 预检失败时不得监听
- [x] 2.4 将扩展接入既有 fork-free ChannelAdapter 加载方式，并验证未启用时不创建进程、socket、session 或 Agent turn
- [x] 2.5 为配置默认值、非法边界值、未启用状态和所有失败关闭分支添加单元测试

## 3. RTP/Opus 接收与 PCM 管道

- [x] 3.1 实现只接受配置来源 IP 和 UDP 端口的 RTP 输入描述/接收边界，并拒绝不匹配来源
- [x] 3.2 实现受控 FFmpeg 子进程，将 RTP/Opus 48 kHz 输入解码和重采样为 PCM S16LE 16 kHz 单声道 stdout
- [x] 3.3 实现 FFmpeg stdout 背压、stderr 安全错误解析、非零退出处理、重启上限和 Host 关闭时的资源释放
- [x] 3.4 实现 PCM 帧聚合器，稳定输出 100–200 ms ASR 分片并正确处理任意 stdout 字节边界
- [x] 3.5 为有效 RTP/Opus、损坏 payload、错误来源、任意 PCM 分块和 FFmpeg 异常建立无敏感数据的测试 fixture 与自动化测试

## 4. VAD 与话语生命周期

- [x] 4.1 实现可配置能量 VAD、短内存预卷缓冲和“未开始/活跃/正常结束/中止”状态机
- [x] 4.2 实现默认 1200 ms 连续静音结束、默认 20 秒最长话语限制和单活跃话语约束
- [x] 4.3 确保正常结束、中止、超时和异常路径都释放 PCM/预卷缓冲，并为下一句话恢复干净状态
- [x] 4.4 添加 VAD 单元测试，覆盖环境静音、短促噪声、正常语音、静音结束、超长语音和重叠开始条件

## 5. 飞书流式语音识别

- [x] 5.1 封装飞书 ASR 客户端，固定 `format=pcm`、`engine_type=16k_auto` 并生成合法的 16 字符 stream ID
- [x] 5.2 实现严格 sequence/action 状态机：首片 `0/1`、中间片连续 `n/0`、正常末片 `n/2`、异常中止 `n/3`
- [x] 5.3 仅把正常 `action=2` 的非空最终识别结果暴露给下游，隔离所有部分文本和中间响应
- [x] 5.4 实现有界超时、限流/网络/鉴权错误分类、中止和单 ASR 流并发控制，不进行忙循环
- [x] 5.5 使用模拟 SDK 响应测试正常流、空结果、sequence 不连续、超时、限流、鉴权失败、action 3 和 cleanup

## 6. 唤醒词、身份与 Channel 入站

- [x] 6.1 实现最终文本的最小标点/空白归一化及确定性前缀唤醒词过滤，只传递唤醒词后的非空原文
- [x] 6.2 实现固定规范用户与飞书 P2P platform ID 校验，明确禁止从来源 IP、transcript 或 Agent 推断身份
- [x] 6.3 通过 `onInboundEvent` 创建合成 Channel 入站事件，保留安全 source/capture/stream 元数据并沿用 Host RequestIdentity、`origin_user_id` 与 HMAC 信任链
- [x] 6.4 构造受控 Agent 输入，要求只提取转写中明确出现的实验信息、缺失字段先追问、只准备批准逻辑表的 Record Create
- [x] 6.5 添加测试覆盖无唤醒词、仅唤醒词、有效唤醒词、伪造其他用户、未知规范用户、P2P 不匹配和群聊目标拒绝
- [x] 6.6 运行 Channel Adapter contract selftest，验证扩展加载、入站回调、停止和错误隔离符合平台契约

## 7. Agent 与多维表格确认闭环

- [x] 7.1 在示例拓扑中把音频入站路由到既有 Frontdesk 和专用 Bitable Worker，不在平台核心加入实验室业务分支
- [x] 7.2 复用 Gateway Describe/Field Schema，对 Agent 提取字段执行存在性、类型、必填和可写校验，并在缺失/不确定时向固定 P2P 用户追问
- [x] 7.3 复用 P2P Create 预览/确认流程，确保确认只接受同一规范用户，取消、超时、群聊或其他用户响应都不写入
- [x] 7.4 为确认后的 `record.create` 生成稳定幂等键，并在成功后调用 `record.get` 校验记录
- [x] 7.5 向 P2P 用户返回清晰的取消、待补充、成功 record ID、待核验或失败结果，并关联安全 audit ID
- [x] 7.6 在示例能力和工具边界中拒绝 Update、Delete、Batch、原始 app token/table ID 和未批准逻辑资源
- [x] 7.7 添加模拟端到端测试：有效 transcript → 字段预览 → 取消时零记录
- [x] 7.8 添加模拟端到端测试：有效 transcript → 确认 → 恰好一条记录 → `record.get` 校验 → 审计与用户回复
- [x] 7.9 添加幂等重试、缺失字段追问、非法字段、未授权用户、未批准资源、Create 成功但 Get 失败和范围外操作测试

## 8. 隐私、可观测性与恢复

- [x] 8.1 对 RTP payload、PCM、Base64 音频、飞书凭证和完整 transcript 建立日志/错误红线，确认 debug 模式也不会输出这些内容
- [x] 8.2 仅暴露不透明 capture ID、阶段、时长、字节数、丢包/中止计数、ASR 延迟和安全错误类别等有界指标
- [x] 8.3 验证正常完成、FFmpeg 崩溃、ASR 失败、Host shutdown 和扩展 reload 后均无录音文件、遗留缓冲、孤儿进程或占用端口
- [x] 8.4 添加日志捕获与临时目录扫描测试，断言所有成功/失败路径均不持久化原始音频和凭证

## 9. macOS 运行手册与真实演示

- [x] 9.1 在示例 README 记录 macOS 安装/验证 FFmpeg、查看本机 IP、防火墙状态、UDP `50020` 占用/监听和关闭 VLC 冲突的命令
- [x] 9.2 记录小环已知 RTP 参数、网络连通检查、飞书非免费租户与 `speech_to_text:speech` 审批、固定 P2P 用户和逻辑表配置步骤
- [x] 9.3 提供不写表的分层冒烟流程：RTP 到达 → FFmpeg PCM → VAD → ASR 最终文本 → 唤醒词过滤
- [x] 9.4 提供真实 Demo 检查表，验证无唤醒词不触发、取消不新增、确认恰好新增一行、回复 record ID、写后校验和相同请求不重复
- [ ] 9.5 用实际小环设备、测试飞书用户和测试 Bitable 表完成一次端到端演练，记录现场 VAD 阈值、总延迟和已知限制但不提交真实标识/音频

## 10. 最终验证与交付

- [x] 10.1 运行新增单元、集成、Adapter contract 和模拟端到端测试，并修复所有回归
- [x] 10.2 运行仓库完整 `pnpm typecheck && pnpm test`，确认身份信任链、org 隔离、三 DB 单写者和 Gateway isolation 测试保持通过
- [x] 10.3 对照 `xiaohuan-feishu-audio-demo` 的每个 Scenario 建立测试或演示证据，确认不存在未覆盖的规范要求
- [x] 10.4 更新相关示例/架构文档和会话交接说明，并运行 `openspec validate add-xiaohuan-feishu-audio-demo --strict`

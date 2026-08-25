## 1. Bridge 配置与字段映射

- [x] 1.1 建立 `examples/xiaohuan-bitable-bridge/` 示例、环境变量模板、TypeScript 配置和默认关闭入口
- [x] 1.2 实现固定规范用户、飞书 P2P、逻辑资源、持续上传授权和复用 VAD/方舟参数的失败关闭配置解析
- [x] 1.3 实现闭合集合源路径、唯一目标字段、空值省略、有界 join/canonical JSON 的确定性字段 mapper
- [x] 1.4 实现规范化 SHA-256 fingerprint 和稳定 Create 幂等提示（fingerprint 输入在 1.7 扩展为不可变原始证据与 mapping）
- [x] 1.5 扩展字段映射规则，支持按精确动作名唯一提取 target、按精确测量名与可选单位唯一提取 value，并对零/多匹配失败关闭
- [x] 1.6 增加默认关闭的设备 TTS 回执配置，校验局域网端点、播报文本和超时且不接受凭证
- [x] 1.7 实现空值/未解析选择器可省略的部分候选 mapper、规范 fieldMapping 和绑定原始证据的稳定 fingerprint

## 2. Host Channel Bridge

- [x] 2.1 实现符合 ChannelAdapter contract 的 `xiaohuan-bitable` 扩展及自注册入口
- [x] 2.2 在 Adapter setup/teardown 中组合现有持续 VAD、方舟 pipeline、AbortSignal、队列排空和临时文件清理
- [x] 2.3 将有效结果包装为有版本、受控资源和字段草稿的 Feishu P2P `onInboundEvent`
- [x] 2.4 对单句模型失败、映射失败和 Host 入站失败进行内容安全的失败隔离，禁止直接 Gateway/Feishu Bitable 调用
- [x] 2.5 实现确认卡投递事件、Bridge 待回执 fingerprint 登记和幂等 TTS HTTP 202 客户端，回执失败不影响确认状态
- [x] 2.6 扩展 Bridge envelope，携带目标锁定的 fieldMapping 和 partial fields，未解析字段仍进入可信 Host 入站
- [x] 2.7 将“收到”回执移动到本地完整 WAV 校验完成、方舟处理开始前，并改用 run + capture 派生幂等键
- [x] 2.8 增加 Host 确认 resolved 观察事件，并实现跨确认生命周期的有界单飞 FIFO 草稿队列

## 3. Agent 与 Gateway 约束

- [x] 3.1 为 Bridge 消息定义受控指令，要求 Describe/Field List/Authorize/同用户确认/Create/Get 验证流程
- [x] 3.2 更新实验 Frontdesk/Bitable Worker 示例提示，识别 Bridge envelope、禁止重抽取和未批准资源，并使用稳定 fingerprint 幂等
- [x] 3.3 增加守卫测试，确认 Bridge 不接受物理 app/table 标识、Bitable 凭证或任意运行时用户覆盖
- [x] 3.4 为 Bridge Create 确认透传无授权语义的 requestFingerprint 相关键，并保持其他确认工作流兼容
- [x] 3.5 更新 Bitable Worker：基于原始证据和实时 Field List 修复唯一同音/近音选项与明确漏提取文本，歧义和缺失数字失败关闭

## 4. 测试与文档

- [x] 4.1 添加配置和 mapper 单元测试，覆盖有效映射、未知源、重复目标、空值、数组编码、大小上限和稳定 fingerprint
- [x] 4.1a 添加选择器测试，覆盖动作/测量唯一命中、可选单位、零匹配、多匹配、空 target/null value、无单位换算和单选原值保持
- [x] 4.2 添加 Adapter 测试，覆盖默认关闭、contract、正常结果到可信入站、单句失败继续和 teardown
- [x] 4.3 添加模拟端到端测试，证明一条 Ark 结果只产生一个固定资源 Create 意图，取消为零写入，确认后使用稳定幂等并 Get 验证
- [x] 4.4 编写 macOS 运行手册，说明独立监听器与 Bridge 端口互斥、配置、启动、停止、隐私和真实表联调步骤
- [x] 4.5 运行专项测试、示例类型检查、平台 typecheck、安全守卫和 OpenSpec strict validation
- [x] 4.6 添加配置、TTS 客户端、相关键、匹配/不匹配/重复卡片和失败隔离测试，并更新运行手册
- [x] 4.7 添加“测试四号/列路测试”真实错误 transcript 回归、部分草稿/指纹/提示守卫测试并更新运行手册
- [x] 4.8 添加早期 WAV 回执、确认排队/释放/超时/溢出和 resolved 事件测试，并更新运行手册与 ADR

## 5. 真实联调

- [x] 5.1 使用真实小环和方舟生成一条 Bridge 入站，并记录不含完整 transcript/凭证的安全证据
- [ ] 5.2 在用户提供测试表逻辑资源与字段映射后，完成一次取消和一次确认 Create，核对 record ID、Get 结果与 audit ID
- [x] 5.3 检查真实设备 healthz，并验证旧版确认卡时序可触发一次“收到”回执（已由 5.4 的提前时序取代）
- [x] 5.4 旧版本机“收到”播报验收已取消；硬件提示音与本机链路解耦，连续语句串行仍由 6.x 回归覆盖

## 6. Agent 终态、重试与上下文保护

- [x] 6.1 Runner 为 provider error、用户错误、`/clear` 回执和 turn 终态补齐可信 `in_reply_to`，并发出可分类的 `agent-turn-resolved` system action
- [x] 6.2 Host 注册只读 Agent turn 终态观察事件，按 session 与原始入站消息 ID 向 Bridge 提供 completed/provider-failed 关联
- [x] 6.3 Bridge 实现 processing/awaiting-confirmation 两阶段状态、短 settle 窗口、无确认正常释放和无关事件隔离
- [x] 6.4 Bridge 对可重试 provider 失败实现最多两次 5 秒/30 秒退避，保持 fingerprint 稳定并使用唯一 attempt message ID
- [x] 6.5 OpenAI provider 按 transcript + system instructions + tools 的完整请求预算触发压缩和动态硬裁剪，固定开销超限时失败关闭
- [x] 6.6 添加 Runner/Host/Bridge/provider 回归测试，覆盖连续五句、502、无确认完成、迟到确认、重试耗尽、错误路由和完整请求预算
- [x] 6.7 更新运行手册与 ADR，执行 typecheck、全量测试和 OpenSpec strict validation

## 7. 硬件整句 HTTP WAV 接入

- [x] 7.1 新增 ADR 并更新 proposal/design/spec，记录 TCP 50020 `POST /api/audio` 取代 UDP RTP/VAD、本机移除 TTS、硬件拥有唤醒/切句/反馈的边界
- [x] 7.2 实现整句 HTTP 接收服务：严格请求/WAV 校验、4 MiB 与约 60 秒上限、原子落盘、健康检查、有界串行方舟队列、内容摘要去重和优雅停止
- [x] 7.3 将 Bridge 配置与 Adapter 切换到 HTTP 服务，移除 SDP/FFmpeg/VAD/TTS 生产依赖和环境变量，同时保留固定身份、方舟、草稿串行、确认与 Gateway 链路
- [x] 7.4 更新专项测试、`.env.example` 和 macOS 运行手册，覆盖正常上传、非法请求、重复上传、队满、单句失败隔离、teardown 和无 TTS
- [ ] 7.5 使用真实小环完成“硬件唤醒 → 整句 HTTP WAV → 方舟 JSON → 确认卡/多维表格”的人工联调，并保存不含音频、完整 transcript 或凭证的安全证据

## 8. 批次漏提取修复

- [x] 8.1 在字段映射契约中增加仅限 transcript 的 `text-after-marker` 确定性选择器，零/多命中和空短语失败关闭
- [x] 8.2 更新方舟提示词，明确 `sampleIds` 对“批次测试十号”等批次标记语句的提取要求
- [x] 8.3 更新部署样例、真实 Bridge 字段映射和运行文档，使用 marker 选择器生成“批次”
- [x] 8.4 添加真实句式、非法配置、歧义、末尾边界和提示词回归，并运行专项测试、typecheck 与 OpenSpec strict validation

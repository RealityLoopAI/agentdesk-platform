## 1. 基线与架构契约

- [ ] 1.1 运行 `pnpm typecheck && pnpm test`、Runner Typecheck/Test 和 OpenSpec 严格校验，记录变更前基线
- [ ] 1.2 为 Host-mediated Gateway 确认签发路径新增 ADR，明确身份来源、Preview/Token Binding、Nonce、过期、单写者和唯一 Gateway 业务授权路径
- [ ] 1.3 更新 Gateway Wire Contract，加入可选 `/confirmation/issue` 请求/响应 Schema，并确保旧 Gateway 返回 404 时 Update 保持 Fail Closed
- [ ] 1.4 定义结构化 Query、Order、Update Preview、Record Fingerprint 和 Confirmation Binding 的机器可校验 Schema 与 Fixture

## 2. 安全结构化 Record Query

- [ ] 2.1 在 `record.list` 输入契约中增加单层 `query` 和 `orderBy`，限制最多 10 个 Condition、3 个排序项和封闭操作符集合
- [ ] 2.2 实现基于 Field Schema 的字段存在性、Operator Matrix、值类型和单选选项校验，未知组合在飞书调用前返回 `VALIDATION_FAILED`
- [ ] 2.3 实现结构化 Query/Order 到飞书 `/records/search` Payload 的转换，拒绝所有原生 Filter 字符串和 Provider Payload 字段
- [ ] 2.4 保持 `filterAlias`/`sortAlias` 向后兼容，并拒绝它们与结构化 Query/Order 的歧义组合
- [ ] 2.5 将 Resource、View、字段投影、Query 和 Order 纳入不透明 Cursor Binding，增加跨查询重放负向测试
- [ ] 2.6 增加响应页大小、字段投影、字节上限和 `hasMore` 测试，证明 Gateway 不先把全表多页内容交给模型筛选
- [ ] 2.7 扩充 Descriptor、Conformance Fixture、参考 Gateway 文档和 Adapter 测试，覆盖布尔、单选、文本、数值和日期条件

## 3. Gateway Update Preview、指纹与提交

- [ ] 3.1 实现 Record 规范化和稳定 Fingerprint，覆盖 `recordId`、完整 Fields 与 Provider 可用的修改时间/版本元数据且不把明文写入审计
- [ ] 3.2 让 `record.update` 的 `dryRun=true` 读取当前 Record、校验 Patch，并返回 Gateway 生成的 Before/After Diff、Fingerprint、Binding Hash、opaque `confirmationRequest` 和 `auditId`
- [ ] 3.3 把所有单条 `record.update` 改为必须携带确认 Token，保留 `highImpactFields` 作为风险标签而非普通字段豁免
- [ ] 3.4 将确认 Binding 扩展为规范用户、Agent Group、Operation、Resource、`recordId`、Patch Hash、Fingerprint、有效期和 Nonce
- [ ] 3.5 在 committing Update 中先命中幂等 Replay，再验证确认、重新读取并比较 Fingerprint；不一致返回 `CONFLICT` 且不写飞书
- [ ] 3.6 将 Update 幂等 Binding 绑定目标、Patch 和 Fingerprint但排除不稳定 Token，覆盖相同请求 Replay 与同 Key 重绑定冲突
- [ ] 3.7 Update 成功后按 `recordId` Get 核验最终字段，并返回 Update/Get 的 `auditId` 与核验状态
- [ ] 3.8 增加普通字段无确认、错误用户、错误 Record/Patch、过期、Nonce 异 Key 重用、指纹变化和成功重放测试

## 4. Host-mediated 用户确认

- [ ] 4.1 设计并迁移 Host 持有的待确认记录，绑定 Session、规范用户、来源路由、Preview、过期和状态；不得由容器直接写 Central DB
- [ ] 4.2 新增 `gateway_request_confirmation` Runner 工具，让容器只提交 Gateway opaque Request 和展示数据，并通过既有 outbound 消息协议交给 Host
- [ ] 4.3 Host 消费确认意图时重新解析可信 Session 用户并创建 Pending；Agent 自报用户、Operation、Resource 或 Binding 不作为授权事实
- [ ] 4.4 在飞书和 Web 渲染 Gateway 原始 Diff/字段摘要，按钮与文本确认每次都重新校验 Actor 为原请求者
- [ ] 4.5 用户确认后由 Host signing proxy 调用 Gateway `/confirmation/issue`，Gateway 验证 opaque Request、用户、Agent Group 和有效期后签发一次性 Token
- [ ] 4.6 将成功 Token、拒绝、取消或过期结果通过现有交互响应路径返回等待中的 Worker，且日志、审计和 UI 不泄漏 Token
- [ ] 4.7 为跨用户群聊确认、重复点击、过期、Host 重启恢复、Gateway 404、签名失败和容器伪造 Preview 增加 Fail-Closed 测试
- [ ] 4.8 让单条 Create 的现有确认进入同一用户绑定的 Host Pending 流程，但保持本轮低风险 Create 不强制 Gateway Update Token

## 5. Worker、试点策略与声明式行为

- [ ] 5.1 更新 Bitable Worker Prompt，使用精确 `field.list`、带结构化条件的 `record.list`、`record.get`、`record.create` 和 `record.update`
- [ ] 5.2 在 Worker 中强制零匹配返回、多匹配或 `hasMore=true` 请求选择、唯一且完整匹配才进入 Update Preview，禁止默认第一条
- [ ] 5.3 强制 Worker 展示 Gateway 返回的 Create 摘要或 Update Diff，等待 Host 确认结果后再提交，并在成功后 Get 核验
- [ ] 5.4 将 `feishu.bitable.record.update` 加入 `pilot.records.allowedOperations`，保持 `readers:["*"]`、`writers:["*"]` 和 Delete/Batch 关闭
- [ ] 5.5 增加 Prompt/拓扑/Agent Eval，覆盖自然语言组合查询、零/单/多候选、确认修改、猜测 Delete/Batch 和原生 Filter 注入
- [ ] 5.6 运行拓扑协调脚本同步当前 Worker 配置，并用新的内部 Worker 会话加载 Prompt 和契约

## 6. 纵向测试与真实飞书验收

- [ ] 6.1 增加 Mock 飞书 Query/Create/Update E2E，覆盖字段校验、分页、稳定幂等、Preview Binding、指纹冲突和提交后 Get
- [ ] 6.2 增加真实容器 Frontdesk → Worker → Host 确认 → Gateway E2E，证明 A2A 后仍是 `requesterSource=session` 和原规范用户
- [ ] 6.3 从真实飞书 P2P 执行“未完成 + P1 + 本周截止”结构化 Query，验证只返回匹配的有界记录与审计
- [ ] 6.4 从真实飞书 P2P 确认新增一条安全测试记录，用同一幂等键 Replay 并 Get 核验没有重复 Record
- [ ] 6.5 从真实飞书 P2P 通过唯一目标、Gateway Diff 和绑定确认修改该测试记录，Replay 后 Get 核验最终字段
- [ ] 6.6 在确认后模拟外部修改，验证 Update 返回 `CONFLICT`、不覆盖新值并要求重新预览
- [ ] 6.7 在飞书群聊验证 Query 可读、写入必须展示目标/Diff，且另一用户不能确认原请求者的 Create/Update
- [ ] 6.8 在 Web 打开同一 Lane，确认 Query/Create/Update 只显示用户请求和最终 Agent 回复，无 A2A 重复、跨渠道回环或错误用户气泡
- [ ] 6.9 关联 Host 与 Gateway Audit，核对规范用户、Operation、Resource、Input Hash、Binding Hash、Fingerprint 结果、幂等键和 `auditId`

## 7. 文档、发布与质量门

- [ ] 7.1 更新 Backend Gateway、参考 Adapter 和飞书多维表格运维文档，说明结构化 Query、Operator Matrix、Preview/Confirmation、群聊规则和回滚顺序
- [ ] 7.2 明确参考 Gateway 的幂等、Nonce 与确认使用状态仍是进程内存，记录生产持久化、Provider 条件写入、Secret Manager 和细粒度权限为后续生产化工作
- [ ] 7.3 运行 Host/Web/Runner Typecheck、全量测试、Reference Gateway 测试、Conformance、Lint 和 OpenSpec 严格校验
- [ ] 7.4 按 Query Read → Confirmation Broker → Update 白名单顺序重启/发布，检查健康、签名代理、飞书长连接、指标和无未签名 Gateway Group
- [ ] 7.5 在 `verification.md` 记录真实 Query/Create/Update、Replay、Conflict、群聊负向、Web 历史和审计证据

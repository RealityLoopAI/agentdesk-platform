## Context

`enable-feishu-bitable-record-query-create-update` 已经实现结构化 List、单条 Create、Gateway-owned Update Preview、记录指纹、Host-mediated 用户确认和提交后 Get 核验。参考 Adapter 虽然存在直接 `record.delete` Provider 调用和遗留 v1 确认原语，但 Agent 没有可信方式取得该 Token；Delete 也没有 Gateway 生成的记录预览、确认后指纹冲突检测或删除后核验，因此试点策略正确地没有发布它。

本变更需要跨 Runner 契约、参考 Gateway、Host Broker、飞书/Web 展示、Worker Prompt、资源配置和真实飞书验收。它必须保留 Gateway 唯一业务访问路径、规范用户与 A2A 身份链、三 DB 单写者、群聊保守写入和 Provider ID 不进入模型上下文等既有边界。

## Goals / Non-Goals

**Goals:**

- 为单条 Record Delete 提供与 Update 同等级的 Gateway Preview、Host 用户确认、指纹冲突检测、稳定幂等和结果核验。
- 让自然语言 Delete 只在唯一且完整匹配时进入预览，绝不默认选择第一条。
- 将运营者指定的真实表格映射为逻辑资源，并从真实飞书 P2P 跑通 Query/Create/Get/Update/Delete。
- 真实验收只删除本轮创建、带唯一测试标记且已核验 `recordId` 的记录。

**Non-Goals:**

- 不开放 Batch Delete、Batch Update、批量事务或任意 Provider Filter。
- 不允许 Agent 传入原始 App/Table/View ID。
- 不把测试流程扩展成可以绕过确认的“自动清理”后门。
- 不修改平台核心以硬编码某个真实表、字段名或公司的业务逻辑。
- 不把参考 Gateway 的进程内幂等、Nonce 或确认使用状态宣称为生产持久化。

## Decisions

### 1. Delete 使用独立的 Gateway-owned v2 Preview

`feishu.bitable.record.delete` 支持 `dryRun=true`。Gateway 授权后读取完整 Record，计算稳定 `expectedRecordFingerprint`，并返回：

- `recordId`
- 有界的当前 `fields`
- `expectedRecordFingerprint`
- `bindingHash`
- opaque `confirmationRequest`
- `expiresAt`
- `auditId`

Preview 的 purpose 使用 `bitable-delete-preview`，不复用遗留的、可由服务侧直接铸造的 v1 Delete Token。Host 只展示 Gateway 原始字段摘要并回传 opaque Request；Agent 不能修改展示内容后仍获得有效 Token。

真实 P2P 验收发现外部模型可能改写 opaque Request 的 HMAC 字符串。Runner 因此在当前 MCP Session
的有界 TTL Cache 中保存完整 Gateway Preview，只向模型返回去掉 opaque Request 的展示 Preview；
确认时按 Binding Hash 查找并比较全部展示字段，匹配后才把缓存的原始 Request 写入 Host Outbound。
缓存丢失、过期或任一字段漂移都要求重新 Preview。该修正由 ADR-0078 记录。

**Alternatives considered:**

- 继续使用遗留 v1 `issueConfirmation`：没有可信用户交互入口，也不绑定当前记录内容，拒绝。
- 只显示 `recordId`：用户无法判断删的是哪条业务记录，拒绝。
- 让 Worker 自行读取并生成删除摘要：摘要与最终 Token 不可验证地漂移，拒绝。

### 2. Delete Confirmation Binding 不伪造 Patch

Delete Binding 使用 v2 结构：

- `requesterUserId`
- `agentGroupId`
- `operation=feishu.bitable.record.delete`
- `resource`
- `recordId`
- `expectedRecordFingerprint`
- `exp`
- `nonce`

它不包含虚构的 `patchHash`。签发后的 Token purpose 为 `bitable-delete-confirmation`；Update v2 格式保持不变，避免扩大回归面。Nonce 仍只能绑定一个稳定幂等键，Token 不进入卡片、Web API、日志或审计。

### 3. 提交顺序为 Replay → Token → Fingerprint → Delete → Not Found

提交 Delete 时：

1. 先按不含不稳定 Token 的绑定查询幂等 Store；完全相同请求直接返回首次结果。
2. 验证 Token 的用户、组、Operation、资源、Record、指纹、有效期和 Nonce。
3. 重新 Get 并比较当前指纹；变化时返回 `CONFLICT`，不删除。
4. 调用飞书单条 Delete。
5. 再 Get；只有明确 `NOT_FOUND` 才报告 `verification.verified=true`。
6. 保存稳定幂等结果和 Delete/Get `auditId`。

Provider 不提供条件 Delete 时，重读与 Delete 之间仍有很小 TOCTOU 窗口；参考实现如实记录，不承诺强锁。

### 4. Host Broker 扩展 `delete`，不增加新授权路径

Runner `gateway_request_confirmation` 新增 `kind=delete`，只接受 Gateway Delete Preview。Host Broker：

- 从 Host-written inbound 重新解析原请求者和来源路由。
- 持久化 `kind=delete` Pending，复用现有单写者 Central DB 表；通过向前迁移扩展数据库 `kind` 检查约束并保留既有 Pending 数据。
- 在飞书/Web 展示 recordId 和 Gateway 字段摘要。
- 只允许原请求者确认。
- 经 Host signing proxy 调用既有 `/confirmation/issue`。
- 只把短期 Token写回等待中的 Worker 私有 inbound 结果。

数据库 `kind` 原有 `update/create` 检查约束，需要一次保留数据的表重建迁移以加入 `delete`；列结构不变。TypeScript、解析器、渲染器和测试同步扩展，Create 低风险流程保持原状。

### 5. Worker 对 Update/Delete 共用唯一目标闸

Delete 之前必须满足 `items.length === 1 && hasMore === false`，然后按 `recordId` Get，再请求 Delete Preview。零匹配直接报告；多匹配或还有下一页时列出有界候选并要求用户选择。Worker 不接受标题近似匹配或“第一条”。

真实验收生成 `AgentDesk CRUD E2E <timestamp>-<random>` 唯一标记；只把该轮 Create 返回并再次 Get 验证的 `recordId` 交给 Delete。测试脚本不会枚举或清理其他记录。

### 6. 真实表格只以逻辑资源暴露

用户提供的 App/Table/View ID 写入忽略提交的 `.env`，映射为业务无关的逻辑别名和 `viewAlias`。Tracked 示例只描述结构，不保存真实 Provider ID。Worker 通过最新 `gateway_describe` 和 `field.list` 选择字段；Prompt 不硬编码真实字段。

### 7. 发布顺序与回滚

发布顺序：

1. Gateway/契约/Mock 测试支持 Delete Preview，但资源白名单仍关闭 Delete。
2. Host/Runner/Web 支持 `kind=delete`，完成跨用户、过期和伪造预览负向测试。
3. 更新 Worker Prompt 和拓扑，刷新 Worker Session。
4. 在忽略提交的真实资源配置中最后加入单条 Delete。
5. 重启 Gateway，再重启 Host；完成只读 Schema/Query 后再做显式确认的真实写入。

回滚时先从真实资源 `allowedOperations` 移除 Delete，再回滚 Worker Prompt；Host Broker 可以保留对旧 Pending 的拒绝/过期处理。必要时关闭全部 Write，Read 保持可用。

## Risks / Trade-offs

- **[真实表字段类型未知]** → 先只读 `field.list`，根据 Provider Schema 生成合法测试 Fields；不猜字段类型或选项。
- **[误删业务记录]** → 测试只使用本轮 Create 返回且唯一标记匹配的 `recordId`；删除前再次 Get、展示完整摘要并要求用户确认。
- **[确认后记录变化]** → Delete 提交前重读指纹，不一致 Fail Closed。
- **[删除后 Get 的瞬时一致性]** → 只做有界核验；非明确 `NOT_FOUND` 返回可重试失败，不宣称删除已验证。
- **[模型泄漏 Provider ID]** → 真实 ID 仅在 Gateway `.env`；Descriptor、Prompt和审计使用逻辑别名/Hash。
- **[飞书 P2P 必须真人发消息]** → 自动化先覆盖到真实 Provider Adapter；最终入口由用户发送明确测试指令，Host/Gateway 日志与审计由本轮同步核对。
- **[参考 Store 重启丢状态]** → 真实生命周期在一次 Gateway 进程内完成；生产化仍需持久化幂等和 Nonce。

## Migration Plan

1. 运行基线 Typecheck/Test 和 OpenSpec 严格校验。
2. 落契约、Gateway Delete Preview/Commit/Verify 和 Mock 生命周期测试。
3. 扩展 Host/Runner/Web 确认面及真实容器 E2E。
4. 更新 Worker、拓扑和运维文档。
5. 只读发现真实表 Schema，写入逻辑资源配置并按 Gateway→Host 顺序重启。
6. 由真实飞书 P2P 完成唯一测试记录 CRUD，关联审计后记录证据。

## Open Questions

- 真实表中哪些字段可写、哪些是必填或单选，将通过只读 `field.list` 在实施阶段确定。
- 飞书删除后的 Record Get 是否立即返回明确 Not Found；若 Provider 存在短暂延迟，核验采用多大有界重试窗口由真实只删除测试记录的结果决定。
- 群聊跨用户真实负向验收仍需要第二个飞书账号；若不可用，保留 Host E2E 为自动门并把真人双账号证据标为待完成。

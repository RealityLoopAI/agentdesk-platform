## Context

当前 `pilot.records` 已发布 `field.list`、`record.list`、`record.get` 和 `record.create`，并由专用 Bitable Worker 经 Frontdesk 委派访问。参考 Adapter 已有通用 `record.update`、Field Schema 校验、稳定幂等和高影响字段确认原语，但试点没有发布 Update，List 只接受运营者预配置的 `filterAlias`/`sortAlias`，确认 Token 也没有可供真实用户流程使用的 Host 可信签发路径。

本变更跨 Runner 契约、参考 Gateway、Host 交互、Worker Prompt、飞书/Web 展示和真实 Bitable 验收。实现必须保留以下边界：

- 所有业务读取、授权、确认绑定和写入继续经过 Backend Gateway。
- Host 验证的规范用户身份和 A2A `origin_user_id` 传播不得弱化。
- Agent 不能看到飞书凭证、原始资源 ID，也不能提交原生飞书 Filter。
- 飞书群聊不能因为共享上下文而扩大写权限。
- Central DB/inbound.db/outbound.db 的单写者约束保持不变。

## Goals / Non-Goals

**Goals:**

- 让自然语言查询下推为 Schema 校验过的结构化条件，只把匹配的有界结果返回模型。
- 让自然语言修改可靠地处理零匹配、唯一匹配和多匹配。
- 完成单条 Create 的同用户确认、稳定幂等和提交后读取验收。
- 完成所有单条 Update 的 Gateway 规范预览、绑定确认、指纹冲突检测、稳定幂等和提交后读取。
- 从飞书机器人真实入口验收 Query/Create/Update，并在 Web 同一 Lane 中正确展示。

**Non-Goals:**

- 不开放 Delete、任何 Batch Operation 或任意原生飞书 Filter。
- 不实现跨多条 Record 的事务。
- 不把参考 Gateway 的进程内幂等、Nonce 或确认状态升级为生产持久化；生产 Gateway 仍必须使用持久存储。
- 不承诺 Provider 不支持条件写入时的强锁或串行化隔离。
- 不新增业务特定字段、固定表结构或公司专属流程到平台核心。

## Decisions

### 1. 扩展 `record.list`，不新增 `record.query`

在既有 `feishu.bitable.record.list` 输入中增加可选：

```json
{
  "query": {
    "conjunction": "and",
    "conditions": [
      { "field": "是否已完成", "operator": "eq", "value": false },
      { "field": "优先级", "operator": "eq", "value": "🟡P1-一般" }
    ]
  },
  "orderBy": [
    { "field": "截止日期", "direction": "asc" }
  ]
}
```

第一版只支持单层 `and|or`、最多 10 个 Condition 和 3 个排序项。封闭操作符为：

- 通用：`eq`、`ne`、`isEmpty`、`isNotEmpty`
- 文本：`contains`、`notContains`、`startsWith`
- 数值/日期：`gt`、`gte`、`lt`、`lte`

Gateway 先获取 Field Schema，再验证字段存在、操作符适用于字段类型、值类型正确、单选值存在。验证通过后 Adapter 才转换为飞书 `/records/search` Filter。`filterAlias`/`sortAlias` 继续兼容运营者预配置查询，但不得与结构化 `query`/`orderBy` 同时出现，避免不透明组合语义。`viewAlias` 可以与二者任一配合。

Cursor 的 Query Hash 加入 Resource、View、字段投影、Query 和 Order，防止跨查询重放。结构化查询默认页大小 20，仍受机器契约的全局上限约束。

**Alternatives considered:**

- 新增 `record.query`：会复制 List 的分页、字段投影、审计和错误契约，增加 Agent 选错 Operation 的概率，因此拒绝。
- 只增加更多 `filterAlias`：安全但无法覆盖终端用户临时组合条件，因此保留 Alias 同时增加封闭结构化 Query。
- 由模型拉取多页后筛选：过度暴露且不准确，明确拒绝。

### 2. 唯一目标由查询结果状态决定

Worker 用结构化 List 获取最小必要候选字段。只有 `items.length === 1 && hasMore === false` 才能直接进入 Update Preview：

- 0 条：返回未找到。
- 1 条且无更多页：读取该 `recordId`。
- 多条或 `hasMore=true`：展示有界候选，请原请求者选择 `recordId`。

Gateway 的 Update 契约继续强制要求精确 `recordId`，不接受自然语言标题或“第一条”作为目标。唯一性分流由 Worker Prompt、声明式 Eval 和容器 E2E 同时约束。

### 3. Update Preview 由 Gateway 生成

Worker 对 `feishu.bitable.record.update` 调用 `gateway_execute` 且 `dryRun=true`。Gateway：

1. 授权请求者、Operation、Resource 和 Record Scope。
2. 读取当前完整 Record。
3. 校验 Patch Field Schema。
4. 计算规范化 `expectedRecordFingerprint`。
5. 生成字段级 Before/After Diff。
6. 返回有期限的 opaque `confirmationRequest`、Binding Hash、Diff 和 `auditId`。

`confirmationRequest` 只包含签名绑定所需的标识和 Hash，不编码完整单元格明文。Worker 必须把 Gateway 返回的 Diff 原样用于确认展示，不能自行生成另一个显示版本。

**Alternative considered:** 由 Agent 读取旧值并自行计算 Diff。它不能保证显示内容与最终 Patch 一致，因此拒绝作为确认事实来源。

### 4. Host 收集确认，Gateway 签发执行 Token

新增 Host-mediated `gateway_request_confirmation` 交互工具和可选 Gateway `POST /confirmation/issue` 路径：

1. Agent 只能把 Gateway dry-run 返回的 opaque `confirmationRequest` 交给该工具。
2. Host 以待确认记录保存 Session、规范用户、来源路由、过期时间和 Preview 展示数据；写 Central DB 仍只由 Host 完成。
3. 飞书卡片或 Web 交互只有同一规范用户可以确认。
4. 确认后 Host 通过现有 Host signing proxy 调用 `/confirmation/issue`，携带 Host 重新解析的请求者身份和 opaque Request。
5. Gateway 验证 Request 签名、用户、Agent Group、有效期和绑定后，返回一次性 `confirmation` Token。
6. 等待中的 Tool 把 Token 返回 Worker；Worker 用它提交精确 Update。

执行 Token 绑定：

- `requesterUserId`
- `agentGroupId`
- `operation`
- `resource`
- `recordId`
- `patchHash`
- `expectedRecordFingerprint`
- `exp`
- `nonce`

Token 可以返回 Agent，因为它只能授权一项已展示的精确修改，并且有期限、一次性、绑定可信用户。审计只保存 Binding Hash，不保存 Token。

**Alternatives considered:**

- Host 直接签发 Token：需要把 Gateway 确认 Secret 共享给 Host或引入第二套公钥信任配置；让 Gateway 保持业务确认凭据所有权更符合唯一业务授权路径。
- 让 Agent 把“用户已确认”写进 `context`：Agent 可伪造，拒绝。
- 直接暴露 Adapter `issueConfirmation` 为 Agent Tool：会绕过用户交互，拒绝。

该新增路径改变 Host/Runner/Gateway 交互契约，实施时必须新增 ADR，并更新 Gateway 文档。

### 5. 所有单条 Update 均要求绑定确认

试点不再只对 `highImpactFields` 要求确认；任何 `record.update` 都必须使用上述 Token。`highImpactFields` 保留作为展示和未来审批策略的额外风险标签，但不是普通字段绕过确认的条件。

Create 继续采用现有低风险对话确认，但确认必须进入 Host 待确认状态并绑定同一规范用户；飞书群聊中其他成员的文本或按钮不能完成该请求。后续可以复用 Gateway Preview Token 统一 Create，当前不扩张范围。

### 6. Update 在提交前执行乐观冲突检测

Gateway 收到 committing Update 后按以下顺序处理：

1. 查询幂等 Store；完全相同的既有提交直接 Replay。
2. 校验确认 Token 与请求 Binding。
3. 重新读取完整 Record 并计算当前指纹。
4. 当前指纹与 `expectedRecordFingerprint` 不同则返回 `CONFLICT`，不写入。
5. 指纹相同才调用飞书 Update，保存幂等结果，然后按 `recordId` Get 核验。

指纹采用稳定 Canonical JSON，对 `recordId`、规范化 Fields 和 Provider 可用的修改时间/版本元数据哈希。完整值不写审计。

飞书没有条件 Update 时，步骤 3 到 5 之间仍存在很小的 TOCTOU 窗口。参考实现明确记录这个限制，不声称强锁；生产 Adapter 应优先使用 Provider ETag/版本条件或业务侧事务。

### 7. 试点白名单只增加 Update

`pilot.records.allowedOperations` 从 Field/List/Get/Create 增加
`feishu.bitable.record.update`。Delete、Batch 和其他元数据写入继续不发布。

`readers:["*"]`、`writers:["*"]` 暂时保持本轮用户要求的试点策略，但只有非空可信规范用户能读取，只有 `requesterSource=session` 且完成确认义务的用户能写入。群聊不会自动提升权限。

### 8. 纵向验收以飞书机器人为主入口

真实验收顺序：

1. 飞书 P2P 结构化 Query，确认只返回匹配记录。
2. 飞书 P2P Create，确认、提交、同 Key Replay、Get 核验。
3. 飞书 P2P Update，唯一目标、Gateway Diff、确认、提交、Replay、Get 核验。
4. 在确认后模拟外部修改，验证指纹 `CONFLICT`。
5. 飞书群聊由另一用户尝试确认，验证 Fail Closed。
6. Web 打开同一 Lane，确认只显示用户请求和最终 Agent 回复，无 A2A 重复或跨渠道回环。

每一步核对 Host `gateway_audit` 和 Gateway Audit 的规范用户、Operation、逻辑资源、Input Hash、确认 Binding Hash、幂等键、结果和 `auditId`。

## Risks / Trade-offs

- **[飞书字段类型与 Filter 语义不完全一致]** → 使用显式 Operator Matrix 和真实 Provider Fixture；未知类型或不支持操作符 Fail Closed。
- **[结构化 Query 仍可能返回敏感字段]** → 默认最小字段投影、页面上限和响应字节上限；Worker 只请求完成任务所需字段。
- **[多候选被模型误选]** → Prompt、Eval 和 E2E 强制 `hasMore=false` 且唯一候选，不接受“第一条”隐式选择。
- **[确认展示与执行漂移]** → Diff 由 Gateway dry-run 生成，Token 绑定 Patch Hash 与指纹。
- **[群聊用户串扰]** → Host 待确认记录绑定规范用户；每次按钮/文本确认重新解析 Actor。
- **[Token 泄漏给 Agent]** → Token 只授权单一精确 Binding，短 TTL、Nonce 一次性，且不同幂等键不可复用。
- **[确认后到提交仍有竞争窗口]** → 提交前重读并明确参考实现限制；生产 Adapter 使用 Provider 条件写入。
- **[参考 Gateway 重启丢失幂等和 Nonce]** → 文档继续标记为非生产；本轮不掩盖该限制，生产化另立变更。

## Migration Plan

1. 先提交 ADR、契约 Schema 和 Mock/负向测试，不修改试点 Operation 白名单。
2. 发布结构化 Query，只开启 Read；运行 Field/Operator/Cursor/响应边界和真实飞书 Query 验收。
3. 增加 Gateway dry-run Preview、Host 确认 Broker 和 `/confirmation/issue`，保持 Update 不可发现。
4. 通过 Container E2E、跨用户确认和冲突测试后，把 Update 加入试点资源并同步 Worker Prompt。
5. 完成飞书 P2P Create/Update 真实验收，再做群聊负向验收和 Web 历史回归。

回滚按风险从高到低：

1. 从 `allowedOperations` 移除 `record.update`，保留 Read/Create。
2. 关闭试点 Write；确认 Broker 可保留但不再产生新写请求。
3. 必要时停止接受结构化 Query，可继续使用既有无条件 List/Get 和运营者 Alias。
4. 最后关闭 Read。回滚不删除审计和已签发但未消费的确认记录；过期后自然失效。

## Open Questions

- 真实飞书表的日期字段在 Search API 中接受毫秒时间戳还是 RFC 3339，需要在实现第一阶段用只读 Fixture 和真实请求确定转换规则。
- 飞书 Search API 是否返回稳定的修改时间/版本字段；若没有，参考实现的指纹只覆盖完整规范化 Fields，并在文档中明确 TOCTOU 限制。
- 群聊跨用户负向验收需要第二个真实飞书测试账号；如果环境暂时没有，则先用 Host E2E 证明，再把真实双用户验收保留为发布门。

## ADDED Requirements

### Requirement: 自然语言删除必须确定唯一目标

Bitable Worker SHALL 先通过 Field-Schema 校验的结构化查询确定删除候选。零匹配时必须明确说明没有记录；多匹配或 `hasMore=true` 时必须展示有界候选并要求原请求者选择；只有唯一且完整的匹配结果才能按精确 `recordId` 读取并进入 Delete Preview。Worker MUST NOT 默认选择第一条候选。

#### Scenario: 删除条件没有匹配

- **WHEN** 用户要求删除的条件没有匹配任何 Record
- **THEN** Worker 报告零匹配且不调用 Delete Preview 或 Delete

#### Scenario: 删除条件匹配多条

- **WHEN** 用户的自然语言条件匹配多条 Record 或结果还有下一页
- **THEN** Worker 返回区分候选所需的最小字段和 `recordId`，等待用户选择且不删除任何 Record

#### Scenario: 删除条件唯一匹配

- **WHEN** 查询完整返回且只匹配一条 Record
- **THEN** Worker 按精确 `recordId` 读取当前记录并请求 Gateway Delete Preview

### Requirement: 单条 Delete 必须预览并绑定确认

Gateway SHALL 在 Delete Preview 阶段读取完整 Record、计算稳定记录指纹，并返回有界字段摘要、`recordId`、指纹、Binding Hash、opaque Confirmation Request、有效期和 `auditId`。每次提交 Delete 都 MUST 携带由可信确认服务签发的一次性凭据；凭据必须绑定规范请求者、Agent Group、Operation、逻辑资源、目标 `recordId`、预览时记录指纹、有效期和 Nonce。

Runner MUST 在 Session 私有缓存中保存 Gateway 原始 Update/Delete Preview，并在返回外部模型前移除 opaque Confirmation Request。确认工具只接受模型可见 Preview；只有 Binding Hash 命中缓存且其余展示字段逐项一致时，才能把缓存中的原始 Preview 交给 Host。缓存缺失、过期或展示漂移 MUST Fail Closed 并要求重新 Preview。

#### Scenario: 原请求者确认删除

- **WHEN** 原请求者在有效期内确认 Gateway 展示的精确 Record 摘要
- **THEN** Host 通过可信签发路径取得仅授权该 Record Delete 的短期凭据

#### Scenario: Agent 更换删除目标

- **WHEN** 提交 Delete 的 `recordId` 或资源与确认绑定不一致
- **THEN** Gateway 返回 `CONFIRMATION_REQUIRED` 且不调用飞书 Delete API

#### Scenario: 外部模型改写确认预览

- **WHEN** 模型提交的展示 Preview 与 Runner 缓存的 Gateway Preview 任一字段不同，或缓存已经丢失/过期
- **THEN** Runner 拒绝创建确认 Pending，opaque Confirmation Request 不进入模型上下文，并要求重新 dry-run

#### Scenario: 其他用户确认删除

- **WHEN** 群聊或共享上下文中的另一用户尝试确认原请求者的 Delete
- **THEN** Host 拒绝该确认，Record 保持不变

### Requirement: Delete 使用记录指纹检测确认后变化

Delete Preview SHALL 包含当前 Record 的 `expectedRecordFingerprint`。Gateway MUST 在提交前重新读取并比较指纹；不一致时必须返回 `CONFLICT` 且不删除。指纹一致时 Gateway 才可调用单条 Delete，并在提交后通过 Record Get 明确得到 `NOT_FOUND` 才报告核验成功。

#### Scenario: 确认后记录被修改

- **WHEN** 用户看到删除摘要后，目标 Record 在提交前发生变化
- **THEN** Gateway 返回冲突、保留 Record 并要求重新预览和确认

#### Scenario: 删除后核验成功

- **WHEN** 指纹匹配且飞书 Delete 提交成功，随后 Get 明确返回 `NOT_FOUND`
- **THEN** Gateway 返回 `deleted=true`、`verification.verified=true` 以及关联的 Delete/Get `auditId`

#### Scenario: 删除后状态无法确认

- **WHEN** Delete 返回成功但后续 Get 返回超时、限流或其他非 `NOT_FOUND` 错误
- **THEN** Gateway 不得宣称删除已核验，并返回结构化可重试失败

### Requirement: 真实表格只通过逻辑资源执行 CRUD

运营者指定的真实飞书 App、Table 和 View 标识 SHALL 只保存在 Gateway 运行时资源配置中，并映射为逻辑资源和 View 别名。Agent、Prompt、Web 客户端、飞书卡片、模型上下文和 Git 跟踪文件不得接收原始 Provider 标识或凭据。

#### Scenario: Agent 操作真实表格

- **WHEN** 真实飞书用户要求维护运营者已配置的表格
- **THEN** Worker 只使用 Describe 返回的逻辑资源、Field Schema 和具名 Operation

#### Scenario: Agent 提供原始表格 URL

- **WHEN** Agent 输入包含 App、Table 或 View 的原始 Provider 标识
- **THEN** Gateway 不把该标识当作授权资源，只有预配置逻辑别名可以解析

### Requirement: 真实飞书入口完成唯一测试记录 CRUD

发布 Delete 前 SHALL 从真实飞书 P2P 入口，用一个由本轮 Create、带唯一测试标记且已按 `recordId` Get 核验的 Record 完成 Query、Create、Update、Delete 和删除后不存在核验。测试流程 MUST NOT 修改或删除既有业务 Record，并 SHALL 关联 Host 与 Gateway Audit。

#### Scenario: 真实 P2P CRUD 生命周期

- **WHEN** 用户从真实飞书机器人依次确认新增、查询、修改和删除唯一测试记录
- **THEN** 每次调用都关联同一规范用户和逻辑资源，写入重放不重复提交，最终 Query/Get 不再返回该测试 Record

#### Scenario: 删除目标不是本轮测试记录

- **WHEN** 真实验收准备删除的 `recordId` 不是本轮 Create 返回并再次核验的唯一测试记录
- **THEN** 验收流程停止且不发出 Delete 提交

## MODIFIED Requirements

### Requirement: 试点只发布 Query Create Update

试点资源 SHALL 发布 Field/List/Get/Create/Update/Delete 所需的只读与单条写 Operation，并继续使全部 Batch Operation 不可发现、不可执行。`readers:["*"]` 与 `writers:["*"]` 只表示所有具有非空可信规范身份的用户可进入资源授权，不得绕过 Session 身份、Preview、确认、指纹冲突检测或群聊写入规则。

#### Scenario: 发现试点 Operation

- **WHEN** Worker 调用最新 `gateway_describe`
- **THEN** Bitable 目录包含 `field.list`、`record.list`、`record.get`、`record.create`、`record.update` 和 `record.delete`，不包含任何 Batch Operation

#### Scenario: 猜测 Batch

- **WHEN** Agent 直接请求未发布的 Batch Operation
- **THEN** Gateway 返回 `OPERATION_NOT_FOUND`，不调用飞书 API

### Requirement: 破坏性操作确认

Record Delete 和所有单条 Record Update SHALL 要求显式、可验证且有期限的确认；确认必须绑定规范请求者、Agent Group、资源、精确目标 Record、Operation、预期记录指纹，以及 Update 的精确 Patch。Delete 和 Update 提交前都必须重新读取记录并比较指纹。批量 Update/Delete 不在本轮试点开放范围内。

#### Scenario: 未确认删除

- **WHEN** Agent 未携带 Gateway Preview 对应的绑定确认就尝试删除 Record
- **THEN** Gateway 返回 `CONFIRMATION_REQUIRED` 且 Record 保持不变

#### Scenario: 未确认普通字段修改

- **WHEN** Agent 尝试修改普通字段但没有绑定确认
- **THEN** Gateway 同样返回 `CONFIRMATION_REQUIRED`，且不调用飞书 Update API

#### Scenario: 删除确认被用于另一条记录

- **WHEN** Agent 把一条 Record 的 Delete Token 用于另一个 `recordId`
- **THEN** Gateway 拒绝操作且两条 Record 都保持不变

### Requirement: 写操作幂等

Create、Update、Delete 及批量写操作 SHALL 要求或接收稳定幂等键；相同操作被重放时必须返回首次已提交结果。Update/Delete 的幂等绑定 SHALL 排除不稳定确认 Token 本身，但必须包含请求者、Operation、资源、`recordId`、预期记录指纹，以及 Update 的精确 Patch。

#### Scenario: Create 超时后重放

- **WHEN** 相同 Create 请求使用相同幂等键重试
- **THEN** Gateway 返回原始已提交 Record 结果，不创建重复行

#### Scenario: Delete 使用同一幂等键重放

- **WHEN** 相同目标和预期指纹的 Delete 使用同一稳定幂等键重试
- **THEN** Gateway 返回首次已提交且已核验的删除结果，不第二次调用飞书 Delete API

#### Scenario: Delete 幂等键被绑定到不同目标

- **WHEN** 调用方用同一幂等键删除不同 `recordId` 或使用不同预期指纹
- **THEN** Gateway 返回 `CONFLICT`，不执行新的删除

### Requirement: 多维表格审计

每次多维表格调用 SHALL 产生 Gateway 审计证据，包含规范请求者、Operation、逻辑资源别名、结果、耗时、写操作幂等键、安全的 Input Hash，以及 Update/Delete 的确认 Binding Hash、预期/当前指纹结果和核验 Audit 关联；不得保存确认 Token、Access Token、原始 Provider 标识或不受限的单元格明文。

#### Scenario: 多维表格 Delete 成功

- **WHEN** 经过绑定确认和指纹校验的 Delete 成功并完成 Not Found 核验
- **THEN** Host 与 Backend 审计可以关联请求者、Operation、逻辑资源、目标 Hash、幂等键、确认 Binding、指纹结果和 Delete/Get `auditId`

#### Scenario: Delete 因指纹冲突被拒绝

- **WHEN** Delete 提交前检测到 Record 已变化
- **THEN** 审计记录冲突结果和安全的预期/当前指纹，不记录完整单元格值

## ADDED Requirements

### Requirement: 自然语言查询转换为安全结构化条件
Bitable Worker SHALL 把自然语言查询意图转换为 `feishu.bitable.record.list` 的封闭结构化查询对象。Gateway MUST 根据当前 Field Schema 校验字段、操作符和值类型，并只把通过校验的条件转换为飞书查询表达式；Agent 提供的原生飞书 Filter 字符串或未声明字段必须在调用飞书前被拒绝。

结构化查询 SHALL 只允许有界的单层 `and` 或 `or` 条件集合、封闭操作符集合和有界排序字段集合，不得接受脚本、函数、嵌套任意表达式或原始 Provider Payload。Cursor MUST 绑定资源、字段投影、结构化条件和排序，不能在另一查询中重放。

#### Scenario: 查询未完成的 P1 任务
- **WHEN** 用户请求“查询所有未完成且优先级为 P1 的任务”
- **THEN** Worker 使用字段名、`eq` 操作符和类型正确的值构造结构化条件，Gateway 校验后只返回匹配的有界 Record 页面

#### Scenario: 查询本周截止任务
- **WHEN** 用户请求截止日期不晚于本周日的记录
- **THEN** Gateway 根据日期字段 Schema 接受类型正确的 `lte` 条件并转换为 Provider 查询

#### Scenario: Agent 提交原生飞书 Filter
- **WHEN** Agent 在查询输入中提交任意飞书 Filter 字符串、脚本或 Provider 字段名
- **THEN** Gateway 返回 `VALIDATION_FAILED`，不调用飞书 API

#### Scenario: Cursor 被用于不同查询
- **WHEN** Agent 把一个结构化查询返回的 Cursor 用于不同条件、排序或字段投影
- **THEN** Gateway 拒绝 Cursor，且不泄露下一页数据

### Requirement: 自然语言修改必须确定唯一目标
Bitable Worker SHALL 先通过结构化查询确定修改候选，再把唯一 `recordId` 交给 Update。零匹配时必须明确说明没有记录；多匹配或结果被截断时必须展示有界候选并要求用户选择；只有唯一且完整的匹配结果才能自动进入修改预览。Worker MUST NOT 默认选择第一条候选。

#### Scenario: 没有匹配记录
- **WHEN** 修改条件没有匹配任何 Record
- **THEN** Worker 报告零匹配且不调用 Update

#### Scenario: 匹配多条记录
- **WHEN** “把提交周报改为已完成”匹配多条 Record
- **THEN** Worker 返回区分候选所需的最小字段与 `recordId`，等待用户选择，且不修改任何 Record

#### Scenario: 唯一匹配记录
- **WHEN** 查询完整返回且只匹配一条 Record
- **THEN** Worker 按该 `recordId` 读取当前值并生成修改预览

### Requirement: 单条 Create 完成确认与核验闭环
Bitable Worker SHALL 在单条 Create 前发现 Field Schema、校验并展示逻辑资源与全部最终字段值，由同一规范用户明确确认后使用稳定幂等键提交。成功后 Worker SHALL 按返回的 `recordId` 重新读取记录，并只在字段一致时报告完成。

#### Scenario: 飞书私聊新增成功
- **WHEN** 可信飞书私聊用户确认了合法的单条新增预览
- **THEN** Gateway 创建一次 Record，重放稳定幂等键不产生第二条记录，Worker 返回 `recordId`、`replayed`、Create/Get `auditId` 和核验结果

#### Scenario: 新增确认来自其他用户
- **WHEN** 群聊或共享上下文中另一用户尝试确认原请求者的 Create
- **THEN** Host 不完成该待确认请求，Gateway 不执行写入

### Requirement: 单条 Update 必须预览并绑定确认
Bitable Worker SHALL 在单条 Update 前读取目标 Record，按 Field Schema 校验 Patch，并展示字段级 Before/After Diff。每次提交 Update 都 MUST 携带由可信确认服务签发的一次性凭据；凭据必须绑定规范请求者、Agent Group、Operation、逻辑资源、目标 `recordId`、精确 Patch Hash、预览时记录指纹、有效期和 Nonce。Agent/Prompt 自报的确认文字或自行构造的 Token 不得满足该义务。

#### Scenario: 用户确认精确修改
- **WHEN** 原请求者在有效期内确认了指定 Record 和字段 Diff
- **THEN** Host 通过可信确认签发路径取得绑定凭据，Gateway 只允许凭据所绑定的精确 Update

#### Scenario: Agent 在确认后更换字段值
- **WHEN** Update 的 `recordId` 或 Patch 与确认凭据绑定内容不一致
- **THEN** Gateway 返回 `CONFIRMATION_REQUIRED`，不调用飞书 Update API

#### Scenario: 确认过期或被其他请求使用
- **WHEN** 凭据已经过期，或其 Nonce 已被不同幂等键消费
- **THEN** Gateway 拒绝提交并要求重新预览和确认

### Requirement: Update 使用记录指纹检测确认后变化
Update 预览 SHALL 包含对当前 Record 规范化内容计算的 `expectedRecordFingerprint`。Gateway MUST 在提交前重新读取 Record 并比较指纹；不一致时必须返回 `CONFLICT`，不写入飞书，并要求重新生成 Diff 和确认。实现不得声称在 Provider 不支持条件写入时提供跨“重新读取到提交”窗口的强锁。

#### Scenario: 确认前记录被他人修改
- **WHEN** 用户看到 Diff 后，目标 Record 在提交前发生变化
- **THEN** Gateway 返回冲突、保留新值且不覆盖，并要求重新读取和确认

#### Scenario: 记录未发生变化
- **WHEN** 提交前重新读取的指纹等于确认绑定的指纹
- **THEN** Gateway 继续使用稳定幂等键执行单条 Update

### Requirement: 试点只发布 Query Create Update
试点资源 SHALL 发布 Field/List/Get/Create/Update 所需的只读与单条写 Operation，并继续使 Delete 和全部 Batch Operation 不可发现、不可执行。`readers:["*"]` 与 `writers:["*"]` 只表示所有具有非空可信规范身份的用户可进入资源授权，不得绕过 Session 身份、确认或群聊写入规则。

#### Scenario: 发现试点 Operation
- **WHEN** Worker 调用最新 `gateway_describe`
- **THEN** Bitable 目录包含 `field.list`、`record.list`、`record.get`、`record.create` 和 `record.update`，不包含 Delete 或 Batch

#### Scenario: 猜测 Delete 或 Batch
- **WHEN** Agent 直接请求未发布的 Delete 或 Batch Operation
- **THEN** Gateway 返回 `OPERATION_NOT_FOUND`，不调用飞书 API

### Requirement: 飞书群聊写入必须由发起者本人确认
飞书群聊中的结构化查询 MAY 在可信身份和资源授权通过后直接执行。Create 和 Update SHALL 展示精确目标与字段摘要或 Diff，并且只有原始请求者的可信确认可以完成写入；群上下文、机器人被提及或其他成员的确认不得扩大权限。

#### Scenario: 群聊查询
- **WHEN** 有读取权限的群成员请求结构化查询
- **THEN** Worker 返回有界结果，且不因此获得任何写入授权

#### Scenario: 其他群成员确认修改
- **WHEN** 用户甲发起 Update 而用户乙点击或发送确认
- **THEN** Host 拒绝将用户乙的确认应用到用户甲的待确认操作，Record 保持不变

### Requirement: 飞书来源完成真实 Query Create Update 验收
发布前 SHALL 从飞书机器人真实入口完成结构化 Query、单条 Create 和单条 Update，并验证身份、确认、幂等、冲突、提交后 Get 和审计链。Web SHALL 继续能够查看同一 Lane，且不得产生跨渠道重复投递或内部 A2A 消息泄漏。

#### Scenario: 飞书机器人纵向验收
- **WHEN** 真实飞书用户依次执行 Query、确认 Create、确认 Update 和 Get 核验
- **THEN** 每个 Gateway Audit 都关联同一规范用户、逻辑资源和 Operation，写入仅提交一次，最终字段与确认内容一致

## MODIFIED Requirements

### Requirement: 安全读取 Record
Record List/Get SHALL 支持有上限的分页、字段投影、配置允许的 Filter/View/Sort 别名，以及经 Field Schema 校验的结构化条件和排序，并限制适合 Agent 上下文的响应大小。结构化条件必须在 Gateway 内转换为 Provider 查询，不能通过 Agent 原样透传 Provider 表达式。

#### Scenario: 查询大表
- **WHEN** Record List 匹配数量超过配置的分页上限
- **THEN** Gateway 返回有界页面和绑定当前查询的不透明下一页 Cursor

#### Scenario: 结构化查询减少数据暴露
- **WHEN** 用户按字段条件查询大表中的少量记录
- **THEN** Gateway 在 Provider 查询层应用校验后的条件，只把有界匹配结果返回给 Agent，而不是先把全表多页内容交给模型筛选

### Requirement: 写操作幂等
Create、Update、Delete 及批量写操作 SHALL 要求或接收稳定幂等键；相同操作被重放时必须返回首次已提交结果。Update 的幂等绑定 SHALL 排除不稳定的确认 Token 本身，但必须包含请求者、Operation、资源、`recordId`、精确 Patch 和预期记录指纹，防止同一 Key 被重新绑定到不同修改。

#### Scenario: Create 超时后重放
- **WHEN** 相同 Create 请求使用相同幂等键重试
- **THEN** Gateway 返回原始已提交 Record 结果，不创建重复行

#### Scenario: Update 使用同一幂等键重放
- **WHEN** 相同目标、Patch 和预期指纹的 Update 使用相同幂等键重试
- **THEN** Gateway 返回首次 Update 结果，不第二次调用飞书写 API

#### Scenario: Update 幂等键被绑定到不同 Patch
- **WHEN** 调用方用同一幂等键提交不同字段值或不同目标 Record
- **THEN** Gateway 返回 `CONFLICT`，不执行新的写入

### Requirement: 破坏性操作确认
Record Delete 和所有单条 Record Update SHALL 要求显式、可验证且有期限的确认；确认必须绑定请求者、Agent Group、资源、目标 Record 集合、精确变更内容和预期记录版本或指纹。批量 Update 的既有高影响确认规则不在本轮试点开放范围内。

#### Scenario: 未确认删除
- **WHEN** Agent 未满足 Gateway 确认义务就尝试删除 Record
- **THEN** Gateway 拒绝操作且 Record 保持不变

#### Scenario: 未确认普通字段修改
- **WHEN** Agent 尝试修改未标记为高影响的普通字段但没有绑定确认
- **THEN** Gateway 同样返回 `CONFIRMATION_REQUIRED`，且不调用飞书 Update API

### Requirement: 多维表格审计
每次多维表格调用 SHALL 产生 Gateway 审计证据，包含规范请求者、Operation、逻辑资源别名、结果、耗时、写操作幂等键、安全的 Input Hash，以及 Update 的确认绑定哈希和指纹校验结果，但不得保存确认 Token、Access Token 或不受限的单元格明文。

#### Scenario: 多维表格 Update 成功
- **WHEN** 经过绑定确认和指纹校验的 Update 成功提交
- **THEN** Host 与 Backend 审计可以关联请求者、Operation、目标资源、`recordId`、幂等键、确认绑定和结果

#### Scenario: Update 因指纹冲突被拒绝
- **WHEN** Update 提交前检测到 Record 已变化
- **THEN** 审计记录冲突结果和安全的预期/当前指纹信息，不记录完整单元格值

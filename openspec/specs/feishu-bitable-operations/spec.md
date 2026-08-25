# feishu-bitable-operations Specification

## Purpose
TBD - created by archiving change add-web-feishu-unified-messaging. Update Purpose after archive.
## Requirements
### Requirement: 多维表格只能通过 Gateway 访问
Agent SHALL 只通过具名后端网关 Operation 访问飞书多维表格。飞书聊天 Adapter、Agent 容器、Web 客户端和 Prompt 文件不得保存多维表格凭证，也不得实现平行的业务访问路径。

#### Scenario: Agent 请求多维表格数据
- **WHEN** Agent 需要读取或修改多维表格记录
- **THEN** Agent 使用 `gateway_authorize` 后再调用 `gateway_execute` 或 `gateway_bulk_execute`

### Requirement: 可发现的多维表格 Operation
Gateway SHALL 在 Agent 声称具备能力之前，通过 Describe 接口声明支持的多维表格 Operation 及输入契约。最小 Operation 集必须覆盖 App/Table 元数据、Field Schema，以及 Record 的 List/Get/Create/Update/Delete 和受支持的批量操作。

#### Scenario: Gateway 不支持多维表格
- **WHEN** `gateway_describe` 没有声明所需多维表格 Operation
- **THEN** Agent 报告该能力不可用，且不得宣称操作成功

### Requirement: 资源白名单
Gateway SHALL 将稳定的逻辑资源别名映射到运营者批准的飞书 `app_token` 和 `table_id`。Agent 提供的原始 Token 或任意 Table 标识必须被拒绝，除非策略明确允许。

#### Scenario: 允许的逻辑表
- **WHEN** 有权限用户请求操作已配置的逻辑表别名
- **THEN** Gateway 将别名解析到批准的飞书资源，并在该范围内执行

#### Scenario: Agent 提供任意 App Token
- **WHEN** Agent 提供未批准的原始 `app_token` 或 `table_id`
- **THEN** Gateway 在调用飞书前拒绝请求

### Requirement: 每次调用都进行业务授权
Gateway SHALL 使用规范请求者、Operation、逻辑资源、Record Scope 和当前后端策略，对每个多维表格操作授权。Host Organization 成员资格不得代替业务授权。

#### Scenario: 用户没有写权限
- **WHEN** Session 可信用户请求创建 Record，但后端策略只授予读权限
- **THEN** 授权被拒绝，且不调用飞书写 API

#### Scenario: Agent-asserted 请求者尝试修改
- **WHEN** 多维表格写操作的 `requesterSource='agent-asserted'`
- **THEN** Gateway 默认拒绝该操作

### Requirement: 字段值校验
Gateway SHALL 获取或缓存目标 Table 的 Field Schema，并在写操作前校验字段名、类型、必填值和是否可写。

#### Scenario: 提交未知字段
- **WHEN** Create 或 Update 请求包含批准 Table Schema 中不存在的字段
- **THEN** Gateway 返回校验错误，且不进行部分写入

### Requirement: 安全读取 Record
Record List/Get SHALL 支持有上限的分页，以及配置允许的 Filter、View 或 Sort，并限制适合 Agent 上下文的响应大小。

#### Scenario: 查询大表
- **WHEN** Record List 匹配数量超过配置的分页上限
- **THEN** Gateway 返回有界页面和不透明的下一页 Cursor

### Requirement: 写操作幂等
Create、Update、Delete 及批量写操作 SHALL 要求或接收稳定幂等键；相同操作被重放时必须返回首次已提交结果。

#### Scenario: Create 超时后重放
- **WHEN** 相同 Create 请求使用相同幂等键重试
- **THEN** Gateway 返回原始已提交 Record 结果，不创建重复行

### Requirement: 破坏性操作确认
Record Delete 和配置为高影响的 Update SHALL 要求显式确认；确认必须绑定请求者、资源、目标 Record 集合和有效期。

#### Scenario: 未确认删除
- **WHEN** Agent 未满足 Gateway 确认义务就尝试删除 Record
- **THEN** Gateway 拒绝操作且 Record 保持不变

### Requirement: 批量操作语义
批量操作 SHALL 声明原子或 Best-effort 语义，限制 Record 数量，为每个请求 Record 返回索引对齐结果，并且部分提交时不得报告全部成功。

#### Scenario: Best-effort 批量操作部分失败
- **WHEN** Best-effort 批次中部分 Record 非法
- **THEN** 合法 Record 可以提交，失败索引返回结构化错误，并报告 `partial=true`

### Requirement: 飞书错误和限流处理
Gateway SHALL 将飞书认证、授权、校验、Not Found、Conflict、Timeout 和 Rate Limit 响应转换为平台封闭错误类型，并携带可重试属性及 Retry-after 信息。

#### Scenario: 飞书限流
- **WHEN** 飞书返回 Rate Limit 响应
- **THEN** Gateway 返回带有界 Retry-after 的可重试结构化错误，且不得忙循环

### Requirement: 多维表格审计
每次多维表格调用 SHALL 产生 Gateway 审计证据，包含规范请求者、Operation、逻辑资源别名、结果、耗时、写操作幂等键和安全的 Input Hash，但不得保存 Access Token 或不受限的单元格明文。

#### Scenario: 多维表格 Update 成功
- **WHEN** Update 成功提交
- **THEN** Host 与 Backend 审计可以关联请求者、Operation、目标资源、幂等键和结果

### Requirement: 诚实声明 Agent 能力
系统 SHALL 仅在 `gateway_describe` 确认所需 Operation 后，才允许 Prompt 和能力回复宣称可以维护多维表格。示例 Prompt 不得再声称飞书聊天 Channel 直接执行多维表格 CRUD。

#### Scenario: 示例连接不支持多维表格的 Gateway
- **WHEN** 示例 Agent 启动时 Gateway 未声明多维表格 Operation
- **THEN** Agent 报告该能力不可用，不得伪造完成

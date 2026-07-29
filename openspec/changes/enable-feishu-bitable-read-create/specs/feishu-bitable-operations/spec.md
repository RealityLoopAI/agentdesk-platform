## ADDED Requirements

### Requirement: 只读与单条新增试点目录
Gateway SHALL 为本轮试点只发布批准资源的只读 Operation 和 `feishu.bitable.record.create`。`record.update`、`record.delete` 及所有 Batch Operation 必须保持不可发现、不可执行，且不得触达飞书 API。

#### Scenario: Agent 发现试点能力
- **WHEN** Agent 对已配置试点 Gateway 调用 `gateway_describe`
- **THEN** 返回的多维表格目录只包含批准的元数据、Field、Record List/Get 和单条 Create Operation

#### Scenario: Agent 猜测未发布写操作
- **WHEN** Agent 直接请求 Update、Delete 或 Batch Operation
- **THEN** Gateway 返回 `OPERATION_NOT_FOUND`，不调用飞书 API，也不产生业务写入

### Requirement: 所有可信规范用户可读和新增
试点逻辑资源 SHALL 使用显式全体规范用户策略允许读取和单条新增。该策略只适用于具有非空可信规范用户身份的请求；匿名调用和 `requesterSource='agent-asserted'` 的写入必须继续被拒绝。

#### Scenario: 可信 Session 用户读取
- **WHEN** 任意具有可信规范用户身份的 Session 请求读取批准的试点逻辑资源
- **THEN** Gateway 在 Operation 和资源校验通过后允许读取

#### Scenario: 可信 Session 用户新增
- **WHEN** 任意具有可信规范用户身份且 `requesterSource='session'` 的请求新增一条合法 Record
- **THEN** Gateway 在 Schema、资源和幂等校验通过后允许提交

#### Scenario: Agent 自报用户尝试新增
- **WHEN** 写请求的用户身份不是可信 Session 身份或 `requesterSource='agent-asserted'`
- **THEN** Gateway 拒绝请求，即使试点资源配置为所有规范用户可写

### Requirement: 多维表格请求委派给专用 Worker
共享 Frontdesk SHALL 将多维表格读取和新增意图委派给职责明确的 Bitable Worker。Worker SHALL 通过 A2A 保留 Host 验证的原始用户身份，并按 Discovery、Authorize、Execute 的顺序使用 Gateway。

#### Scenario: 飞书用户请求查询表格
- **WHEN** Frontdesk 识别出一条多维表格查询意图
- **THEN** Frontdesk 记录分类并把最小必要上下文委派给 Bitable Worker，由 Worker 发现并执行读取 Operation

#### Scenario: Web 用户请求新增记录
- **WHEN** Web Lane 中的用户请求新增一条多维表格记录
- **THEN** Bitable Worker 的 Gateway 请求继续归属于同一个规范用户，工具参数不能替换该身份

#### Scenario: Worker 使用发现结果中的精确 Operation 名称
- **WHEN** 最新 `gateway_describe` 发布 Field 或 Record List Operation
- **THEN** Worker 从返回目录逐字复制 Operation 名称，不猜测复数、Schema、Describe、Query 或 Filter 变体，也不把已发布的 Field/List 能力误报为不支持

### Requirement: 单条新增执行纪律
Bitable Worker SHALL 在新增前确认 Operation 可发现、调用 Gateway 授权、获取当前 Field Schema，并在最终字段值已由用户明确确认后使用稳定幂等键执行 `feishu.bitable.record.create`。只有成功结果可以报告为已创建。

#### Scenario: 新增记录成功
- **WHEN** 用户确认了批准逻辑资源和合法字段值，Gateway 授权允许且飞书提交成功
- **THEN** Agent 返回创建结果、Operation 和 `auditId`，且审计可关联到同一规范用户

#### Scenario: 重复提交相同新增
- **WHEN** 相同逻辑新增因消息重试或超时使用同一稳定幂等键再次执行
- **THEN** Gateway 返回首次已提交结果，不创建第二条 Record

#### Scenario: 字段不符合当前 Schema
- **WHEN** 新增输入包含未知、只读、类型错误或缺失的必填字段
- **THEN** Gateway 在调用 Record Create API 前拒绝请求，且 Agent 向用户说明需要修正的字段

### Requirement: Gateway 可达性与凭证隔离
部署 SHALL 为 Agent Group 配置容器可达的 Backend Gateway 地址，并仅在 Gateway 进程中注入飞书应用凭证、真实资源标识和签名 Secret。容器内 loopback 地址不得被误用为宿主 Gateway 地址。

#### Scenario: 本地容器访问宿主 Gateway
- **WHEN** Agent 容器在本地 Docker 环境调用宿主机上的参考 Gateway
- **THEN** 配置使用可解析的 Host Gateway 地址，调用不会指向容器自身的 `127.0.0.1`

#### Scenario: Agent 检查运行配置
- **WHEN** Agent 或 Prompt 检查自己的工具和配置
- **THEN** 它只能看到逻辑资源名和 Gateway Operation，不会获得 App Secret、Tenant Token、`app_token` 或 `table_id`

### Requirement: 飞书与 Web 纵向验收
试点能力 SHALL 从飞书和 Web 两个入口使用同一规范身份、Conversation Lane 和 Gateway 契约完成读取与新增验收，并产生可关联的 Host Gateway Audit。

#### Scenario: 飞书读取后在 Web 查看
- **WHEN** 用户从飞书请求读取记录并随后通过 Web SSO 打开同一 Lane
- **THEN** Web 历史只显示用户请求和最终 Agent 结果，不把携带同一 `origin_user_id` 的内部 A2A Worker 返回显示为用户消息，且 Gateway Audit 记录同一规范用户与逻辑资源

#### Scenario: Web 新增记录
- **WHEN** 同一用户从 Web Lane 确认并新增一条记录
- **THEN** 创建只执行一次、结果只回复触发来源，且不会形成飞书/Web 消息回环

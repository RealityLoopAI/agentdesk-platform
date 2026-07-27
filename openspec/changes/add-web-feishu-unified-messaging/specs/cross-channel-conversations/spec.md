## ADDED Requirements

### Requirement: 用户自有逻辑会话 Lane
平台 SHALL 将跨渠道对话表示为由一个规范用户和一个 Agent Group 共同确定的稳定 Lane。Organization Scope 必须继续从 Agent Group 推导，不得复制到 Lane。

#### Scenario: 同一用户从 Web 和飞书进入
- **WHEN** 已关联的飞书身份和 Web 身份选择同一个逻辑 Lane
- **THEN** 两端输入解析到同一个根 Agent Session 和同一个规范请求者身份

#### Scenario: 不同用户使用同一个飞书群
- **WHEN** 两个飞书用户在配置为用户级模式的同一个群发送消息
- **THEN** 两人的消息解析到不同 Lane 和不同根 Session

### Requirement: 结构性 Session Key
跨渠道 Lane 解析 SHALL 使用专用结构键，不得复用只用于关联观测的 `conversation_thread_id`。

#### Scenario: Lane 查询
- **WHEN** Router 解析一条跨渠道消息
- **THEN** 系统通过 Lane 的结构标识查找 Session，而不是使用观测关联 ID

### Requirement: 可关联的 Session Mode
只有用户级 Session SHALL 允许关联到跨渠道 Lane。既有 `shared`、`per-thread` 和 `agent-shared` Session 不得静默合并到用户自有 Lane。

#### Scenario: 尝试关联共享群 Session
- **WHEN** 运营者或自动关联器尝试关联一个多人共享 Session
- **THEN** 系统拒绝关联，并要求显式迁移或新建用户级 Lane

### Requirement: 每条消息独立保存来源路由
跨渠道 Session 中的每条入站记录 SHALL 保留可信的 Channel、Platform Address、Thread、外部消息 ID 和规范用户。回复必须默认发送到触发消息的原始地址。

#### Scenario: Web 来源 Turn
- **WHEN** Web 消息触发 Agent 回复
- **THEN** 回复投递到已认证 Web Lane，且不会自动发送到飞书群

#### Scenario: 飞书来源 Turn
- **WHEN** 飞书消息触发 Agent 回复
- **THEN** 回复投递到原飞书会话，并出现在该用户的 Web 历史中

### Requirement: 显式投递订阅
额外的跨渠道投递 SHALL 经过用户显式授权。默认只将持久化历史映射到 Web，不得主动把 Web 内容发送到飞书。

#### Scenario: 未订阅飞书镜像
- **WHEN** 用户从 Web 发送消息且没有有效飞书投递订阅
- **THEN** Web 消息及其回复都不发送到飞书

#### Scenario: 已授权飞书私聊镜像
- **WHEN** 用户显式启用有效飞书私聊投递订阅
- **THEN** 合格的 Agent 回复可以在去重和审计后同步到该用户已验证的飞书私聊

### Requirement: 群聊隐私
用户自有 Lane 的 Web 历史 SHALL 只包含被允许进入该用户 Session 的消息，不得暴露共享群或累积上下文中其他参与者的消息。

#### Scenario: 群中包含其他参与者
- **WHEN** Alice 查看一个还包含 Bob 的飞书群所关联的 Web Lane
- **THEN** Alice 只能看到被授权进入 Alice 用户级 Session 的消息和上下文

### Requirement: 跨渠道去重与回环防护
系统 SHALL 分配稳定的来源和投递标识，确保镜像或重试消息不会作为新用户消息重新进入路由，也不会形成无限 Channel 回环。

#### Scenario: Channel 再次观察到镜像回复
- **WHEN** 同步到飞书的回复随后通过事件回调再次被观察到
- **THEN** Bot 自身消息过滤和来源标识阻止其被路由为新的用户 Turn

### Requirement: Agent 委派过程中的身份连续性
来自跨渠道 Lane 的 A2A 委派 SHALL 通过 `origin_user_id` 传播规范原始用户，并且只有经过 Host 交叉校验后才能保留 `requesterSource='session'`。

#### Scenario: Web Turn 委派给 Worker
- **WHEN** Web 来源的 Frontdesk Turn 被委派给 Worker
- **THEN** Worker 的 Gateway 调用归属于同一个规范用户，且工具参数不能替换该身份

### Requirement: 旧版本兼容
既有飞书 Session SHALL 继续可读、可路由。迁移必须通过创建关联或新 Lane 完成，不得合并属于不同用户的历史。

#### Scenario: 旧版 Per-user Session
- **WHEN** 曾经使用飞书 `per-user` Session 的用户第一次打开 Web
- **THEN** 系统按照确定性迁移规则，将已验证旧 Session 关联给该用户或创建新 Lane

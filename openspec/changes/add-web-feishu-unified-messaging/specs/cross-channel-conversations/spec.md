## ADDED Requirements

### Requirement: 用户自有逻辑会话 Lane
平台 SHALL 将跨渠道对话表示为只属于一个规范用户和一个 Agent Group 的稳定 Lane，并保留原始飞书用户级 Session 或 Web 新建会话的对话边界。同一用户可以在同一 Agent Group 下拥有多条 Lane；Organization Scope 必须继续从 Agent Group 推导，不得复制到 Lane。

#### Scenario: 同一用户从 Web 继续飞书会话
- **WHEN** 已关联的飞书身份产生一条用户级 Lane，且同一规范用户通过 Web 打开该 Lane
- **THEN** 两端输入解析到同一个根 Agent Session 和同一个规范请求者身份

#### Scenario: 不同用户使用同一个飞书群
- **WHEN** 两个飞书用户在配置为用户级模式的同一个群发送消息
- **THEN** 两人的消息解析到不同 Lane 和不同根 Session

#### Scenario: 同一用户拥有多个飞书对话
- **WHEN** 同一用户在同一 Agent Group 下拥有两个不同的飞书用户级根 Session
- **THEN** 系统保留两条独立 Lane，不得把两段历史静默拼接

### Requirement: 新飞书入站自动关联
启用跨渠道 Lane 功能后，平台 SHALL 在飞书发送者身份、Agent Group、Session Mode 和 Channel 地址均由 Host 验证后，为合格的新飞书用户级对话幂等查找、创建或关联 Lane。查看飞书来源会话不得依赖用户先从 Web 新建 Lane。

#### Scenario: 首条合格飞书消息
- **WHEN** 已验证用户在 `per-user` 或 `per-user-per-thread` 飞书入口发送消息，且不存在匹配的活动 Binding
- **THEN** 系统创建或关联该用户的 Lane 和精确飞书 Binding，并将本次消息写入该 Lane 的根 Session

#### Scenario: 重复或并发飞书事件
- **WHEN** 同一飞书会话的消息因重试或并发处理多次触发自动关联
- **THEN** 唯一约束和幂等解析使所有处理收敛到同一 Lane，且不会复制历史

#### Scenario: 跨渠道功能关闭
- **WHEN** 跨渠道 Lane Feature Flag 关闭
- **THEN** 飞书继续使用既有 Session 路由，且系统不创建新的跨渠道 Lane 或 Binding

### Requirement: 既有飞书历史定向回填
平台 SHALL 为已经验证飞书身份的规范用户提供有界、幂等且可审计的历史协调，将该用户符合条件的旧 `per-user` 和 `per-user-per-thread` Session 确定性关联到 Lane。协调不得通过消息正文、姓名、邮箱或全租户内容扫描推断会话归属。

#### Scenario: 首次登录发现旧个人会话
- **WHEN** 用户完成飞书 SSO，且存在 Owner 为同一规范用户的合格旧飞书用户级 Session
- **THEN** 系统按旧 Session ID 和精确结构字段建立 Lane/Binding，并在 Web 会话列表中展示仍有权访问的结果

#### Scenario: 已登录用户升级后协调
- **WHEN** 已有有效 Web Session 的用户首次加载支持历史协调的新版 Web
- **THEN** 客户端通过受保护的幂等协调操作补齐该用户的合格旧飞书会话，然后刷新会话列表

#### Scenario: 重复执行历史协调
- **WHEN** SSO Callback、Web 协调请求或运营批处理对同一旧 Session 重复执行
- **THEN** 系统返回或保留同一 Lane，不创建重复 Binding 或复制 Session 历史

#### Scenario: 历史候选发生冲突
- **WHEN** 旧 Session 的 Owner、外部身份、Agent Group 或 Channel 地址与已有 Binding 冲突
- **THEN** 系统跳过该候选、记录不含消息正文的审计结果，并且不得合并到另一用户的 Lane

### Requirement: 关联不授予权限
自动关联和历史回填 SHALL 只建立经过验证的会话所有权与 Channel Binding，不得创建角色、Agent Group Membership、Organization Membership 或多维表格业务授权。Web 的列表、历史、发送、实时事件和协调操作必须按请求重新执行 Host 访问门。

#### Scenario: 公开飞书群中的用户没有 Web 权限
- **WHEN** 飞书入口允许用户与机器人聊天，但该用户当前没有目标 Agent Group 或 Organization 的 Web 访问权
- **THEN** 自动关联不得为其提权，Web 不展示或允许操作该 Lane

#### Scenario: 已关联会话随后被撤权
- **WHEN** 用户的 Agent Group 或 Organization 权限在 Lane 建立后被撤销
- **THEN** 下一次 Web 列表、历史、消息、SSE 或协调请求立即拒绝该范围，而 Lane 保留用于审计和可能的授权恢复

### Requirement: 结构性 Session Key
跨渠道 Lane 解析 SHALL 使用专用结构键，不得复用只用于关联观测的 `conversation_thread_id`。

#### Scenario: Lane 查询
- **WHEN** Router 解析一条跨渠道消息
- **THEN** 系统通过 Lane 的结构标识查找 Session，而不是使用观测关联 ID

### Requirement: 可关联的 Session Mode
只有用户级 Session SHALL 允许关联到跨渠道 Lane。既有 `shared`、`per-thread` 和 `agent-shared` Session 不得静默合并到用户自有 Lane。

#### Scenario: 尝试关联共享群 Session
- **WHEN** 运营者或自动关联器尝试关联一个多人共享 Session
- **THEN** 系统拒绝关联，该共享历史不出现在个人 Web 会话中，并要求显式迁移或新建用户级 Lane

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
既有飞书 Session SHALL 继续可读、可路由。迁移必须通过确定性创建关联或新 Lane 完成，不得复制历史或合并属于不同用户的 Session。

#### Scenario: 旧版 Per-user Session
- **WHEN** 曾经使用飞书 `per-user` Session 的用户第一次打开 Web
- **THEN** 系统按照确定性迁移规则，将已验证旧 Session 关联给该用户，并只展示当前仍通过 Host 访问门的 Lane

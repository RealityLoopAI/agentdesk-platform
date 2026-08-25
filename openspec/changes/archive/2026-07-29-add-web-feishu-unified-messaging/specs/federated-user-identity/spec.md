## ADDED Requirements

### Requirement: 规范用户与外部身份
平台 SHALL 通过唯一的外部身份映射，将 Channel 和 SSO 身份解析到一个规范 `users` 记录。迁移期间，既有带命名空间的用户 ID 必须继续作为合法规范用户 ID。

#### Scenario: 既有飞书发送者
- **WHEN** 入站飞书事件包含一个已经由旧 `users.id` 表示的 `open_id`
- **THEN** 身份解析器将该外部身份关联到既有用户，而不是创建第二个用户

#### Scenario: 新 SSO 用户
- **WHEN** 合法飞书 SSO 身份没有任何既有映射
- **THEN** 平台以原子方式创建一个规范用户和一个唯一的飞书外部身份关联

#### Scenario: 飞书聊天与 SSO 使用同一身份
- **WHEN** 飞书聊天事件与 SSO 回调提供相同 Provider、Provider Scope、Identifier Type 和经过验证的 `open_id`
- **THEN** 两条入口解析到同一个规范用户，使该用户可以在 Web 中发现自己的飞书用户级会话

### Requirement: 飞书身份键
飞书外部身份 SHALL 由 Provider、飞书应用或租户 Scope、标识类型和标识值共同确定。系统必须优先使用已配置飞书应用下经过验证的 `open_id`，且不得静默地把 `open_id`、`union_id`、邮箱、显示名或工号视为同一身份。

#### Scenario: 不同 Provider 使用相同字符串
- **WHEN** 两个外部 Provider 报告相同的原始标识字符串
- **THEN** 除非经过授权关联流程，否则两个身份必须保持独立

#### Scenario: 不同飞书应用
- **WHEN** 同一个人在两个飞书应用下拥有不同的 `open_id`
- **THEN** 平台不得仅根据姓名或邮箱自动关联

#### Scenario: 原始 open_id 字符串相同但 Scope 不同
- **WHEN** 聊天事件和 SSO 回调提供相同的原始 `open_id` 字符串但 Provider Scope 不同
- **THEN** 平台不得自动认为它们属于同一用户或据此回填飞书历史

### Requirement: 飞书 SSO 授权流程
Web 登录 SHALL 采用飞书 Authorization Code 流程，校验 State、在支持时使用 PKCE、严格校验 Redirect URI、一次性使用 Code，并限制登录事务有效期。

#### Scenario: SSO 回调成功
- **WHEN** 飞书返回与浏览器登录事务匹配的合法授权响应
- **THEN** 平台解析外部身份并创建轮换后的 Web Session

#### Scenario: SSO State 非法
- **WHEN** 回调缺少 State，或 State 已过期、已使用或不匹配
- **THEN** 平台拒绝回调，且不创建身份关联或 Web Session

### Requirement: 账号关联冲突处理
当一个外部身份已关联到另一个规范用户时，平台 SHALL Fail Closed。重新关联必须经过有审计的管理员流程或所有权证明流程，且不得作为登录的副作用发生。

#### Scenario: 身份关联冲突
- **WHEN** SSO 解析出的外部身份已经关联到另一个规范用户
- **THEN** 登录被拒绝，既有身份关联保持不变

### Requirement: Web 登录 Session 生命周期
Web 登录 Session SHALL 是不透明的、服务端保存的、会过期、可撤销，并在登录和权限敏感变更后轮换；每个 Session 只能绑定一个规范用户。退出登录必须撤销服务端 Session。

#### Scenario: Web Session 被撤销
- **WHEN** 运营者撤销 Web Session 或用户退出登录
- **THEN** 后续携带该 Cookie 的 API 和事件流请求都被拒绝

#### Scenario: Web Session 过期
- **WHEN** 配置的绝对有效期或空闲有效期到期
- **THEN** Session 失效，用户必须重新认证

### Requirement: 实时重新计算授权
认证 SHALL 只负责确定调用者身份，不得在整个 Web Session 生命周期内缓存 Agent Group、角色、Organization 或业务操作权限。

#### Scenario: Organization 成员资格被移除
- **WHEN** 已认证用户被移出 Organization
- **THEN** 下一次受保护请求重新计算访问权并拒绝 Organization 范围资源

### Requirement: 凭证边界
飞书 App Secret、OAuth Authorization Code、Access Token 和 Refresh Token MUST NOT 写入 `users`、`user_roles`、Session 数据库、Agent Prompt、Agent 工具参数、客户端存储或审计明文字段。

#### Scenario: 收到 OAuth Token
- **WHEN** SSO 回调用 Authorization Code 换取 Token
- **THEN** 只有批准的凭证边界保留必要 Token，平台记录只包含非敏感身份元数据

### Requirement: 身份变更可审计
身份创建、关联、冲突拒绝、管理员重新关联、Session 撤销和退出登录 SHALL 产生 Enterprise Audit 事件，且不得包含 Token 或 Authorization Code。

#### Scenario: 身份关联成功
- **WHEN** 外部身份成功关联到规范用户
- **THEN** 审计记录包含 Actor、Provider、安全的外部身份标识或哈希、目标用户和结果

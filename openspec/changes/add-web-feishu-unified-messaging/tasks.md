## 1. 架构承诺与实施基线

- [x] 1.1 为“规范用户 + 外部身份关联”编写 ADR，并更新 ADR 索引
- [x] 1.2 为“用户级跨渠道 Lane + Web Channel”编写 ADR，并明确禁止使用 `conversation_thread_id` 作为查询键
- [x] 1.3 为“多维表格只经 Backend Gateway 访问”编写 ADR，并记录拒绝 Channel 直连与容器专用凭证 MCP 的理由
- [x] 1.4 更新身份、数据库、隔离、Channel 和 Gateway 文档中的运行时契约与不变量
- [x] 1.5 安装 Host/Runner 依赖并运行 `pnpm typecheck && pnpm test`、Runner Typecheck/Test，记录变更前基线

## 2. 规范用户与外部身份数据层

- [x] 2.1 新增中央数据库 Migration，创建 `user_identities`、唯一索引和必要外键
- [x] 2.2 新增 `user-identities` DB 模块，覆盖查询、创建、Last Seen 更新、冲突检测和受审计重新关联
- [x] 2.3 实现旧 `feishu:<id>` 用户的安全 Backfill，只为可确定的飞书身份创建关联且不重写既有外键
- [x] 2.4 重构权限模块 Sender Resolver，使可信 Channel 身份先解析为规范用户，再执行既有访问门
- [x] 2.5 增加不同 Provider、不同飞书 Scope、不同 Identifier Type 和关联冲突的单元测试
- [x] 2.6 增加守卫测试，证明 Organization 仍只在 Host 侧门控，未进入 Gateway 业务授权输入

## 3. 飞书 SSO 与 Web 登录 Session

- [x] 3.1 新增 Web/SSO 配置 Schema、环境变量校验和弱 Secret/占位符拒绝逻辑
- [x] 3.2 新增中央数据库 Migration 和 DB 模块，保存 Hash 化、可过期、可撤销的 `web_auth_sessions`
- [x] 3.3 实现飞书 SSO Start/Callback，包括 State、一次性登录事务、严格 Redirect URI 和支持时的 PKCE
- [x] 3.4 实现 SSO 身份到 `user_identities` 的解析、首次创建、冲突 Fail Closed 和 Enterprise Audit
- [ ] 3.5 实现 Secure/HttpOnly/SameSite Cookie、Session 轮换、Idle/Absolute Expiry、Logout 和运营撤销
- [ ] 3.6 实现 CSRF、Origin 校验、请求体上限、登录/API 限流和敏感字段日志/Trace 脱敏
- [ ] 3.7 增加合法登录、State 伪造、Code 重放、Cookie 过期、Logout、冲突关联和撤权即时生效测试

## 4. Conversation Lane 与跨渠道 Session

- [ ] 4.1 新增中央数据库 Migration，创建 `conversation_lanes`、`conversation_bindings` 并为 `sessions` 增加 `conversation_lane_id`
- [ ] 4.2 实现 Lane/Binding DB 模块，包括 SQLite NULL 语义安全的 Partial Unique Index 和撤销逻辑
- [ ] 4.3 扩展 Session Resolver，使 Web 和已验证飞书 Binding 可按 Lane 解析到同一用户级根 Session
- [ ] 4.4 拒绝把 `shared`、`per-thread` 或 `agent-shared` Session 自动关联到用户级 Lane
- [ ] 4.5 实现旧飞书 `per-user`/`per-user-per-thread` Session 的确定性显式关联，禁止跨用户历史合并
- [ ] 4.6 保证每条 Inbound Row 保留 Channel、Platform、Thread、External Message ID 和规范用户来源
- [ ] 4.7 增加 Alice/Bob 同群隔离、飞书/Web 同用户连续性、旧 Session 兼容和非法共享 Session 关联测试
- [ ] 4.8 增加 A2A 回归测试，证明跨渠道 Turn 的 `origin_user_id` 经 Host 校验后正确传播到多层 Worker

## 5. Web Channel、API 与前端

- [ ] 5.1 新建 `src/web/` 独立 Listener 和 `web` Channel Adapter，并保持与 Webhook/Metrics Listener 隔离
- [ ] 5.2 实现 `/api/me` 和用户自有 Conversation List/Create API，逐请求执行 Agent Group 与 Organization 访问门
- [ ] 5.3 实现 Conversation History API，从授权 Session 的 inbound/outbound DB 生成确定性分页 Cursor
- [ ] 5.4 实现带客户端消息 ID 去重的 Web Message POST，并复用 Persist-before-route 主链路
- [ ] 5.5 实现基于持久化 Event 和 Last Seen Cursor 的 SSE 连接、断线重放、连接上限和 Backpressure
- [ ] 5.6 在仓库顶层建立 `web/` React + Vite + TypeScript 工程，配置 Tailwind CSS、shadcn/ui、Radix UI、React Router、TanStack Query、Vitest、React Testing Library、网络 Mock 和根级 `pnpm` 开发/检查/构建脚本
- [ ] 5.7 扩展 `src/branding.ts` 的公开 UI 品牌配置并实现只读 `/api/branding`，动态提供 `PLATFORM_BRAND`、经过批准的同源 Logo 路径和校验后的主题 Token，禁止返回 Secret 或机器内部路径
- [ ] 5.8 建立语义化 CSS Token、4px 间距网格、系统字体栈、6/10/14/20px 圆角层级和深青色/暖白色推荐主题，并为缺失或非法品牌配置提供可访问回退
- [ ] 5.9 导入运营者批准的正式 SVG/高分辨率 Logo，建立导航、登录页、Agent 头像、空状态和低动态处理状态的 Logo 使用组件及安全留白规则
- [ ] 5.10 建立 `/login`、`/conversations`、`/conversations/:laneId` 路由、应用错误边界，以及桌面双栏/窄屏页面切换的响应式骨架
- [ ] 5.11 实现同源 HTTP Client、`/api/me` 启动认证、飞书 SSO 顶层跳转、CSRF Header、`401` 重新登录和 `403` 无权访问的分离处理
- [ ] 5.12 实现均衡密度的会话侧栏、会话创建、URL Lane 选择、分页历史、品牌化空状态和确定性消息排序，并使用 TanStack Query 保存服务端权威状态
- [ ] 5.13 实现混合消息布局：右侧品牌色用户气泡、左侧带 Logo 的 Agent 内容区，以及消息发送中/失败重试和全局网络状态的分级反馈
- [ ] 5.14 实现消息输入、稳定 `clientMessageId`，以及 POST 响应、历史查询和 SSE 事件按服务端标识归并
- [ ] 5.15 实现单个用户级 SSE Client，包括 Cursor 保存、Event ID 去重、带抖动的有界指数退避、恢复后 Query 校验和 Session 撤销处理
- [ ] 5.16 实现安全 Markdown、表格、净化链接和带语言标识/横向滚动/语法高亮/复制按钮的代码块
- [ ] 5.17 实现键盘操作、焦点管理、ARIA 状态播报、WCAG 2.2 AA 对比度校验、`prefers-reduced-motion` 和不会被高频片段打断的可访问性反馈
- [ ] 5.18 实现禁止敏感信息持久化、精确 Origin 配置、CSP/安全响应头和 Vite 公开环境变量检查
- [ ] 5.19 配置开发代理和生产静态资源服务，将 `web/dist/` 与 Host 同版本发布，并验证 Hash Asset 长缓存、HTML 不长期缓存及 SPA Fallback
- [ ] 5.20 增加 Web API/Auth/Branding/Channel Contract 测试，并验证非法主题回退以及浏览器提供的 User/Agent Group/Session ID 不能覆盖服务端上下文
- [ ] 5.21 增加前端组件、交互、无障碍和视觉回归测试，覆盖品牌资源缺失、登录、会话导航、消息归并、错误状态、SSE 重放、Markdown 净化、Logo 动效降级及桌面/窄屏布局
- [ ] 5.22 使用 Playwright 和 Mock Feishu Provider 增加 SSO、消息往返、刷新恢复、断线重连、登录过期、品牌加载及窄屏流程 E2E

## 6. 跨端可见性与投递策略

- [ ] 6.1 调整 Delivery Routing，使 Agent 回复默认使用触发 Inbound Row 的来源地址，而不是假定 Session 只有一个 Messaging Group
- [ ] 6.2 实现“飞书来源回复飞书并进入 Web History；Web 来源默认只回复 Web”的默认策略
- [ ] 6.3 实现用户显式授权的飞书私聊 Delivery Subscription，复用已验证外部身份且默认关闭
- [ ] 6.4 为镜像投递增加稳定 Origin/Delivery ID、Bot Self Filter、持久化去重和回环抑制审计
- [ ] 6.5 增加飞书到 Web、Web 默认不发飞书、已授权私聊镜像、重复 Callback 和跨用户订阅拒绝测试
- [ ] 6.6 增加群聊隐私测试，证明 Web History 不会暴露其他参与者或 Shared Session 内容

## 7. 多维表格 Gateway Operation 契约

- [ ] 7.1 定义并文档化 `feishu.bitable.*` Operation 名称、输入/输出 Schema、错误类型和 Discovery 元数据
- [ ] 7.2 扩展 Gateway Contract/Conformance Fixtures，覆盖 App/Table/Field 发现和 Record List/Get/Create/Update/Delete
- [ ] 7.3 为 Batch Create/Update/Delete 定义记录数量上限、Atomic/Best-effort 行为和索引对齐结果
- [ ] 7.4 实现可复用的参考 Gateway 多维表格 Adapter，使用应用凭证并将 Token 完全限制在 Gateway 进程
- [ ] 7.5 实现逻辑资源别名到 `app_token`/`table_id` 的运营者白名单，拒绝 Agent 任意原始资源标识
- [ ] 7.6 实现 Field Schema 获取/TTL 缓存、字段名/类型/必填/可写校验和有界分页
- [ ] 7.7 实现逐调用规范用户业务授权，并默认拒绝 `requesterSource='agent-asserted'` 的写操作
- [ ] 7.8 实现稳定幂等记录，使 Create/Update/Delete 和 Batch 重放返回首次已提交结果
- [ ] 7.9 实现 Delete/高影响 Update 的用户确认 Obligation，并绑定用户、资源、Record 集合和有效期
- [ ] 7.10 实现飞书认证、授权、校验、Not Found、Conflict、Timeout 和 Rate Limit 的封闭错误转换
- [ ] 7.11 增加 Mock Feishu API 测试，覆盖分页、Schema 漂移、限流、部分失败、幂等重放和未确认删除

## 8. 审计、可观测性与诚实能力声明

- [ ] 8.1 为身份关联、Web Session、Lane/Binding 和 Delivery Subscription 增加不含凭证的 Enterprise Audit Event
- [ ] 8.2 扩展 Gateway Audit，使多维表格调用记录规范用户、Operation、逻辑资源、结果、耗时、Input Hash 和写幂等键
- [ ] 8.3 增加登录、活动 Web Session、API 拒绝、SSE 重放、Binding 失败、多维表格结果/限流和回环抑制指标
- [ ] 8.4 更新 Prometheus Alert、Grafana Dashboard、Runbook 和 Observability Coverage Gate
- [ ] 8.5 修正 `examples/lab-frontdesk`，删除“飞书 Channel 直接维护多维表格”的不真实声明
- [ ] 8.6 让示例 Agent 仅在 `gateway_describe` 声明所需 Operation 时宣称多维表格能力，并增加回归测试

## 9. 端到端验证与发布

- [ ] 9.1 增加真实 Host + Mock Provider 的 Web 消息往返 E2E，验证同一规范用户在 Web/飞书共享 Lane
- [ ] 9.2 增加真实容器 A2A + Gateway E2E，验证 Web 来源身份到 Worker 多跳和多维表格审计
- [ ] 9.3 增加迁移兼容测试，覆盖旧数据库、旧 Feishu-only Session、NULL Organization 和回滚后只读兼容
- [ ] 9.4 运行 Host/Runner Typecheck、全部测试、格式、Lint、依赖审计、Conformance 和容器 Smoke Test
- [ ] 9.5 编写 Web/SSO 配置、反向代理、Cookie/CSRF、身份关联、Lane 隐私和多维表格运营指南
- [ ] 9.6 添加 Web、跨渠道 Lane、多维表格 Read/Write 的独立 Feature Flag 和分阶段启用说明
- [ ] 9.7 演练回滚：关闭 Web Listener、撤销 Web Session、关闭 Lane 自动关联和从 Gateway Discovery 移除多维表格 Operation

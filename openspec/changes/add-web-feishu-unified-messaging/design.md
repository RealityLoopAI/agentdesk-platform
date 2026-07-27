## Context

AgentDesk 当前已有原生飞书 Channel Adapter 和通用 Channel Contract。飞书事件提供发送者标识，权限模块将其转换为带命名空间的 `users.id`，Router 解析 Session，Agent Runner 再通过 `RequestIdentity` 和 `origin_user_id` 传播身份。这足以支持纯飞书聊天，但无法支持浏览器认证、Web 消息界面、一个人对应多个外部身份，也无法提供跨渠道共享的安全 Session Key。

当前用户模型把“一个人”和“一个外部身份”混为一体，例如 `users.id = "feishu:ou_..."`。当前 `per-user` Session 查询还包含 `messaging_group_id`，所以即便 Web 和飞书解析出同一个用户，只要属于不同 Messaging Group，就会产生两个不同 Session。`agent-shared` 不能解决这一问题，因为它会在多个用户间共享 Session，削弱平台最重要的隔离保证。

原生飞书 Adapter 目前只调用认证、IM、Reaction、Image 和成员查询接口，没有调用多维表格接口。但是 `lab-frontdesk` 示例声称可以维护多维表格，并写明由飞书 Channel 直接处理。该声明没有 Agent Tool 或 Gateway Operation 支撑，也违背“业务操作必须经 Backend Gateway”的平台边界。

本变更涉及公共身份契约、中央数据库 Schema、Channel 形态、Session 解析、投递行为、Web 安全边界、前端构建和 Backend Gateway Operation Catalog。因此实施过程中必须编写 ADR，并同步相关文档。

相关方包括在飞书和 Web 之间切换的终端用户、管理身份与资源权限的运营者、实现多维表格策略的后端负责人、安全评审人员，以及维护 Host/Runner 信任链的开发者。

## Goals / Non-Goals

**目标：**

- 提供经过身份认证的浏览器界面，让用户查看并继续自己的 Agent 会话。
- 将飞书消息事件和飞书 SSO 登录解析为同一个规范用户，且不信任浏览器自报身份。
- 在批准的飞书/Web Binding 间共享一个用户自有 Agent Session，同时不暴露其他用户的群聊上下文。
- 保持回复路由确定性，并阻止跨渠道回环和未经许可的群聊发帖。
- 通过经过授权、幂等和审计的 Backend Gateway Operation 实现多维表格元数据与 Record CRUD。
- 保持既有身份信任链、Organization 隔离、三 DB 单写者模型和旧飞书部署兼容。
- 让 Agent 能力声明依赖 Gateway Discovery，而不是只依赖 Prompt 文本。

**非目标：**

- 通用社交登录或密码认证。
- 多节点 Host、分布式 Session Scheduler 或替换 SQLite。
- 默认把所有 Web 消息同步到飞书群。
- 在一个用户的 Web 账号中展示整个飞书群的所有消息。
- 让 `agent-shared` 适用于互不信任的终端用户。
- 在 AgentDesk 中央数据库或 Agent 容器中保存飞书 OAuth Token。
- 用飞书 Adapter 直接访问多维表格来替代 Backend Gateway。
- 把浏览器自动化作为生产级多维表格 CRUD 主路径。
- 允许 Agent 任意提供飞书 Base；资源必须由运营者配置白名单。
- 首期支持基于用户委派 Token 的多维表格访问。首期使用 Backend Gateway 保存的应用凭证，并在 Gateway 中执行逐用户策略。

## Decisions

### 1. 使用独立 HTTP Listener 新增一等 Web Channel

Host 新增 `web` Channel Adapter，并在新的 `src/web/` 边界下提供独立 Web Server。它仍运行在现有单一 Host 进程中，但监听 `WEB_PORT`，与 Webhook/Metrics Listener 分离。浏览器应用使用 TypeScript 实现，构建为静态资源，由 Web Server 或运营者配置的 CDN 提供。

首期 API：

```text
GET  /api/branding
GET  /auth/feishu/start
GET  /auth/feishu/callback
POST /auth/logout
GET  /api/me
GET  /api/conversations
POST /api/conversations
GET  /api/conversations/:laneId/messages
POST /api/conversations/:laneId/messages
GET  /api/events                         （SSE）
```

浏览器不得直接调用 `routeInbound`。Web Adapter 必须先认证请求，在服务端解析规范用户和 Lane，构造带可信元数据的 Channel Event，再调用与其他 Adapter 相同的 Router Callback。

选择独立 Listener 的原因：

- Web Cookie、CSRF、CORS、CSP、静态资源和登录回调，与第三方原始 Webhook 的威胁模型不同。
- 防止前端反向代理规则意外暴露 `/metrics` 或 Webhook Route。
- 保持既有 Webhook Body/Signature 行为稳定。

备选方案：把 Route 加入 `src/webhook-server.ts`。不采用，因为它会把浏览器认证和静态资源服务耦合到一个专门为签名 Webhook 和健康探针设计的 Server。

### 2. 客户端输入使用 POST，实时输出使用 SSE

Web 消息通过认证后的 HTTP POST 提交；持久化后的 Agent 和 Delivery Event 通过 Server-Sent Events 推送，并使用不透明单调 Cursor。

选择 SSE 的原因：

- 客户端只需要服务端到客户端的实时流；用户消息已经适合 HTTP POST。
- 浏览器重连和 `Last-Event-ID` 行为成熟。
- 首期避免 WebSocket 认证、心跳和代理复杂度。

SSE 只是通知路径，不是新的数据真相源。重连重放必须在 Cursor 之后读取持久化 Session 数据；只有对应数据库写入成功后才能发出 Event。

备选方案：WebSocket。暂缓，直到出现 HTTP POST + SSE 无法满足的双向低延迟状态需求。

### 3. 使用 React + Vite + TypeScript 实现独立 Web 前端

浏览器应用放在仓库顶层 `web/`，与 Host 侧的 `src/web/` 明确分离：

```text
src/web/                         Host 侧 Web Server、认证、API、SSE
web/
  index.html                     Vite HTML 入口
  src/
    app/                         应用启动、Router、Query Client、全局错误边界
    api/                         同源 HTTP Client、契约类型和错误转换
    auth/                        登录状态、飞书 SSO 跳转和 Session 失效处理
    events/                      SSE 连接、Cursor、重连和事件归并
    pages/
      LoginPage.tsx              登录入口与登录错误展示
      ConversationsPage.tsx      会话列表和当前会话工作区
    components/
      ConversationSidebar.tsx    会话列表、创建和切换
      MessageTimeline.tsx        历史消息、分页和滚动定位
      MessageComposer.tsx        消息输入、提交和待处理状态
      ConnectionBanner.tsx       离线、重连和会话过期反馈
    test/                        浏览器测试装配和 API/SSE Mock
```

采用以下技术：

- **React + TypeScript**：组件和数据类型边界明确，适合会话列表、消息流和输入状态等交互。
- **Vite**：提供开发服务器和静态生产构建；生产产物输出到 `web/dist/`。
- **React Router**：首期路由为 `/login`、`/conversations` 和 `/conversations/:laneId`，使当前 Lane 可刷新、可前进后退，但 URL 中只出现不透明 Lane ID。
- **TanStack Query**：管理 `/api/me`、会话列表和分页历史等服务端状态、缓存失效与请求取消。
- **浏览器原生 `EventSource` 的薄封装**：管理 SSE 生命周期、`Last-Event-ID`/Cursor、指数退避重连和事件去重；不引入第二套全局状态框架。
- **Vitest + React Testing Library**：覆盖组件和交互；使用 Mock Service Worker 或等价网络 Mock 覆盖 HTTP/SSE 边界。
- **Playwright**：覆盖飞书 SSO 替身登录、会话切换、消息往返、断线重连和登录过期等浏览器端到端流程。

选择 React 而不是 Vue 的原因不是平台能力差异，而是本变更需要明确一个可执行基线；React、TanStack Query 和 React Testing Library 能组成成熟的服务端状态与组件测试方案。选择 Vite 而不是引入 Next.js，是因为认证、授权、数据读取和消息路由全部由现有 Host 完成，首期只需要静态单页应用，不需要第二个 Node Server、SSR 或另一套路由后端。

前端状态按职责拆分：

| 状态类型       | 保存位置             | 示例                           |
| -------------- | -------------------- | ------------------------------ |
| 服务端权威状态 | TanStack Query Cache | 当前用户、Lane 列表、分页历史  |
| URL 状态       | React Router         | 当前 `laneId`                  |
| 短期界面状态   | 组件 State           | 输入草稿、侧栏开合、滚动位置   |
| 实时连接状态   | SSE Provider/Hook    | Cursor、连接中、已连接、重连中 |

不引入 Redux 等额外全局状态库。消息历史的真相源仍是服务端持久化记录，SSE 只向 Query Cache 归并事件。归并键使用服务端消息 ID；发送中的本地消息使用稳定 `clientMessageId` 展示临时状态，在 POST 返回或 SSE 到达后替换为服务端记录。前端必须按服务端 Cursor/Sequence 排序，不能用浏览器到达时间决定顺序。

认证和请求流程如下：

1. 应用启动后请求 `GET /api/me`；成功则进入会话页，`401` 则进入 `/login`。
2. 登录按钮通过顶层页面跳转到 `GET /auth/feishu/start`，不在浏览器中处理 App Secret、Authorization Code 或 Token。
3. SSO 成功后，Host 设置 HttpOnly Cookie 并重定向到 `/conversations`。
4. `/api/me` 同时返回绑定当前 Web Session 的 CSRF Token；所有写请求通过 `X-CSRF-Token` 携带，并设置 `credentials: "include"`。
5. `401` 会清除内存中的用户数据、关闭 SSE 并跳转登录页；`403` 保留登录状态并展示无权访问，不把二者混为一类。

SSE 客户端只建立一个用户级连接。事件至少包含 `eventId`、`cursor`、`type`、`laneId` 和对应的服务端资源标识。客户端必须：

- 忽略已处理的 `eventId`，避免重放产生重复消息。
- 仅更新事件所属 Lane 的 Query Cache，不能把当前页面的 `laneId` 作为授权依据。
- 断线后使用最后确认的 Cursor 重连，并采用带抖动的指数退避；恢复连接后重新校验受影响的 Query。
- 收到 `session-revoked` 或 SSE `401` 时立即清除内存状态并回到登录页。
- 标签页进入后台时保留一个有界连接，不为每个 Lane 新建连接；多标签页连接数由服务端上限保护。

用户界面首期采用“左侧会话列表 + 右侧消息工作区”的响应式布局。窄屏下两者切换显示。消息工作区必须包含历史加载、发送中/失败重试状态、Agent 处理中提示、SSE 重连提示和空会话引导。键盘可以完成会话切换、输入和发送；状态变化使用适当的 ARIA Live Region，但不能因每个流式片段频繁打断读屏。

#### UI 视觉规范：企业简洁风与轻量品牌化

首期使用 **Tailwind CSS + shadcn/ui + Radix UI** 建立设计系统。Tailwind 负责响应式布局和 Design Token 映射；shadcn/ui 提供保存在仓库内、可修改的组件代码；Radix UI 提供菜单、弹窗、Tooltip 等交互原语和无障碍基础。组件不得直接散落十六进制颜色、任意间距或未命名阴影，所有视觉值通过 CSS Custom Properties 和 Tailwind Theme 引用。

界面采用“企业简洁风 + 轻量品牌化”，从公司 Logo 提取以下视觉语言：

- 深青蓝色表达可信、连接和专业感。
- 暖白色页面底色降低纯白大面积使用带来的冷硬感。
- 圆润连续线条对应 Logo 的环形连接结构，转化为适度圆角、焦点环和连接状态图形。
- 四瓣汇聚意象只用于 Logo、登录页、空状态和 Agent 处理中状态，不作为重复页面纹理。
- 大面积内容保持中性，让品牌色集中在主操作、当前会话、链接、焦点和 Agent 身份标识。

当前主题预设：

| Token                    | 默认值    | 用途                             |
| ------------------------ | --------- | -------------------------------- |
| `--brand-primary`        | `#245866` | 主按钮、当前会话标识、焦点和链接 |
| `--brand-primary-hover`  | `#1B4652` | 主操作悬停                       |
| `--brand-primary-active` | `#143A44` | 主操作按下                       |
| `--brand-surface-subtle` | `#E8F1F2` | 选中项、引用块和浅品牌背景       |
| `--brand-border`         | `#B8D0D3` | 品牌强调边框                     |
| `--canvas`               | `#FAF8F4` | 页面暖白背景                     |
| `--surface`              | `#FFFFFF` | 卡片和消息工作区                 |
| `--border`               | `#DDE5E5` | 普通分隔和边框                   |
| `--text-primary`         | `#18343B` | 主要文字                         |
| `--text-secondary`       | `#60757A` | 次要文字                         |
| `--status-success`       | `#287A5B` | 成功状态                         |
| `--status-warning`       | `#A85E18` | 警告状态（白字达到 WCAG AA）     |
| `--status-danger`        | `#C44545` | 错误状态                         |

这些颜色是根据当前 Logo 图片形成的推荐预设，不替代公司的正式品牌手册。实现时必须集中定义 Token；如后续获得正式色值，只替换主题配置而不改组件。正常正文与背景对比度至少满足 WCAG 2.2 AA；不能只依赖颜色表达成功、警告、错误或选中状态。

品牌信息由现有 `src/branding.ts` 继续作为单一来源。新增只读 `GET /api/branding`，在登录前返回经过校验的公开显示配置，例如动态 `displayName`、同源 `logoPath` 和允许公开的 UI Token。显示名来自 `PLATFORM_BRAND`；Logo 必须是运营者提供的正式 SVG 或高分辨率透明资源，并通过批准的同源静态路径提供。禁止把特定公司名称、临时剪贴板图片路径、远程脚本 URL 或机器命名空间写死在前端 Bundle 中。

品牌 Logo 使用规则：

- 顶部导航和登录页可以显示完整 Logo；Agent 头像可以使用简化品牌标记。
- 登录页和空状态可以使用低透明度的大尺寸 Logo 轮廓，但不得形成重复背景纹理。
- Logo 保持原始比例、安全留白和单色识别，不拉伸、不改造线宽、不随意拆分为装饰图案。
- “Agent 正在处理”可以让四个环依次改变透明度或让中心节点缓慢呼吸，周期为约 1.6～2 秒；不得持续快速旋转。
- 当用户启用 `prefers-reduced-motion` 时，动画必须变为静态 Logo 与文字状态。

字体使用系统无衬线字体栈，优先匹配苹方、微软雅黑及操作系统默认字体，不下载未经批准的远程字体。信息密度选择“均衡”：基础间距使用 4px 网格，普通控件高度和消息留白兼顾桌面办公效率与触摸操作。圆角 Token 为 6px、10px、14px 和 20px 四档；按钮和输入框默认 10px，消息/卡片默认 14px，不将全部控件设计为胶囊形。

桌面端采用固定左侧会话栏和右侧消息工作区；窄屏下采用页面级分屏切换，用户选择 Lane 后进入消息页，并通过明确的返回操作回到列表。首期不采用三栏管理后台布局，也不把桌面双栏直接压缩到手机宽度。

消息采用混合形式：

- 用户消息右对齐，使用品牌主色气泡和高对比度文字。
- Agent 回复左对齐并使用接近全宽的中性内容区，配合 Logo 头像，便于阅读 Markdown、代码和表格。
- 发送中、发送失败和重试属于单条消息的行内状态；网络断开和 SSE 重连使用页面顶部状态条；普通操作完成使用短暂提示；登录失效进入登录页。
- Agent 处理中使用品牌化占位状态，正式回复到达后由持久化消息替换；首期不展示无法由后端可信事件证明的虚构执行步骤。

Markdown 使用白名单净化，支持标题、列表、引用、链接、表格和代码块。引用块和表头可以使用浅品牌背景；代码块保持中性深色或高对比度背景，提供语言标识、横向滚动、语法高亮和复制按钮。首期只交付浅色主题，但所有颜色必须通过语义 Token 引用，为后续深色主题保留替换能力，组件中不得通过检测具体色值决定行为。

选择轻量品牌化而不是强品牌化的原因：消息阅读和企业操作效率是首要目标，过多四瓣图案、渐变或大面积深青色会降低信息层级和长文本可读性。选择 shadcn/ui 而不是直接采用 Ant Design，是为了获得无障碍交互基础的同时保留品牌控制权，避免整个产品被固定组件库视觉主导。

安全边界：

- 不把 Web Session、飞书 Token、CSRF Token 或完整用户资料写入 `localStorage`/`sessionStorage`。
- 所有 API 和 SSE 默认同源；如使用 CDN，Host 仅允许配置的精确 Origin，禁止通配凭证 CORS。
- Agent 输出按纯文本或经过白名单净化的 Markdown 渲染，禁止直接注入 HTML。
- Vite 环境变量只允许公开配置，敏感变量不得使用可注入客户端 Bundle 的前缀。
- Host 为静态资源设置 CSP、`X-Content-Type-Options`、`Referrer-Policy` 等响应头，生产 HTML 禁止加载未批准的远程脚本。

开发时由 Vite 将 `/api`、`/auth` 和 `/api/events` 代理到 `WEB_PORT`。生产默认由 `src/web/` 使用同源方式提供 `web/dist/`，并对带内容哈希的 Asset 使用长期缓存、对 `index.html` 禁止长期缓存；运营者也可以把相同静态产物部署到 CDN，但不得改变 API 的身份和授权边界。根 `pnpm` 脚本需要提供可重复的 `web:dev`、`web:typecheck`、`web:test`、`web:e2e` 和 `web:build` 命令。

备选方案：在 Host 中使用服务端模板直接拼接页面。不采用，因为消息列表、分页、乐观提交和 SSE 重连已经构成持续交互应用，模板方案会把 UI 状态混入 Host 路由。

备选方案：首期引入 Next.js。不采用，因为它会增加第二个服务端运行时和认证边界，而当前需求不依赖 SSR、服务端组件或公开搜索页面。

### 4. 引入外部身份关联，同时保留旧 `users.id`

新增中央表，概念结构如下：

```sql
user_identities (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  provider            TEXT NOT NULL,
  provider_scope      TEXT NOT NULL,
  identifier_type     TEXT NOT NULL,
  external_subject    TEXT NOT NULL,
  verified_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  UNIQUE(provider, provider_scope, identifier_type, external_subject)
)
```

`provider_scope` 表示已配置的飞书应用/租户身份范围，避免把一个应用下的 `open_id` 当成另一个应用下的同一标识。该表不保存 Token。

既有 `users.id = "feishu:ou_..."` 继续作为规范用户 ID。迁移只在标识形式无歧义时回填对应飞书身份关联。新安装可以生成不透明的 `usr-*` 规范 ID，但本变更不会重写既有 Role、Membership、Session Owner、Audit 或 A2A 记录。

权限模块的 Sender Resolver 调整为：

```text
可信 Channel 身份
  -> 查询 user_identities
  -> 安全时采用旧确定性用户
  -> 得到规范 users.id
  -> 执行正常访问门
```

不立即把所有旧 ID 替换成 UUID 的原因：重写所有信任链与审计引用风险很高，但用户可见收益很小。增加身份关联表即可支持多身份，同时不破坏旧授权记录。

备选方案：让 Web 直接发送 `senderId = "feishu:ou_x"` 且不增加 Schema。它适合作为验证性 Spike，但不作为长期方案，因为它无法区分飞书应用、表达身份关联冲突、支持未来 Provider 或审计关联过程。

### 5. 飞书聊天与 SSO 使用兼容的应用身份 Scope

首个自动关联路径假定 SSO 身份与聊天事件来自配置兼容的飞书应用 Scope。经过验证的 SSO `open_id` 才能解析为与消息发送者相同的外部身份。

登录使用 Authorization Code、State、严格 Redirect URI，并在飞书支持时使用 PKCE。Host 只保留非敏感身份 Claim 和不透明 Web Auth Session。如果 OAuth 响应包含登录后仍需使用的 Token，则立即交给批准的凭证服务/Backend Gateway 或直接丢弃；不得进入 Prompt、浏览器存储、Session DB 或 Audit 文本。

不同应用 Scope、不同 Identifier Type 或已存在的关联冲突必须 Fail Closed。禁止根据 Email、Name 或 Employee Number 自动匹配。管理员重新关联是独立且受审计的操作。

### 6. Web Session 保存在服务端

新增中央 `web_auth_sessions` 表：

```sql
web_auth_sessions (
  id_hash             TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at          TEXT,
  auth_context_hash   TEXT
)
```

Cookie 只携带随机不透明 Token，数据库只保存 Hash。Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax`。写请求使用绑定服务端 Session 的 CSRF Token。登录和敏感身份变更后必须轮换 Session。

认证只证明调用者是谁。每个 API Action 仍需重新执行 `canAccessAgentGroup` 和 Organization Membership 检查，所以撤权在下一次请求生效。

### 7. 新增结构性 Conversation Lane 和 Channel Binding

新增中央结构，概念如下：

```sql
conversation_lanes (
  id               TEXT PRIMARY KEY,
  agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
  owner_user_id    TEXT NOT NULL REFERENCES users(id),
  root_session_id  TEXT REFERENCES sessions(id),
  status           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  archived_at      TEXT,
  UNIQUE(agent_group_id, owner_user_id, id)
)

conversation_bindings (
  id                    TEXT PRIMARY KEY,
  lane_id               TEXT NOT NULL REFERENCES conversation_lanes(id),
  channel_type          TEXT NOT NULL,
  messaging_group_id    TEXT REFERENCES messaging_groups(id),
  platform_id           TEXT NOT NULL,
  thread_id             TEXT,
  external_identity_id  TEXT REFERENCES user_identities(id),
  delivery_mode         TEXT NOT NULL,
  verified_at           TEXT NOT NULL,
  revoked_at            TEXT,
  UNIQUE(channel_type, platform_id, thread_id, external_identity_id)
)
```

具体 Unique Index 必须考虑 SQLite 的 NULL 语义，必要时使用 Partial Index。Organization 不复制到这两个表，而是按照 ADR-0052 从不可变的 `agent_group_id` 推导。

给 `sessions` 增加 `conversation_lane_id`。跨渠道解析根据 Lane 和 `root_session_id` 查找，不使用仅用于观测关联的 `conversation_thread_id`。

只有 `per-user` 和 `per-user-per-thread` 来源允许自动关联。`shared`、`per-thread` 和 `agent-shared` 历史不得自动合并，因为其中可能包含多个用户内容。

### 8. 一个 Session DB Pair 继续作为消息真相源

Lane 的根 Agent Session 继续使用既有 `inbound.db` 和 `outbound.db`。Web History 通过读取并合并这两个文件中的授权记录生成，不新增第二份可写 Conversation Store。

三 DB 所有权保持不变：

```text
central DB + inbound.db  -> Host 写
outbound.db              -> Container 写
```

SSE Cursor 可以从持久化 Session Message Sequence/State 派生，或使用一个很小的 Host 写 Delivery Cursor Table，但必须引用持久化 Event，不能成为竞争性的 Transcript。

### 9. 消息来源按行保存，额外投递必须显式配置

跨渠道 Session 不能依赖 `sessions.messaging_group_id` 作为统一回复地址。每条入站消息已经携带 Channel、Platform 和 Thread 元数据；这些字段成为本 Turn 默认回复路由的权威来源。

默认行为：

| 来源        | Agent 回复投递 | Web 可见性                |
| ----------- | -------------- | ------------------------- |
| 飞书群/私聊 | 回复原飞书地址 | 在 Owner 的 Web Lane 可见 |
| Web         | 回复 Web/SSE   | 在 Web 可见               |

Web 发出的内容默认不发送到飞书。用户可以选择经过验证的飞书私聊订阅，以镜像合格的 Agent 回复；飞书群镜像留待未来显式策略。每次镜像投递必须携带 Origin/Delivery ID，并且即使被飞书回调观察到也不得重新进入路由。

本设计把“消息互通”解释为共享一份会话历史和一个 Agent 上下文，而不是自动把每条私密 Web 消息公开到群聊。

### 10. 沿用现有信任链传播规范身份

Host 写入规范 `owner_user_id` 和 `origin_user_id`。Runner 继续只把 Host 写入的 `origin_user_id` 与可信 Channel Content 视为 Session 可信来源。浏览器 Payload 中的身份字段一律忽略。

Gateway 接收规范 `requester.userId`。如果后端需要飞书外部身份，应在自身 Credential/Identity Provisioning 边界解析，Agent 不能选择 External Subject。Gateway 业务授权 Envelope 不增加 Organization 字段。

### 11. 多维表格实现为 Gateway Operation，而不是 Channel Method

首期 Operation Catalog：

```text
feishu.bitable.app.get
feishu.bitable.table.list
feishu.bitable.field.list
feishu.bitable.record.list
feishu.bitable.record.get
feishu.bitable.record.create
feishu.bitable.record.update
feishu.bitable.record.delete
feishu.bitable.record.batch_create
feishu.bitable.record.batch_update
feishu.bitable.record.batch_delete
```

Agent 仍只调用通用的 `gateway_authorize`、`gateway_execute` 和 `gateway_bulk_execute`。Backend Gateway 负责：

- 飞书应用凭证和 Token 刷新。
- 逻辑资源别名到 `app_token`/`table_id` 的映射。
- 按用户、资源和 Operation 进行授权。
- Table/Field Schema 发现和缓存。
- 输入校验和输出标准化。
- 分页和响应大小限制。
- 幂等记录。
- Delete/高影响 Update 的确认义务。
- 飞书限流和错误转换。
- 后端审计。

首期使用应用凭证。对于固定企业表格，该方式运维更简单，也避免分发用户 Refresh Token。应用凭证权限通常更宽，所以 Gateway 必须通过资源白名单和逐请求规范用户校验来补足限制。

备选方案：在 `src/channels/feishu.ts` 中直接使用其 Tenant Token 调多维表格。不采用，因为这会把聊天 Adapter 变成业务后端，绕过 Gateway 授权/审计，也无法让 Web 来源 Turn 使用同一业务契约。

备选方案：在 Agent 容器中运行多维表格专用 MCP Server。不作为默认方案，因为它会让凭证和业务授权更接近可能遭受 Prompt Injection 的代码，并形成平行业务路径。

### 12. 能力声明必须通过 Gateway Discovery

Agent Prompt 可以把多维表格描述为潜在能力，但在宣称可用前必须调用或依赖 `gateway_describe`。`lab-frontdesk` 示例必须改为经 Gateway Operation 路由多维表格；当 Operation 不存在时明确报告不支持。

### 13. 新增审计和遥测，但不得影响消息流

新增 Enterprise Audit Event：

- 外部身份创建、关联、冲突和重新关联。
- Web Session 创建、撤销和过期。
- Conversation Lane 创建、绑定、解绑和归档。
- Delivery Subscription 变更。
- 通过既有 Gateway Audit 记录多维表格授权和执行结果。

新增 Metrics 覆盖登录结果、活动 Web Session、API 拒绝原因、SSE 连接/重放、跨渠道 Binding 失败、多维表格 Operation 结果、飞书限流和投递回环抑制。Telemetry 保持只读，不得影响身份或路由决策。

## Risks / Trade-offs

- **[不同飞书应用的身份碰撞]** → 唯一键包含 Provider Scope 和 Identifier Type；只自动关联兼容且已验证的身份。
- **[旧用户 ID 仍带外部平台形态]** → 将 `users.id` 当作不透明规范 Key，暂缓高风险全量重写；新代码不得从中解析业务语义。
- **[跨渠道 Session 泄露群聊上下文]** → 只允许用户级 Session 自动 Binding，拒绝 Shared/Agent-shared 历史。
- **[Web SSO 被攻破会暴露 Agent 访问]** → 使用 State/PKCE、安全服务端 Session、CSRF/Origin 校验、短有效期、撤销、限流和逐请求授权。
- **[SSE 断连时丢失事件]** → 只推送已持久化 Event，并在重新授权后按不透明 Cursor 重放。
- **[POST 返回和 SSE 推送造成重复消息]** → 使用稳定 `clientMessageId`、服务端消息 ID 和 Event ID 进行三层归并，历史以服务端记录为准。
- **[前端依赖增加供应链和升级成本]** → 锁定依赖版本、执行生产依赖审计并保持状态库最小化；不引入 SSR Server 和不必要的全局状态框架。
- **[当前 Logo 图片不是正式矢量品牌资产]** → 提案只记录视觉语言和可替换 Token；发布前由运营者提供获准使用的 SVG/高分辨率资产并验证安全留白、清晰度和使用授权。
- **[品牌色对比度不足或状态只靠颜色表达]** → 对最终 Token 执行 WCAG 2.2 AA 自动检查，并为状态补充图标、文字和 ARIA 语义。
- **[公司品牌被写死后削弱通用平台定位]** → 通过 `src/branding.ts`、公开品牌配置和同源资源路径注入，通用核心保留可替换默认值。
- **[品牌动画影响注意力或前庭敏感用户]** → 动画低频、局部且可通过 `prefers-reduced-motion` 完全停用。
- **[静态前端与 API 版本不匹配]** → 同一发布产物构建并验证 Host 与 Web；API 返回兼容版本标识，不兼容时展示刷新/升级提示而不是继续提交。
- **[多标签页产生过多 SSE 连接]** → 服务端实施每用户连接上限和 Backpressure；客户端每个标签页只建立一个用户级连接。
- **[Web 与飞书形成回复回环]** → 盖章 Origin、投递去重、过滤 Bot 自身回调，额外投递仅可显式启用。
- **[多维表格应用 Token 权限大于用户权限]** → Token 只留 Gateway；资源白名单；每次调用授权；破坏性操作确认；完整审计。
- **[缓存期间多维表格 Schema 发生变化]** → 使用有界 TTL；校验失败时清缓存；只重试一次 Schema Discovery，且不得重复已提交写操作。
- **[Create 重放产生重复 Record]** → Gateway 在确认成功前持久化幂等结果，并使用 Agent Runtime 提供的稳定 Key。
- **[一个 Host 进程同时承载浏览器流量]** → 限制 Body/Connection/SSE 数量，增加限流和 Backpressure，使用独立 Listener/Timeout，并保留全局容器上限。
- **[History 读取跨两个 SQLite 文件]** → 使用确定性合并 Cursor 和有界分页；绝不持有跨挂载写事务。
- **[一次发布范围过大]** → 按 Feature Flag 分阶段交付，先完成 Web/Identity/Lane 基础，再开放多维表格写操作。

## Migration Plan

1. 编写并接受 Federated Identity、跨渠道 Lane/Web Channel 和多维表格 Gateway Operation ADR。
2. 新增 `user_identities`、`web_auth_sessions`、`conversation_lanes`、`conversation_bindings` 及 `sessions.conversation_lane_id` 的加性中央数据库迁移。
3. 安全回填旧飞书身份关联，不重写既有 `users.id`、Role、Membership、Audit 或 Session Owner。
4. 在 Feature Flag 后发布新身份解析，验证关闭 Web 时既有飞书路由逐字节保持不变。
5. 新增 Web Listener、SSO Callback、Session Store、只读会话列表/历史和授权测试。
6. 建立 `web/` React + Vite + TypeScript 工程，先交付登录壳、会话列表和只读历史。
7. 新增 Web 消息接入和 SSE 投递，再启用消息输入、待处理归并和断线重放；默认关闭跨渠道 Lane 自动创建。
8. 先为已验证旧 `per-user` 飞书 Session 开启显式关联，再允许创建新跨渠道 Lane。
9. 完成组件测试和浏览器 E2E 后，构建 `web/dist/` 并验证同源静态资源发布及回滚。
10. 发布 Gateway 多维表格只读 Operation 及一致性测试；写操作保持关闭。
11. 增加写授权、幂等、确认、审计和限流处理，再按逻辑资源逐个启用。
12. 修正示例 Prompt，发布运营迁移和配置文档。
13. 只有在隔离、身份、投递回环、回滚和真实容器测试通过后，才移除 Feature Flag。

回滚方案：

- 关闭 Web 与跨渠道 Feature Flag，既有飞书 Session 继续使用旧解析逻辑。
- 撤销所有 Web Session 并停止 Web Listener。
- 在 Gateway Discovery 中关闭多维表格 Operation，Agent 随即报告能力不可用。
- 回滚期间保留加性 Table/Column，避免破坏性降级；不得删除身份关联或会话数据。

## Open Questions

- 生产环境将使用哪个飞书 SSO 应用和 Tenant Scope？能否保证它与产生聊天 `open_id` 的应用兼容？
- Web 只需展示并继续用户自己的会话，还是 Web 发出的消息也必须同步到飞书私聊？本设计默认不自动发送。
- 每个用户在每个 Agent Group 下只有一个 Lane，还是允许创建多个命名 Lane？Schema 支持多个，但产品默认行为需确认。
- 首个生产版本需要开放哪些逻辑多维表格资源和 Operation？
- 哪个后端服务负责飞书应用凭证、幂等记录和资源白名单？
- Web Auth Session 和浏览器可见会话历史采用什么保留周期？
- 对必须直接遵守飞书原生用户 ACL 的资源，是否在后续增加基于用户委派 OAuth 的多维表格访问？

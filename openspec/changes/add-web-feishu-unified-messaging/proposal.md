## Why

AgentDesk 已经能够接收和回复飞书消息，但目前没有以“飞书已有对话自动进入 Web”为主流程的用户界面、飞书 SSO 账号关联流程和安全的用户级会话模型，导致同一个人登录 Web 后仍可能需要重新选择 Agent、创建一段与飞书历史无关的会话。仓库中的示例提示词还宣称能够维护飞书多维表格，却没有提供任何多维表格 API、MCP 工具或后端网关操作，因此在对外声明该能力前必须补齐真实实现。

## What Changes

- 新增一等 Web Channel，包括需要身份认证的 HTTP API 和浏览器界面；用户通过飞书 SSO 登录后，主界面自动列出自己在飞书中与机器人、Agent 或多维表格助手产生且仍有权访问的个人会话，并可查看历史、发送消息、接收实时更新和继续既有任务。
- 将“从 Web 新建会话”定义为辅助流程：查看飞书已有会话不得要求重新选择 Agent；只有用户主动新建 Web 会话且存在多个可用助手时才要求选择助手，只有一个可用助手时直接创建。
- 新增可配置的轻量品牌化 UI：采用企业简洁风、深青色与暖白色主题、圆润连接图形语言，以及桌面双栏/移动端分屏会话布局；平台名称、Logo 和主题 Token 通过统一品牌边界提供，不在通用核心中写死特定公司品牌。
- 新增 Web 端飞书 SSO，并引入“平台规范用户 + 外部身份关联”模型，使飞书消息事件身份与 Web SSO 身份能够解析为同一个平台用户，同时不削弱现有入站身份信任链。
- 新增用户级跨渠道会话模型，使经过验证的新飞书个人会话能够幂等创建或关联跨渠道 Lane；既有 `per-user`/`per-user-per-thread` 飞书 Session 能够在用户首次登录或会话列表加载前按确定性规则定向回填，使同一规范用户可以在飞书和 Web 继续同一个逻辑对话。
- 自动关联和历史回填不得依赖消息内容、姓名或邮箱猜测身份，不得合并 `shared`、`per-thread` 或 `agent-shared` Session，也不得自动授予 Agent Group 或 Organization 权限；所有 Web 列表、历史和发送请求继续实时执行 Host 访问门。
- 新增显式投递订阅规则：回复默认回到原始消息来源；只有经过用户授权的其他端才可以同步，且不得泄露群聊内容或形成消息回环。
- 通过后端网关新增飞书多维表格 CRUD，包括结构发现、记录查询/新增/更新/删除、批量操作、权限校验、幂等、破坏性操作确认和审计。
- 飞书应用凭证及可能使用的用户 OAuth Token 必须保留在后端凭证边界内，禁止暴露给提示词、Agent 容器、Web 客户端、中央审计明文或 Session 数据库。
- 修正 `lab-frontdesk` 示例：只有当网关配置并通过发现接口声明了所需操作时，才能宣称具备多维表格能力。
- 保持旧渠道行为及 NULL Organization 部署兼容；既有飞书 Session 继续有效，迁移或关联时不得静默合并不同用户。

## Capabilities

### New Capabilities

- `web-channel`：经过身份认证的 Web UI/API 接入、会话读取、消息发送、实时更新和安全出站投递。
- `federated-user-identity`：平台规范用户、飞书 SSO、外部身份关联、账号关联冲突处理和登录会话生命周期。
- `cross-channel-conversations`：在飞书与 Web 之间安全共享的用户级逻辑对话，以及显式的可见性和投递订阅语义。
- `feishu-bitable-operations`：通过后端网关执行经过授权和审计的飞书多维表格结构及记录 CRUD。

### Modified Capabilities

无。当前仓库没有主 OpenSpec Capability Spec；本次变更新增第一批能力契约，不修改既有 Spec。

## Impact

- Host 路由与 Session 契约：`src/router.ts`、`src/session-manager.ts`、`src/delivery.ts`，以及飞书入站自动关联、用户定向历史回填和 Session/中央数据库查询。
- 身份与治理：`users`、新的外部身份映射、Web 登录 Session、RBAC/Organization 访问门、审计记录和数据库迁移。
- Channel 与 HTTP 服务：新的 Web Adapter/API、SSE 投递、公开但不含敏感信息的品牌配置，以及与既有 Webhook/Metrics Server 的安全隔离。
- Agent/Runner 行为：飞书与 Web 之间稳定的规范请求者身份以及 A2A 传播；不增加绕过 Gateway 的业务授权路径。
- 后端网关：新的多维表格操作定义、飞书凭证存储、应用 Token 策略、权限校验、幂等、限流处理和一致性测试。
- 前端：新增基于 React、Vite 和 TypeScript 的浏览器应用，以飞书已有会话列表为主入口、Web 新建会话为辅助入口；使用 Tailwind CSS、shadcn/ui 与 Radix UI 建立可配置设计系统，使用 React Router 管理页面、TanStack Query 管理服务端状态、自建 SSE 客户端接收实时消息，并补充品牌资源、独立构建、视觉回归、交互测试和部署流程。
- 文档和示例：Web/SSO 配置、身份迁移、跨渠道隐私规则、多维表格配置，以及删除不真实的能力声明。
- 架构决策：由于会修改 DB Schema、身份契约、Channel Surface、Session 解析语义和后端操作契约，实施时必须补充 ADR。

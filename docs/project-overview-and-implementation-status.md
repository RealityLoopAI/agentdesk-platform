# AgentDesk 项目总览与当前实现进展

本文面向第一次接触本仓库的同事。目标不是替代已有的 `README.md`、`docs/PLATFORM.md` 或 ADR，而是用更低门槛的语言，把当前项目的背景、核心设计、技术栈和实现进展串起来。

## 1. 项目总览

AgentDesk 是一个企业级多用户 Agent 平台。它要解决的不是“做一个会聊天的机器人”，而是让企业里的多个员工可以安全地共用同一个 Agent 入口，同时做到上下文隔离、身份可信、可审计、可派活、可接入真实后端系统。

可以把它理解成一层企业 Agent 基础设施：

```text
飞书 / Web / CLI 等入口
  -> Host 路由与编排
  -> frontdesk Agent 接待和分流
  -> worker Agent 执行专项任务
  -> 后端 Gateway 做授权、写入、长期记忆和审计
  -> ERP / CRM / Bitable / Archive / 内部系统
```

平台核心保持通用，不把某个公司的表结构、实验室流程、ERP 规则写死在 core 里。具体业务接入，例如飞书多维表格、小环语音、图片/JSON 监控、实验归档查询，都放在 `examples/` 或外部 Gateway 中。

### 1.1 为什么需要这个平台

普通聊天机器人在企业场景里会很快遇到几个硬问题：

- 多个人共用一个 bot 时，谁的上下文是谁的，不能串。
- Agent 调后端做查询或写入时，必须知道真实请求人是谁，不能相信模型自己声称“我是某某用户”。
- 前台 Agent 不可能懂所有业务，需要把请求分给专门 worker。
- 真实业务系统必须有授权、审批、幂等、审计，而不是让模型直接操作数据库。
- 生产运行要能看见消息、容器、后端调用、错误和告警。

AgentDesk 的设计就是围绕这些问题展开：Host 管消息和会话，容器跑 Agent，Gateway 管业务系统，观测栈只读地看全链路。

### 1.2 当前技术栈

后端 Host：

- Node.js + TypeScript，ESM 项目结构。
- `pnpm` 管理脚本和依赖。
- `tsx` 用于开发期运行 TypeScript。
- `better-sqlite3` 作为本地 SQLite 存储。
- `prom-client` 暴露 Prometheus 指标。
- OpenTelemetry + Phoenix/Grafana/Prometheus/Alertmanager 做 tracing、metrics 和告警闭环。
- 飞书 SDK `@larksuiteoapi/node-sdk` 接飞书事件、消息和卡片。

Agent Runner：

- 每个活跃 session 对应一个容器化 runner。
- Runner 运行在 `container/agent-runner/`，使用 TypeScript/Bun 生态。
- Provider 支持 Claude 和 OpenAI-compatible 模型。
- Agent 能通过 MCP 工具调用 `send_message`、`classify_intent`、`gateway_*`、交互确认、调度等能力。

前端 Web：

- `web/` 是 React + Vite + TypeScript 单页应用。
- React Router 管 `/login`、`/conversations/:laneId` 等页面。
- TanStack Query 管会话列表、历史消息和发送状态。
- Radix UI、lucide-react、Tailwind CSS v4 相关工具用于界面组件和样式。
- Web 只通过同源 `/api/*`、`/auth/*` 与 Host 交互，依赖 HttpOnly Cookie、CSRF、Origin 校验和 SSE。

容器与运行环境：

- Host 是单 Node 进程。
- Agent 执行通过 Docker/兼容容器运行时隔离。
- macOS 本地全量测评用 `launchd` 常驻服务管理组合 Host、Gateway 和监控栈。
- Observability 通过 Docker Compose 启动 Phoenix、Postgres、Prometheus、Alertmanager、Grafana。

### 1.3 核心架构

AgentDesk 的核心由四层组成：

| 层 | 职责 | 主要位置 |
| --- | --- | --- |
| Channel | 接收外部消息，转换成统一入站事件；负责平台侧回复投递 | `src/channels/` |
| Host | 路由、授权门控、session 解析、容器唤醒、出站投递、健康检查 | `src/index.ts`、`src/router.ts`、`src/delivery.ts`、`src/host-sweep.ts` |
| Agent Runner | 在容器里读取入站消息、调模型、调 MCP 工具、写出站消息 | `container/agent-runner/src/` |
| Backend Gateway | 承接真实业务系统，做授权、执行、长期记忆、审计和幂等 | `docs/enterprise-erp-gateway.md`、`examples/reference-gateway/` |

核心数据模型是“三库”：

| 数据库 | 写者 | 作用 |
| --- | --- | --- |
| `data/v2.db` | Host | 中央库：用户、权限、组织、Agent Group、会话索引、审计、Web Lane 等 |
| `inbound.db` | Host | 每个 session 的入站消息和路由投影，容器只读 |
| `outbound.db` | 容器 | 每个 session 的出站消息、处理状态和模型上下文，Host 只读轮询 |

这个设计的关键是不跨挂载竞争写 SQLite。Host 只写中央库和 `inbound.db`，容器只写 `outbound.db`，通过 open-write-close 与 `journal_mode=DELETE` 保障 Docker/Apple Container 挂载边界下的可见性。

### 1.4 信任边界

项目里最重要的安全原则是：模型输出不是身份来源。

可信身份来自 Host 处理过的入站消息，例如飞书 sender、Web SSO 会话或受信任 Adapter 提供的 Host envelope。Host 会把规范用户写入 `origin_user_id`，容器侧工具调用再从 batch 级 `RequestIdentity` 获取请求人，而不是读模型参数里的 `userId`。

业务写入不在平台 core 里直接发生。Agent 只能通过 Gateway 工具请求操作，Gateway 再按自己的资源白名单、规范用户、权限策略、确认凭据和幂等键决定是否执行。

## 2. 当前实现进展

### 2.1 Host 主链路

Host 入口在 `src/index.ts`。启动时会依次完成：

- 初始化可观测性。
- 打开中央 SQLite 并执行迁移。
- 检查容器运行时、基础镜像、配置安全和 Gateway 签名覆盖。
- 启动 Gateway signing proxy。
- 加载内置 channel 和 `EXTENSIONS_DIR` 中的外部 channel。
- 注册 delivery adapter，启动 active poll 和 sweep poll。
- 启动 host sweep，做心跳、容器回收和 stuck session 检测。
- 启动 metrics/webhook listener 和可选 Web Server。

Router 在 `src/router.ts`，负责把 channel 事件变成 session 入站消息。当前已实现：

- 入站消息 persist-before-route 账本，失败可显式重放。
- sender resolver 和 access gate hook。
- 消息拦截器链，用于自由文本审批回复、取消待处理问题等。
- 多 session mode：`shared`、`per-thread`、`agent-shared`、`per-user`、`per-user-per-thread`。
- Conversation Lane，用于同一用户的飞书/Web 跨端会话统一。
- 路由后唤醒对应容器。

Delivery 在 `src/delivery.ts`，负责轮询所有 session 的 `outbound.db`。当前已实现：

- 1 秒 active poll 和 60 秒 sweep poll。
- 单 session 出站 drain 的并发保护，避免重复投递。
- 有界超时、退避重试、永久失败记录。
- agent-to-agent 派活消息、普通 channel 回复、system action 分流。
- Conversation Lane 的逐轮可信回复地址解析：回复发到本轮入站来源，而不是盲信 session 创建时的地址。
- 飞书/Web 统一历史通知，以及 Web 回复可选镜像到飞书私聊。

### 2.2 Session 与容器执行

Session 生命周期由 `src/session-manager.ts`、`src/container-runner.ts` 和 `src/host-sweep.ts` 共同管理。

已经落地的能力包括：

- 每个 session 一个目录：`data/v2-sessions/<agent_group_id>/<session_id>/`。
- 每个 session 一对 `inbound.db` / `outbound.db`。
- 容器启动前投影当前 destinations、session routing、roster DM slot。
- 全局并发容器上限 `MAX_CONCURRENT_CONTAINERS`。
- per-agent-group 容器资源限制：memory、CPU、pids。
- idle exit 和 host sweep 回收。
- stuck 容器检测、处理状态同步、失败消息重试。
- OneCLI/Gateway signing proxy 相关凭证注入，避免 signing key 直接进容器。

Agent Runner 当前具备：

- poll-loop 读取 `inbound.db`。
- batch-split 避免一个 turn 混入多个用户/线程。
- RequestIdentity 固定本轮可信身份。
- Provider 抽象：Claude、OpenAI-compatible、Mock。
- MCP 工具：核心消息、A2A、分类、Gateway、交互问题、确认、调度、roster DM、自定义等。
- OpenAI 上下文压缩与摘要落 Gateway memory 的能力。
- Eval harness：用声明式 case 重放 inbound/outbound，不依赖真实 LLM。

### 2.3 权限、身份和多租户

权限模块在 `src/modules/permissions/`。当前实现覆盖：

- 用户表、外部身份映射、Agent Group Membership。
- RBAC：owner、global/group admin、org-admin、operator、viewer 等角色。
- Organization 多租户隔离：Agent Group 归属组织后，非平台超级用户必须是该组织成员才能访问。
- 访问门在路由前执行，撤销权限后下一条入站消息就会被拒绝。
- org 隔离只在 Host 侧做接入门控，不进入 Gateway 业务授权路径。
- 操作员分诊查询、trace CLI 和审计记录。

身份链当前覆盖：

- `origin_user_id` 由 Host 写入，并在 A2A 多跳中传播。
- 容器工具读取 batch 级 RequestIdentity。
- Gateway 请求带 `requesterSource: 'session' | 'agent-asserted'`。
- HMAC 签名、nonce、timestamp 和 Gateway signing proxy。
- `gateway_audit` 记录每次 Gateway 调用。

### 2.4 Channel 与 Web/飞书统一消息

内置 channel 包括：

- `feishu`：支持 webhook、long-connection、hybrid、私聊/群聊、@bot、卡片、图片出站、进度 reaction。
- `cli`：本地调试入口。
- `web`：浏览器入口，由 Web Server 认证后转成通用入站事件。

Web Channel 当前已经不是独立对话系统，而是复用通用 Router、Conversation Lane、session 和两库消息模型。实现包含：

- 飞书 SSO 登录。
- HttpOnly Cookie session。
- CSRF、Origin、CSP、限流、同源 SSE。
- 会话列表、创建 Web Lane、飞书历史协调。
- 历史消息分页读取。
- 用户发送消息的 `clientMessageId` 幂等。
- 用户级 SSE 通知和 cursor 重连。
- 只读问题卡片投影到 Web 历史中；确认交互仍保留在飞书/Host-mediated 路径。
- Web 回复可显式开启镜像到飞书私聊。

前端位于 `web/`，当前已有登录页、会话列表、会话页、消息 timeline、Markdown 安全渲染、只读问题卡片、Gateway 确认面板、飞书提醒开关和基础组件测试。

### 2.5 Backend Gateway 与业务能力

Gateway 是平台和真实业务系统之间的唯一业务能力出口。当前契约包括：

- `POST /describe`
- `POST /authorize`
- `POST /execute`
- `POST /bulk_execute`
- `POST /task/status`
- `POST /memory/get`
- `POST /memory/upsert`
- `POST /memory/search`

Gateway 契约在 runner 侧有可验证 schema，参考实现位于 `examples/reference-gateway/`。参考 Gateway 已覆盖：

- 基础 demo operation。
- 幂等 replay。
- async task。
- memory get/upsert/search。
- 可选 Feishu Bitable adapter。
- 可选 Vision Archive adapter。
- machine ingest HMAC。
- 字段发现、结构化查询、确认凭据、Create/Get 校验、Delete 确认等参考路径。

重要边界：飞书 Adapter 和 Host 不保存 Bitable app token/table id，不直接操作记录。Agent 只看逻辑资源名和 Gateway operation。

### 2.6 本地全量测评链路

`examples/local-evaluation-stack/` 是当前本地测评组合，不属于平台 core。它把以下进程统一交给 macOS `launchd` 常驻：

- 组合 Host：AgentDesk Host + Web/Feishu + 小环语音 Bridge + 图片/JSON Adapter。
- Bitable Gateway：默认 `8088`。
- Vision Archive Gateway：默认 `8090`。
- Observability Compose stack：Grafana、Prometheus、Alertmanager、Phoenix、Postgres。

常用命令：

```bash
pnpm services:install
pnpm services:start
pnpm services:status
pnpm services:restart
pnpm services:stop
pnpm services:logs
```

小环语音链路位于：

- `examples/xiaohuan-doubao-audio/`
- `examples/xiaohuan-bitable-bridge/`

当前生产形态是硬件完成唤醒和切句后，以完整 WAV 通过 HTTP `POST /api/audio` 打到 Mac 的 `50020`。Bridge 校验 WAV、落盘、去重，然后调用火山方舟生成 transcript 与 `experiment-audio.v1`，再以固定规范用户和固定飞书 P2P 路由送入 AgentDesk。写表仍由 Bitable Worker 通过 Gateway 执行和确认。

图片/JSON 链路位于 `examples/voice-photos-feishu-monitor/`。它包含两个相互独立的 poller：

- 图片 monitor：发现稳定图片后发送到固定飞书私聊。
- JSON monitor：验证清晰度、读数、场景和单位后，通过 machine-ingest HMAC 自动写入对应逻辑资源。

这套链路的特点是：硬件、NAS、Bitable、Archive 都是 operator-specific，代码必须留在 `examples/`，不能反向污染平台 core。

### 2.7 可观测性与运维

观测栈位于 `infra/observability/`，当前包括：

- Phoenix：trace UI 和 OTLP collector。
- Prometheus：抓 Host `/metrics` 并执行告警规则。
- Alertmanager：接收 firing alert，默认 null receiver。
- Grafana：内置 `Platform Health` dashboard。
- Postgres：Phoenix 持久化存储，仅 compose 内部暴露。

Host 和 runner 都已经接入 OpenTelemetry。metrics 覆盖入站、路由、容器、投递、Gateway、Web SSO/API/SSE、跨渠道投递、Bitable Gateway 调用等关键路径。

运维脚本包括：

- `scripts/trace.ts`：会话/请求分诊。
- `scripts/org.ts`：组织和 org-admin 管理。
- `scripts/replay-inbound.ts` / `scripts/requeue-inbound.ts`：入站恢复。
- `scripts/dlq.ts`：出站死信处理。
- `scripts/export-audit.ts`：审计导出。
- `scripts/reconcile-feishu-conversations.ts`：飞书/Web Lane 协调。

### 2.8 测试与质量门

当前仓库测试面比较完整：

- TypeScript 编译检查：`pnpm typecheck`。
- Host/模块单测：Vitest。
- 参考 Gateway 契约测试：Node test。
- Web 单测：`pnpm web:test`。
- Web e2e：Playwright。
- Gateway conformance runner。
- 容器 runner eval harness。
- 观测栈配置、告警规则和 Runbook 一致性测试。

本文整理时已执行：

- `pnpm typecheck`：通过。
- `pnpm test`：在普通沙箱中因 `listen EPERM 127.0.0.1` 失败；使用本机提升权限重跑后通过，结果为 `133` 个 Vitest 文件、`1276` 个测试通过，参考 Gateway `36` 个测试通过。

### 2.9 当前边界和后续关注点

从当前结构看，项目已经具备一条完整的企业 Agent 平台闭环：多入口接入、Host 路由、用户隔离 session、容器化 Agent、A2A 派活、Gateway 业务操作、Web/飞书统一历史、审计和可观测。

后续开发需要特别守住这些边界：

- 平台 core 继续保持业务无关；业务 Prompt、表结构、实验室逻辑放在 `examples/` 或 Gateway。
- 不绕过 Gateway 直接写业务系统。
- 不弱化 `origin_user_id`、RequestIdentity、HMAC、`gateway_audit` 组成的身份信任链。
- 不破坏三库单写者不变式。
- Web 端只能展示 Host 投影出的可信历史和只读卡片；写操作仍走 Host/Gateway 确认链。
- Observability 必须只读，不参与修改消息流或身份链。

建议新同事阅读顺序：

1. `README.md`
2. `docs/PLATFORM.md`
3. 本文
4. `docs/architecture.md`
5. `docs/db.md`
6. `docs/web-channel.md`
7. `docs/enterprise-erp-gateway.md`
8. 与当前任务相关的 `examples/*/README.md`
9. 最近的 ADR，尤其是 `ADR-0055` 之后的 Web、Bitable、语音和 machine-ingest 相关决策

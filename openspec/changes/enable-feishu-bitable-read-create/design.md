## Context

上一轮已经交付 Bitable Gateway 契约、Runner 工具、参考 Adapter、审计指标和飞书/Web 统一 Lane，但当前部署仍是关闭状态：两个 Bitable Feature Flag 为 false，凭证与资源为空，8088 Gateway 未运行，现有 Agent Group 也没有 `backendGateway`。Frontdesk 只有一个无明确领域的 `unnamed` Worker，因此缺少从用户自然语言到 Bitable Operation 的可靠纵向路径。

本轮是部署与 Agent 拓扑切片，不改变“业务数据只经 Backend Gateway”的架构。用户决定首期允许所有可信规范用户读取和新增记录。这里的“所有用户”只表示 Gateway 资源策略中的规范用户通配符，不包括匿名调用、浏览器自报身份或 `agent-asserted` 写入。

## Goals / Non-Goals

**Goals:**

- 让飞书和 Web 中经过 Host 认证、且能访问 Frontdesk 的规范用户读取一张批准的多维表格并新增记录。
- 只发布五个只读 Operation 和 `feishu.bitable.record.create`。
- 引入职责明确的 Bitable Worker，由 Frontdesk 分类后委派。
- 保持资源别名、Schema 校验、稳定幂等键、审计和凭证隔离。
- 提供可重复的本地启动、Conformance、真实表格冒烟和跨渠道验收路径。

**Non-Goals:**

- 不开放 Update、Delete 或任何 Batch Operation。
- 不实现 Delete/高影响 Update 的可信确认凭据桥。
- 不把参考 Gateway 宣称为生产级服务，也不在本轮引入生产数据库。
- 不把真实 App Secret、`app_token`、`table_id` 或用户列表提交到仓库。
- 不修改 Host Organization 隔离、身份信任链或飞书聊天 Adapter。
- 不把某个公司的字段或业务逻辑硬编码进平台核心。

## Decisions

### 1. 用资源级 `"*"` 表达“所有可信规范用户”

试点资源的 `readers` 和 `writers` 使用显式 `"*"`。Gateway 仍要求非空规范 `requester.userId`；写操作仍要求 `requesterSource='session'`。Frontdesk/Worker 自报用户、匿名请求和身份链交叉校验失败不会因通配符获得写权限。

备选方案是同步 Host 成员名单到 Gateway。该方案权限更细，但本轮用户已明确要求所有用户可读写，额外同步会引入不必要的双写和撤权一致性问题。

### 2. Gateway 全局开读写开关，资源目录只发布 Read + Create

参考 Gateway 的 `FEISHU_BITABLE_WRITE_ENABLED` 控制所有写操作类别，因此要执行 Create 必须开启它。真正的最小权限通过资源 `allowedOperations` 再收窄为：

```text
feishu.bitable.app.get
feishu.bitable.table.list（仅应用级逻辑资源需要）
feishu.bitable.field.list
feishu.bitable.record.list
feishu.bitable.record.get
feishu.bitable.record.create
```

表级资源不需要 `table.list` 时不发布它。Update/Delete/Batch 即使被 Agent 猜到也返回 `OPERATION_NOT_FOUND`，且不会调用飞书。

### 3. 新建独立 Bitable Worker，不让 Frontdesk 承担字段和分页细节

新增通用的 `agentdesk-bitable-worker` 模板，并将其作为 Frontdesk 的 `bitable` 目的地。Frontdesk 负责识别意图、收集用户的目标和确认；Worker 负责：

1. `gateway_describe`；
2. `gateway_authorize`；
3. `field.list` 或必要的元数据发现；
4. `record.list/get/create`；
5. 返回结构化结果、`auditId`、分页状态和错误。

Worker 使用 `root-session` A2A 模式，使可信 `origin_user_id` 传播到 Gateway。现有 `unnamed` Worker 暂不删除，避免把拓扑清理与本次能力启用混为一项。

### 4. Create 必须由明确用户意图驱动并带稳定幂等键

创建前，Worker 必须完成 Discovery、Authorize 和 Field Schema 校验。若用户尚未明确确认最终字段值，Frontdesk/Worker 通过现有交互工具展示资源别名和字段摘要并等待确认。确认后调用 `gateway_execute`；Runner 继续生成或使用稳定幂等键，重复投递必须返回首次提交结果。

本轮不为 Create 签发 Gateway Confirmation Token，因为它不是删除或高影响 Update；Gateway 的规范身份、资源策略、字段校验和幂等仍是硬边界。

### 5. Gateway 凭证与资源只注入 Gateway 进程

真实凭证由运营者在 Gateway 专属进程环境或 Secret Manager 中注入。Agent Group 的 `container.json` 只保存 Gateway 地址和非敏感超时配置。多维表格凭证不得复制到 Host Prompt、Agent 容器或 Web。

本地 Docker 容器访问宿主 Gateway 时使用 `http://host.docker.internal:8088`。`127.0.0.1:8088` 只用于宿主自身探针，不能写入容器侧 `backendGateway.baseUrl`。启用 Host Signing Proxy 后，容器仍调用 `host.docker.internal` 上的代理；代理从 Host 发起 Backend Gateway 请求时，仅把配置中的标准 Docker 宿主别名转换为 Host loopback。后续生产部署应使用受控内部 DNS，并启用 HMAC/Host Signing Proxy。

### 6. 参考 Gateway 仅用于试点验收

本轮可以使用现有参考 Gateway 完成真实 API 冒烟，但必须在文档和运行输出中标明其幂等与确认使用记录为内存状态。上线为长期写服务前，需要另立变更，把幂等结果、Nonce 和后端审计迁移到持久化存储。

### 7. 同一能力同时从飞书和 Web 验收

验收以飞书来源用户请求为起点，确认 Frontdesk 委派 Bitable Worker、Gateway 以同一规范用户执行并写审计；随后通过 Web SSO 打开同一 Lane，确认历史与结果可见，并从 Web 发起第二次读取或新增。两端不得形成重复写或回复回环。

Web 历史投影必须区分身份归属与消息作者：A2A Worker 返回继续携带原始
`origin_user_id` 以维持鉴权和审计链，但 `channel_type='agent'` 的内部入站行
不得进入用户时间线。浏览器只显示真实 Web/飞书用户入站与最终用户可见的
Agent 出站结果。

## Risks / Trade-offs

- **[所有用户写权限范围过宽]** → 只对白名单中的单个逻辑资源使用 `"*"`，保持 Host Agent Group 访问门，且只开放 Create；后续按用户收紧不需要改契约。
- **[开启写 Feature Flag 意外暴露其他写操作]** → 每个资源显式列出 `allowedOperations`，增加 `/describe` 和直接调用负向测试。
- **[模型直接调用 Frontdesk Gateway 绕过 Worker]** → Frontdesk Prompt 明确路由，且两个 Agent Group 都只能看到同一受限 Operation Catalog；安全不依赖 Prompt。
- **[重复消息产生重复记录]** → 使用稳定幂等键并验证重放返回首次结果。
- **[参考 Gateway 重启丢失幂等状态]** → 本轮仅本地/试点；重启后禁止重放旧写请求，生产前迁移持久化存储。
- **[容器使用错误的 loopback 地址]** → 配置和测试显式断言 `host.docker.internal` 或受控内部 DNS。
- **[飞书字段 Schema 漂移]** → 复用现有 TTL 缓存、失败清缓存并只重新发现一次的逻辑。
- **[真实资源信息缺失]** → apply 前由运营者提供 App 凭证、`app_token`、`table_id`、逻辑别名和必填字段；这些值不写入 OpenSpec。
- **[A2A 身份传播被误当成消息作者]** → Web 历史投影排除 `channel_type='agent'` 的内部入站和以其为回复目标的内部出站，同时保留数据库中的 `origin_user_id` 供 Gateway 鉴权与审计使用。

## Migration Plan

1. 在飞书开放平台为 Gateway 应用授予所需 Bitable 权限，并把应用加入试验表资源。
2. 以 Gateway 专属 Secret 环境注入凭证、Cursor/Confirmation Secret 和单资源白名单。
3. 先保持两个开关关闭启动 Gateway，验证 Fail Closed 和基础 Conformance。
4. 开启 Read，验证 `/describe`、Field/List/Get 和未授权来源拒绝。
5. 创建并接线 Bitable Worker，重启 Host/Container，完成飞书和 Web 只读验收。
6. 开启 Write，但资源仅增加 `record.create`，验证显式确认、字段校验、幂等和审计。
7. 保持 Update/Delete/Batch 的负向测试和监控。

回滚时先从资源 `allowedOperations` 移除 `record.create`，再关闭 Write；需要完全停用时关闭 Read 并停止 Gateway。关闭能力不删除 Conversation Lane、审计或飞书原始数据。

## Open Questions

- 试点多维表格的逻辑别名、`app_token`、`table_id` 和必填字段是什么？
- 使用现有 Realityloop 飞书应用还是单独创建最小权限的 Gateway 应用？
- 试点阶段参考 Gateway 是否只本机运行，还是部署到可持久运行的内部环境？

## Why

当前功能分支从较早的 `main` 基点继续开发了 Web 会话、飞书多维表格、语音、图片/JSON、Gateway confirmation 等扩展，而远端 `main` 已继续引入双模型路由、按用户状态隔离、Agent role、A2A 归属修复、沙箱运行时、并发准入队列和“入口 Agent 对用户隐身”的统一助手人设。需要在不丢失本地扩展、不破坏现有数据库和身份信任链的前提下，把远端平台底座同步进当前分支。

## What Changes

- 在保留可恢复快照的前提下，将当前本地功能提交重放到最新 `origin/main`，并在开始实施时重新确认远端基点与分叉范围。
- 建立按领域处理冲突的规则：远端安全、隔离、路由、并发和容器运行时作为新底座，本地 Web/Lane、Bitable、语音、图片/JSON 与 GUI 扩展以增量方式叠加。
- 解决架构记录编号冲突：保留远端 ADR-0054～0060，将本地 ADR-0054～0085 及其引用整体迁移到 ADR-0061～0092。
- 解决数据库迁移编号冲突：保留远端 `036-agent-group-role`，将本地 036～044 的文件编号和代码标识顺延到 037～045，同时保持迁移 `name` 不变，确保已有数据库按名称识别历史迁移。
- 合并 Provider、Gateway、容器配置、Router、Session、Delivery、schema 和依赖变更，并对 Git 自动合并的载重路径进行人工语义复核。
- 分别验证空数据库安装和现有数据库副本升级，再验证多用户隔离、A2A、Web/飞书 Lane、Bitable CRUD/确认、语音、图片/JSON、GUI Worker 与并发准入。
- 在核心集成通过后恢复当前未提交的本地评测脚本、文档和 Web 模型选择器改动。
- 不改变对外业务 API 的既有意图，不新增绕过 Backend Gateway 的业务数据路径，不弱化身份签名、审计、组织隔离或三数据库单写者约束。

## Capabilities

### New Capabilities

- `upstream-main-integration`: 定义远端平台底座与本地扩展进行可恢复、可验证历史迁移时的快照、冲突处理、编号兼容、数据库升级和验收要求。

### Modified Capabilities

无。本变更的目标是保持现有 `federated-user-identity`、`cross-channel-conversations`、`web-channel` 和 `feishu-bitable-operations` 行为契约不变，仅迁移其实现所依赖的平台底座。

## Impact

- Git 历史：当前本地功能分支的提交哈希会被重写；该分支当前无远端跟踪分支，不涉及改写同事共享分支。
- 核心运行路径：`container/agent-runner`、Provider、Gateway MCP、Router、Session Manager、Delivery、容器配置和并发调度。
- 数据层：中央数据库迁移索引、`schema.ts`、现有数据库升级路径与迁移兼容测试。
- 文档层：ADR 文件与索引、数据库文档、Gateway/配置/架构文档以及 OpenSpec 中的编号引用。
- 依赖层：`package.json`、`pnpm-lock.yaml`、CI lint 与供应链安全覆盖。
- 业务扩展：Web/飞书同 Lane、Bitable、语音、图片/JSON、Vision Archive、GUI Worker 和本地一键评测服务必须保持可用。

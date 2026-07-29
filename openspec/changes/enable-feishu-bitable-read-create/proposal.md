## Why

平台已经具备飞书多维表格 Gateway 契约和参考实现，但当前部署没有 Gateway 接线、逻辑资源或可用 Agent 拓扑，所有多维表格开关均关闭。下一轮需要交付一个可真实验收的最小纵向切片：所有经过 Host 认证的规范用户都可以读取批准的多维表格资源并新增记录，同时继续阻止更新、删除和批量写。

## What Changes

- 配置一个运营者批准的逻辑多维表格资源，并只通过 Backend Gateway 映射真实 `app_token`/`table_id`。
- 启用 App/Table/Field、Record List/Get 五个只读 Operation 和单条 `record.create`；Update、Delete 及所有 Batch Operation 保持不可发现、不可执行。
- 将该逻辑资源的 readers/writers 明确配置为 `"*"`，使所有拥有可信规范用户身份的 Session 可读和可新增；匿名请求和 `requesterSource='agent-asserted'` 写入仍 Fail Closed。
- 新增或重构一个职责明确的 Bitable Worker，并将 Frontdesk 的多维表格意图路由到该 Worker；Worker 必须先 Discovery，再 Authorize，最后 Execute。
- 为新增记录保留 Field Schema 校验、必填字段校验、稳定幂等键、逻辑资源白名单和双侧审计。
- 使用 Gateway 专属运行配置和 Secret 边界启动参考 Gateway，本地容器通过可达的 Host Gateway 地址调用；凭证不进入 Prompt、Agent 容器、Web 或飞书 Channel。
- 增加真实只读与新增冒烟、未授权身份来源拒绝、未发布 Operation 拒绝、重复 Create 幂等及飞书/Web 同 Lane 验收。
- 明确本轮为本地/试点部署切片；参考 Gateway 的进程内幂等存储不得被描述为生产级持久化。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `feishu-bitable-operations`: 增加“全体可信规范用户可读取和新增”的试点发布策略、严格 Operation 子集、Agent 路由与纵向验收要求。

## Impact

- OpenSpec：`feishu-bitable-operations` 主 Spec 的增量要求。
- Agent 拓扑：`groups/` 下 Frontdesk 与新的 Bitable Worker 目的地、Prompt 和容器配置。
- Backend Gateway：`examples/reference-gateway/` 的运行配置、逻辑资源白名单和启动/验收路径。
- 容器网络：Agent Group 的 `backendGateway.baseUrl` 必须从容器可达，不能使用容器内的 `127.0.0.1` 指向宿主 Gateway。
- 飞书资源：需要运营者提供批准的 App 凭证、`app_token`、`table_id`、必填字段及试验数据表。
- 安全与审计：继续复用规范用户、`requesterSource`、Gateway Audit、幂等键和现有 Bitable 指标，不改变 Host Organization 访问门或身份信任链。

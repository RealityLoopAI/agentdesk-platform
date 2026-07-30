# 飞书多维表格 Query + Create + Update 试点

本试点开放字段发现、结构化记录查询、单条读取、单条新增和带确认的单条修改。Agent 只使用
逻辑资源 `pilot.records`；飞书应用凭据、`app_token`、`table_id`、租户 Token 和原生查询
表达式只属于 Gateway 进程。

Delete、全部 Batch Operation、任意原生 Filter 和异步写入继续关闭。

## 1. 仓库外准备

1. 建立低风险试验表，记录它的 `app_token`、`table_id`、必填/只读/高影响字段和非敏感冒烟数据。
2. 给 Gateway 使用的飞书应用开通 Bitable 读取、新增和修改权限，并把应用加入目标表协作者。
3. 复制
   `examples/reference-gateway/bitable-query-create-update.env.example`
   到仓库外的受控环境文件，替换占位值。不要提交真实环境文件。
4. 为 Gateway 配置独立随机的 Cursor、Confirmation 和 HMAC Signing Secret；生产环境从
   Secret Manager 注入。

`readers:["*"]` / `writers:["*"]` 表示允许任意非空、由 Host 会话身份链提供的规范用户 ID。
它不允许匿名身份，也不让 `requesterSource="agent-asserted"` 获得写权限。这个试点策略不等于
生产业务角色模型。

资源 `allowedOperations` 必须保持为：

- `feishu.bitable.field.list`
- `feishu.bitable.record.list`
- `feishu.bitable.record.get`
- `feishu.bitable.record.create`
- `feishu.bitable.record.update`

不要加入 Delete 或任何 Batch Operation。

## 2. 启动与分阶段放量

本地启动器只向 Gateway 注入所需变量，不会注入 Web 或模型 Provider Secret：

```bash
node examples/bitable-pilot/start-gateway.mjs
```

默认读取被 Git 忽略的仓库根 `.env`；也可用
`BITABLE_GATEWAY_ENV_FILE=/absolute/path/to/gateway.env` 指向独立环境文件。

按以下顺序放量：

1. `FEISHU_BITABLE_READ_ENABLED=true`、`FEISHU_BITABLE_WRITE_ENABLED=false`，验收
   Field/List/Get 和结构化 Query。
2. 部署 Host Pending 迁移、`gateway_request_confirmation` Runner 工具和
   `/confirmation/issue` 签名代理路径；确认旧 Gateway/签名失败时 Update 会 Fail Closed。
3. `FEISHU_BITABLE_WRITE_ENABLED=true`，先验收 Host 绑定的单条 Create。
4. 最后把 `record.update` 加入资源白名单，验收 Preview、确认、Fingerprint 冲突和 Get 核验。

本地 Docker 中 Worker 使用 `http://host.docker.internal:8088`。启用 Host Signing Proxy 后，
Host 会把标准 Docker 宿主别名转换为 loopback 再访问 Gateway。

拓扑或 Worker Prompt 变更后运行：

```bash
pnpm exec tsx examples/bitable-pilot/configure-topology.ts
```

Runner 源码由 Host 只读挂载，不需要因纯源码变更重建镜像；首次部署、基础镜像或依赖变化时才运行
`pnpm container:build`。让旧 Worker 容器退出；下一次 Frontdesk 委派应创建或唤醒加载新
Prompt/Runner 的内部会话。

## 3. 结构化 Query

Worker 必须先执行 `field.list`，再把自然语言条件转换为 `record.list.query` 和可选
`orderBy`。Gateway 根据当前 Field Schema 检查字段、Operator、值类型和单选选项，然后转换
为飞书 `/records/search` Payload。模型不能提交飞书原生 Filter、Sort、Formula 或 Provider
Cursor。

支持单层 `and|or`、最多 10 个条件和 3 个排序项。Operator Matrix：

- 文本：`eq`、`ne`、`contains`、`notContains`
- 数字：`eq`、`ne`、`gt`、`gte`、`lt`、`lte`
- 日期：`eq`、`gt`、`gte`、`lt`、`lte`，值使用 Unix 毫秒
- 单选：`eq`、`ne`
- 复选框：布尔 `eq`、`ne`
- 上述字段均支持 `isEmpty`、`isNotEmpty`

`startsWith` 当前没有等价 Provider 实现，会 Fail Closed。结果只读取一个有界页面；
`hasMore=true` 代表结果不完整。用于修改目标选择时，零匹配要澄清，多匹配或
`hasMore=true` 要让用户选择，不能默认第一条。

## 4. Create 与 Update 确认

Create 流程：

1. Worker 发现并校验最终字段。
2. `gateway_request_confirmation` 把字段摘要交给 Host。
3. Host 从可信入站链重新确定原请求者，飞书或 Web 只允许该用户批准。
4. 批准后 Worker 使用稳定幂等键创建，再按返回的 Record ID 执行 Get 核验。

Update 流程：

1. 唯一确定目标，Get 当前完整记录。
2. `record.update` 的 `dryRun=true` 由 Gateway 生成字段 Diff、完整 Record Fingerprint、
   Binding Hash、到期时间和 opaque `confirmationRequest`。
3. Host 向原请求者展示 Gateway 原始 Diff；容器不能重算或修改。
4. 用户批准后，Host Signing Proxy 调用 Gateway `/confirmation/issue`。Gateway 校验
   用户、Agent Group、资源、Record、Patch、Fingerprint、有效期和 Nonce，再签发短期 Token。
5. Worker 原样提交 Patch、Fingerprint 和 Token。Gateway 提交前重新 Get；Fingerprint
   变化返回 `CONFLICT`，不得覆盖外部修改。成功后再次 Get 核验。

确认 Token 只通过 Host 写入的 Worker 私有系统响应返回，不进入飞书卡片、Web API、日志或
审计明文。飞书群聊中 Query 可读，但 Create/Update 仍绑定发起者；其他成员不能代为确认。

## 5. 外部权限排查

若 Create/Update 返回飞书 `1254302 / Permission denied`，同时检查：

1. 飞书开放平台中应用已开通应用身份的 Record 读取/新增/修改权限并发布生效；
2. 目标多维表格「添加文档应用」或高级权限角色中，该应用具备相应读写权限。

只读成功不能证明新增或修改权限已生效。

## 6. 回滚

按影响从高到低回滚：

1. 从资源 `allowedOperations` 移除 `feishu.bitable.record.update`；
2. 如需停止全部写入，再移除 `record.create` 并设置 `FEISHU_BITABLE_WRITE_ENABLED=false`；
3. 如需停止查询，再设置 `FEISHU_BITABLE_READ_ENABLED=false`；
4. 重启 Gateway，检查 `/describe` 不再发布对应 Operation；
5. 保留 Host Pending/审计数据用于追查，不把失败 Update 降级成 Prompt 自证确认。

## 7. 参考实现限制

参考 Gateway 的幂等结果、Confirmation Nonce 和 Token 使用状态仍保存在进程内存，重启后
丢失。生产部署必须持久化并与业务写入形成事务或可靠补偿。Host Pending 已持久化，但不替代
Gateway 的业务授权状态。

飞书 Provider 当前没有条件 Update，重读 Fingerprint 与 PUT 之间仍有 TOCTOU 窗口；生产
Adapter 应使用 ETag、版本条件写入或后端事务。生产还应使用专用 Gateway 飞书应用、Secret
Manager 和细粒度用户/角色权限，逐步替代长期的 `writers:["*"]`。

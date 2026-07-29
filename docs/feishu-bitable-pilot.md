# 飞书多维表格 Read + Create 试点

本试点只开放字段发现、记录列表、单条记录读取和单条新增。Agent 只使用逻辑资源
`pilot.records`；飞书应用凭据、`app_token`、`table_id` 和租户 Token 只属于 Gateway 进程。

## 1. 仓库外准备

1. 建立低风险试验表，记录它的 `app_token`、`table_id`、必填字段、只读字段和非敏感冒烟数据。
2. 给 Gateway 使用的飞书应用开通 Bitable 读取与新增权限，并把该应用加入目标表的协作者。
3. 复制
   `examples/reference-gateway/bitable-read-create.env.example` 到仓库外的受控环境文件，替换占位值。
   不要把真实环境文件提交到 Git。

`readers:["*"]` / `writers:["*"]` 的准确含义是：允许任意非空、由 Host 会话身份链提供的
规范用户 ID。它不允许匿名身份，也不让 `requesterSource="agent-asserted"` 获得写权限。

资源的 `allowedOperations` 必须保持为：

- `feishu.bitable.field.list`
- `feishu.bitable.record.list`
- `feishu.bitable.record.get`
- `feishu.bitable.record.create`

不要加入 Update、Delete 或任何 Batch Operation。

## 2. 启动与分阶段放量

参考 Gateway 不自动读取 `.env`。本仓的本地试点启动器只挑选
Gateway/Bitable 所需变量，不会把 Web 或模型 Provider Secret 注入 Gateway：

```bash
node examples/bitable-pilot/start-gateway.mjs
```

默认读取被 Git 忽略的仓库根 `.env`；也可用
`BITABLE_GATEWAY_ENV_FILE=/absolute/path/to/gateway.env` 指向独立环境文件。

先保持 `FEISHU_BITABLE_WRITE_ENABLED=false`，完成字段、列表、单条读取验收后，再同时：

1. 设置 `FEISHU_BITABLE_WRITE_ENABLED=true`；
2. 保持资源级 `allowedOperations` 只增加 `record.create`；
3. 重启 Gateway 并检查 `/describe` 目录。

本地 Docker 中 Worker 使用 `http://host.docker.internal:8088`。容器里的
`127.0.0.1` 指向容器自身，不是宿主 Gateway。启用 Host Signing Proxy 时配置仍保持这个
容器可达地址；代理在 Host 进程发起上游请求前，会把标准 Docker 宿主别名转换为 Host
loopback，避免 macOS 上 Host 自身无法解析 `host.docker.internal`。

## 3. Create 交互与审计

Worker 在新增前必须展示逻辑资源、最终字段和值，请用户明确确认。提交时使用稳定幂等键；
成功结果必须包含 Operation、Record 结果和 `auditId`。检查 Host `gateway_audit` 与 Gateway
日志能按规范用户、逻辑资源、Operation、Input Hash、幂等键和 `auditId` 关联。

若真实 Create 返回飞书错误 `1254302 / Permission denied`，同时检查两层外部权限：

1. 飞书开放平台中，Gateway 使用的应用已开通应用身份的 `base:record:create`
   （新增记录）或覆盖该接口的多维表格编辑权限，并已发布生效；
2. 目标多维表格右上角「… → …更多 → 添加文档应用」中，该应用具备可管理权限；
   若表格开启高级权限，也可以把应用加为某个群的机器人，再在高级权限角色中给该群读写权限。

只读 Field/List/Get 成功不能替代这两项写权限验收。

## 4. 回滚

按以下顺序收回能力：

1. 从资源 `allowedOperations` 移除 `feishu.bitable.record.create`；
2. 设置 `FEISHU_BITABLE_WRITE_ENABLED=false`；
3. 如需全部停用，再设置 `FEISHU_BITABLE_READ_ENABLED=false`；
4. 重启 Gateway，确认 `/describe` 不再发布相应 Operation。

## 5. 参考实现限制

参考 Gateway 是开发/试点实现。其幂等状态保存在进程内存，重启后丢失。生产部署必须把
幂等记录迁移到持久化存储，并与业务新增在同一事务中提交。Prompt 确认也不是可验证的
签名确认令牌；高影响写操作需要单独的 Gateway 级确认协议。

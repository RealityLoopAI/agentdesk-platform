## 1. 试点资源与安全基线

- [x] 1.1 记录试点逻辑资源别名，并由运营者在仓库外提供 Bitable `app_token`、`table_id`、必填字段和用于冒烟的非敏感测试数据
- [x] 1.2 确认 Gateway 飞书应用具备所需 Bitable 只读与新增权限，且已被授权访问目标多维表格
- [x] 1.3 为“所有可信规范用户可读和新增、其他写操作关闭”的发布策略补充 ADR，并更新 ADR 索引
- [x] 1.4 运行 `pnpm typecheck && pnpm test`，记录变更前基线

## 2. Gateway 试点配置

- [x] 2.1 增加不含真实 Secret 的 Gateway 专属配置模板或启动说明，避免把 Bitable 凭证注入 Agent/Prompt/Web/Channel
- [x] 2.2 配置单个逻辑资源，显式设置 `readers:["*"]`、`writers:["*"]` 和 Read + `record.create` 的 `allowedOperations`
- [x] 2.3 保持 `record.update`、`record.delete` 和全部 Batch Operation 不在资源目录中，并增加 Discovery 与直接执行负向测试
- [x] 2.4 验证匿名请求和 `requesterSource='agent-asserted'` 的 Create 在 `"*"` 策略下仍 Fail Closed
- [x] 2.5 验证 Field Schema、必填字段和不可写字段校验在 Create 前生效
- [x] 2.6 验证相同稳定幂等键的 Create 重放返回首次结果，不产生重复 Record
- [x] 2.7 使用 Gateway 专属环境启动参考 Gateway，并运行严格 Conformance 与 Bitable Operation Catalog 检查

## 3. Bitable Worker 与 Frontdesk 路由

- [x] 3.1 创建通用 `agentdesk-bitable-worker` Agent Group，配置 `root-session` A2A 模式和合理资源上限
- [x] 3.2 将 Bitable Worker 的 `backendGateway.baseUrl` 配置为容器可达地址，本地 Docker 使用 `host.docker.internal` 而非 `127.0.0.1`
- [x] 3.3 编写 Bitable Worker Prompt，强制执行 Discovery → Authorize → Field Discovery → Read/Create，并禁止 Update/Delete/Batch 和凭证探查
- [x] 3.4 在 Create Prompt 流程中加入最终资源/字段摘要与显式用户确认，成功回复包含 Operation、Record 结果和 `auditId`
- [x] 3.5 为 Frontdesk 增加 `bitable` 目的地和分类规则，把多维表格意图委派给专用 Worker
- [x] 3.6 增加 Prompt/拓扑测试，证明 Frontdesk 不宣称未发现能力，Worker 结果返回 Frontdesk，原始规范用户跨 A2A 保持不变

## 4. 纵向测试与审计

- [x] 4.1 增加 Mock 飞书 API 的 Read + Create 试点配置测试，覆盖全用户策略、Operation 子集和字段校验
- [x] 4.2 增加真实容器 Frontdesk → Bitable Worker → Gateway E2E，验证 `requesterSource='session'` 和稳定幂等键
- [x] 4.3 验证 Host `gateway_audit` 和 Gateway 审计可关联规范用户、逻辑资源、Operation、Input Hash、幂等键、结果和 `auditId`
- [x] 4.4 使用运营者提供的真实试验表执行 Field/List/Get 冒烟，确认分页 Cursor 和响应大小限制
- [x] 4.5 在用户确认后对真实试验表执行一次 Create，并用相同幂等键重放验证只有一条 Record
- [x] 4.6 从飞书发起读取，再通过 Web SSO 查看同一 Lane；从 Web 发起新增并验证只回复触发来源且不形成回环
- [x] 4.7 修复 Web 历史把 A2A Worker 返回误标为用户消息的问题，并增加身份链保留但内部消息不可见的回归测试

## 5. 文档、回滚与质量门

- [x] 5.1 更新多维表格运营文档，说明 Gateway 专属 Secret、逻辑资源 `"*"` 的准确含义、容器网络地址和参考实现限制
- [x] 5.2 记录分阶段开关顺序：先 Read，验收后开启 Write + 资源级 Create；提供先移除 Create、再关闭 Write/Read 的回滚步骤
- [x] 5.3 明确参考 Gateway 的幂等状态为进程内存，生产部署前必须迁移到与业务提交同事务的持久化存储
- [x] 5.4 运行 Host/Runner Typecheck、全量测试、参考 Gateway 测试、Conformance、Lint 和相关容器 Smoke Test
- [x] 5.5 重启 Host 和 Gateway，检查健康状态、Bitable 指标、Gateway Audit，并完成飞书/Web 人工验收清单
- [x] 5.6 运行修复相关测试和全量质量门，并在真实既有 Lane 中确认历史不再重复且原有飞书/Web/Bitable 功能未受影响

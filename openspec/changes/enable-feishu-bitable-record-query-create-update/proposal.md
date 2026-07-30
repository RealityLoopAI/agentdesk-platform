## Why

当前试点已经能通过飞书或 Web 自然语言读取字段、分页列出记录、按 ID 读取和新增单条记录，但仍缺少安全的记录级条件查询与完整的单条修改闭环。继续让模型拉取多页数据后自行筛选，或仅凭一句对话确认直接修改，都会带来过度暴露、误选记录、并发覆盖和不可验证确认风险。

## What Changes

- 扩展 `feishu.bitable.record.list`，支持由 Gateway 校验并转换的有界结构化条件与排序；Agent 不能提交任意飞书原生 Filter。
- 将自然语言目标解析为确定性的记录候选：零匹配明确返回、多匹配要求用户选择、唯一匹配才进入修改预览，绝不默认选择第一条。
- 保留并加固单条 Create 流程：发现字段、Schema 校验、展示完整字段摘要、由原请求者确认、稳定幂等提交和提交后 Get 核验。
- 在试点资源中只新增发布 `feishu.bitable.record.update`，继续关闭 Delete 和全部 Batch Operation。
- Update 在提交前读取当前记录、计算字段级 Before/After Diff，并绑定目标 Record、字段变更、当前记录指纹、请求者和有效期进行一次性确认。
- Host 负责收集同一规范用户的确认；Gateway 通过可信确认签发路径生成执行所需的不可伪造凭据。Agent/Prompt 不能自行制造或替换确认凭据。
- Gateway 在 Update 提交前重新读取目标记录并校验预期指纹；确认后发生变化时返回冲突并要求重新预览。
- 飞书私聊与 Web 允许可信用户查询、新增和修改；飞书群聊只允许查询直接执行，写入必须由发起者本人确认精确目标和 Diff。
- 使用真实飞书机器人完成 Query、Create、Update、幂等重放、冲突和提交后读取验收；所有调用继续保留可信身份链和 Gateway Audit。
- 本轮不开放 Delete、Batch、任意原生飞书 Filter，也不把参考 Gateway 的进程内幂等/确认状态宣称为生产级持久化。

## Capabilities

### New Capabilities

<!-- 本轮能力属于既有 feishu-bitable-operations 规格的行为扩展，不新增独立能力。 -->

### Modified Capabilities

- `feishu-bitable-operations`: 增加安全结构化记录查询、唯一目标解析、可验证单条 Update 确认与并发冲突保护，并补齐飞书来源的 Create/Update 纵向验收。

## Impact

- Gateway 契约与 Runner：`container/agent-runner/src/mcp-tools/feishu-bitable-contract.ts`、通用 Gateway MCP 工具和 Conformance Fixture。
- 参考实现：`examples/reference-gateway/feishu-bitable-adapter.mjs`、资源配置、查询转换、确认签发、幂等与审计测试。
- Host 交互面：待确认请求、同一规范用户确认、可信 Gateway 确认签发路径，以及飞书/Web 的确认呈现。
- Bitable Worker 与拓扑：`examples/bitable-pilot/` Prompt、试点资源 Operation 白名单和运行时协调。
- 文档与架构：Backend Gateway/Bitable 运维文档；新增可验证确认路径属于运行时契约变更，实施时需要 ADR。
- 外部系统：现有飞书 Bitable API 和当前试点表；不引入新的业务系统直连路径。

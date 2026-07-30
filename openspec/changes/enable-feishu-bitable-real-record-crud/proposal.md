## Why

当前飞书多维表格试点已经完成安全的记录级查询、新增和修改实现，但真实飞书入口尚未在用户指定的真实表格上闭环验收，且单条删除仍被策略明确关闭。需要在不扩大批量写入、不暴露 Provider 标识、不允许误删既有业务数据的前提下，补齐单条 Delete 和真实自然语言 CRUD 证据。

## What Changes

- 为 `feishu.bitable.record.delete` 增加 Gateway 生成的删除预览、当前记录指纹、Host-mediated 原请求者确认、稳定幂等和删除后不存在核验。
- 自然语言删除必须先通过结构化查询得到唯一、完整的目标，再读取当前记录并展示删除摘要；零匹配、多匹配或分页未完结时不得进入预览。
- 试点资源只新增单条 Delete，继续关闭所有 Batch Operation；查询保持可直接执行，Create/Update/Delete 均由发起者本人确认。
- 将用户指定的真实多维表格配置为逻辑资源；真实 App/表/View 标识只保存在忽略提交的运行时配置中，不进入 Prompt、模型上下文或 Git。
- 用一个带唯一测试标记、由本轮创建的记录依次完成 Query、Create、Get、Update、Delete 和删除后 Get/Query 核验；Delete 只能指向该测试记录，不触碰既有记录。
- 从真实飞书 P2P 入口完成自然语言 CRUD，并关联 Host/Gateway 审计；群聊跨用户确认和 Web 历史一致性继续 Fail Closed。
- 不开放批量删除、批量修改、任意原生飞书 Filter，也不把参考 Gateway 的进程内幂等与确认状态宣称为生产级持久化。

## Capabilities

### New Capabilities

<!-- 本轮扩展既有 feishu-bitable-operations，不新增独立能力。 -->

### Modified Capabilities

- `feishu-bitable-operations`: 增加受指纹和 Host 用户确认保护的单条 Record Delete，并要求在运营者配置的真实表格上完成自然语言 CRUD 与审计验收。

## Impact

- Gateway/Runner 契约：单条 Delete Preview、Confirmation Binding、幂等 Replay、删除后核验及对应 Fixture。
- 参考 Gateway：飞书 Record Delete Adapter、确认签发、指纹冲突、审计和真实表格配置。
- Host/Web/飞书：复用既有 confirmation broker 展示删除摘要并校验原请求者，不新增平行业务授权路径。
- Bitable Worker：补充唯一目标删除流程、测试记录保护和精确 Operation 使用。
- 运行时配置：用户指定真实表格映射到逻辑资源，Provider ID 和凭据保持在忽略提交的 `.env`。
- 测试与文档：Mock 生命周期、真实容器 E2E、真实飞书 P2P CRUD、Web 历史与审计证据。

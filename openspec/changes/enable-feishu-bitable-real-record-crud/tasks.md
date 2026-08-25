## 1. 基线与契约

- [x] 1.1 运行 Host/Reference Gateway、Runner 和 Web 的 Typecheck/Test 基线，并严格校验本变更 OpenSpec
- [x] 1.2 为 Delete Preview、Delete Confirmation Binding、删除后核验和真实表格逻辑资源补充 ADR/运维契约说明
- [x] 1.3 扩展 Runner Bitable 机器契约，定义有界 Delete Preview/Result Schema、Fixture 和 Descriptor

## 2. Gateway 单条 Delete

- [x] 2.1 实现 `record.delete dryRun=true`：授权后 Get 当前完整记录、计算指纹、生成字段摘要、Binding Hash 和 opaque Confirmation Request
- [x] 2.2 扩展 `/confirmation/issue` 验证 Delete Display 与用户/组/资源/recordId/指纹/有效期/Nonce 绑定并签发专用 Token
- [x] 2.3 实现 Delete 提交的幂等 Replay、Token 校验、提交前指纹冲突检测、飞书单条 Delete 和提交后 Not Found 核验
- [x] 2.4 增加无确认、跨用户/组、目标替换、过期、Nonce 异 Key、指纹变化、Replay、Key 重绑定和核验失败测试

## 3. Host 确认与自然语言 Worker

- [x] 3.1 扩展 Runner `gateway_request_confirmation` 和私有响应，支持仅接受 Gateway 原始 Delete Preview 的 `kind=delete`
- [x] 3.2 扩展 Host Broker、飞书卡片和 Web Panel，展示删除记录摘要并只允许原请求者确认，Token 不进入 UI/事件/日志/审计
- [x] 3.3 为跨用户、重复点击、过期、伪造 Delete Preview、Gateway 404/签名失败和 Host 重启恢复增加 Fail-Closed 测试
- [x] 3.4 更新 Bitable Worker Prompt/Eval：Delete 必须零/单/多候选分流、唯一目标 Get、Preview、确认、提交与不存在核验
- [x] 3.5 将单条 `feishu.bitable.record.delete` 加入试点模板并同步拓扑，继续关闭全部 Batch Operation

## 4. 纵向自动化与真实表格

- [x] 4.1 扩展 Mock Query/Create/Update/Delete 生命周期，覆盖稳定幂等、冲突和删除后 Not Found
- [x] 4.2 扩展真实容器 Frontdesk → Worker → Host 确认 → Gateway E2E，证明 Delete 仍保留原规范用户
- [x] 4.3 只读发现用户指定真实表格 Field Schema，把 App/Table/View 映射到忽略提交的逻辑资源配置且不向模型暴露 Provider ID
- [x] 4.4 按 Gateway → Host 顺序重启，检查签名代理、飞书长连接、健康探针和未签名路径关闭
- [x] 4.5 用真实 Provider Adapter 对唯一测试记录执行 Create/Get/Query/Update/Delete/Not-Found 烟测，不触碰既有业务记录
- [x] 4.6 从真实飞书 P2P 完成自然语言 Query/Create/Update/Delete 与用户确认，核对 Web 历史无重复和 Host/Gateway Audit

## 5. 质量门与证据

- [x] 5.1 更新 Gateway/Bitable 运维文档，记录真实资源配置、Delete 确认、回滚和参考 Store 非生产限制
- [x] 5.2 运行 Host/Reference Gateway、Runner、Web 全量测试、Typecheck、Build、Lint、格式与 OpenSpec 严格校验
- [x] 5.3 在 `verification.md` 记录自动化、真实 Provider、真实飞书 P2P、Replay/Conflict、Web 历史和审计证据

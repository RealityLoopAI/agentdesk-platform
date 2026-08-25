# ADR-0065: 在权限边界实施统一消息独立发布开关

- **Status**: Accepted
- **Date**: 2026-07-27
- **Decider(s)**: 用户（要求分阶段实现并逐模块验证）；coding agent（提案执行）
- **Tags**: `web`, `feishu`, `feature-flags`, `gateway`, `rollback`, `privacy`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0061 至 ADR-0064 已确定规范身份、Conversation Lane、多维表格 Gateway 和 Web UI 的结构。
本次变更仍跨越浏览器入口、原生飞书路由和业务数据写入三个不同风险面。如果只有一个总开关，打开
Web 登录就会同时扩大跨渠道历史可见性和多维表格写权限，出现故障时也无法单独回滚。

OpenSpec 迁移计划要求先验证 Web，再启用跨渠道自动关联，随后开放多维表格只读，最后才开放写入；
关闭新能力时必须保证旧飞书 Session 继续工作。

## Options Considered

- **Option A：一个统一总开关。** 配置简单，但无法灰度定位故障；Web 可用性、Lane 隐私和业务写入
  被不必要地绑定。
- **Option B：在前端隐藏未开放入口。** UI 看起来关闭，但 Agent、脚本或直接 HTTP 请求仍可能调用
  后端能力，不构成安全边界。
- **Option C：在各自的权限执行边界设置独立开关。** 配置项更多，但关闭后能力真正不可路由、不可
  发现或不可执行，并能按风险逐步上线。

## Decision

> **拍板**：选择 Option C。

保留 `WEB_ENABLED` 控制 Host 的独立 Web Listener；新增
`CROSS_CHANNEL_LANES_ENABLED`，只控制原生 Channel 按已验证 Binding 自动命中 Lane，不影响已由
Web Server 授权的 Web-only Lane。两者默认关闭。

在 Backend Gateway 增加 `FEISHU_BITABLE_READ_ENABLED` 和
`FEISHU_BITABLE_WRITE_ENABLED`。两者默认关闭，并同时控制 `/describe` 能力发现和 Adapter
执行；关闭的 Operation 返回 `OPERATION_NOT_FOUND`，不会触达飞书 Provider。写开关与读开关分离，
以支持“只读先行”。

配置值采用严格布尔解析。含糊值在启动时失败，不允许用字符串真值意外扩大历史或数据访问。

## Consequences

- **Positive**: Web、跨渠道隐私、多维表格读和写可以独立灰度与回滚；关闭的是服务端真实能力，不是
  视觉提示；旧飞书 Session 在开关关闭时保持旧解析键。
- **Negative**: Host 和 Gateway 需要协调四个配置项；Gateway Catalog 在启动时生成，因此切换后
  需要重启。
- **Neutral / Trade-offs**: Web 已授权 Lane 在跨渠道开关关闭时仍可工作，这是为了允许“内部 Web
  试用但不合并飞书历史”；如果未来需要更细的用户级灰度，应放在运营者访问策略中，而不是让浏览器
  自报灰度分组。

## Implementation Notes

- Host 开关解析：`src/feature-flags.ts`
- Lane 执行边界：`src/router.ts`
- Web Listener 边界：`src/web/config.ts`、`src/web/server.ts`
- Gateway 读写边界：`examples/reference-gateway/feishu-bitable-adapter.mjs`
- 带审计撤销工具：`scripts/revoke-web-sessions.ts`
- 部署与回滚手册：`docs/web-feishu-unified-messaging-operations.md`
- 验收包括默认关闭、独立开关、关闭后 Provider 零调用、旧 Session 兼容和回滚只读查询。

## References

- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- `openspec/changes/add-web-feishu-unified-messaging/tasks.md`
- ADR-0061、ADR-0062、ADR-0063、ADR-0064

# ADR-0067: 原生 EventSource 使用 Origin 优先、Fetch Metadata 兜底的同源校验

- **Status**: Accepted
- **Date**: 2026-07-29
- **Decider(s)**: 用户（要求修复 Web 实时连接）；coding agent（提案与执行）
- **Tags**: `web`, `sse`, `security`, `csrf`, `browser`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0062 选择 Cookie 认证的 SSE 作为 Web 实时通知通道。最初实现把精确 `Origin` 作为事件流的
唯一同源证明，但原生浏览器 `EventSource` 的同源 GET 不保证发送该 Header。真实浏览器因此被
错误返回 `403`，前端进入无限重连；完全移除检查又会削弱携带 Cookie 的私有事件流读取边界。

POST 写请求已经使用精确 Origin 与 CSRF，不能因 SSE 兼容问题一起放宽。Host 也没有可信代理
模型，因此不能信任客户端可伪造的 `X-Forwarded-Host`。

## Options Considered

- **Option A：删除 SSE Origin 检查。** 兼容性最高，但只剩 Cookie 认证，跨站读取防护不足。
- **Option B：保留原生 EventSource，显式 Origin 优先，缺失时联合校验 Host 与
  `Sec-Fetch-Site: same-origin`。** 改动小，现代浏览器可用，同时保持 Fail Closed。
- **Option C：改用 Fetch 流并在自定义 Header 中发送 CSRF 证明。** 控制力更强，但需要自行实现
  SSE 解析、重连和游标行为，扩大前端改动与回归面。

## Decision

> **拍板**：选择 Option B。

事件流明确携带 Origin 时必须逐字匹配 `WEB_PUBLIC_ORIGIN`；显式错误值和 `Origin: null` 立即
拒绝。只有 Origin 完全缺失时，才允许 `Host` 精确匹配公开 Origin 的 Host（含端口）且
`Sec-Fetch-Site` 为 `same-origin` 的请求。任一证明缺失或含糊均返回 `403`。有效 Web Session、
每用户连接上限、逐事件 Host 权限门和 Session 撤销检查保持不变。

POST 写请求继续执行精确 Origin 与 CSRF，不复用 SSE 兼容分支。SSE 建连后立即发送注释确认帧，
避免代理缓冲或首个业务事件较晚时浏览器长时间停留在“正在连接”状态。

## Consequences

- **Positive**: 真实浏览器可以建立同源 SSE；跨站、同站不同 Origin、Host 不匹配和来源不明的
  请求继续 Fail Closed；写接口安全边界不变。
- **Negative**: 不发送 Fetch Metadata 的旧浏览器或特殊 WebView 无法使用实时流，需要刷新查看
  历史或未来采用 Option C。
- **Neutral / Trade-offs**: 反向代理必须保留与公开 Origin 一致的 Host；在建立可信代理模型前
  不读取 `X-Forwarded-Host`。

## Implementation Notes

- 同源校验与 POST 边界：`src/web/server.ts`
- SSE 确认帧、心跳与撤销：`src/web/events.ts`
- 安全矩阵与流测试：`src/web/server.test.ts`、`src/web/events.test.ts`
- 运维要求：`docs/web-channel.md`、`docs/web-feishu-unified-messaging-operations.md`
- 验收：浏览器打开会话页后连接提示消失；跨站和不完整同源证明返回 `403`

## References

- ADR-0062
- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- `openspec/changes/add-web-feishu-unified-messaging/specs/web-channel/spec.md`

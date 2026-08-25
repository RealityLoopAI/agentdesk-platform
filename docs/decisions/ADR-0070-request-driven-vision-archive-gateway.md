# ADR-0070: 通过请求驱动的 Gateway 读取 Vision Archive

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（需求与边界），coding agent（提案、实现与验证）
- **Tags**: `gateway`, `smb`, `archive`, `security`, `agent-routing`, `read-only`
- **Supersedes**: None
- **Superseded by**: None

---

## Context

VisionCortex 异步把实验产物写到 NAS。用户希望仅在对话中提出查询时由 AgentDesk
读取；平时不监控、不预索引，也不依赖 VisionCortex 代码或 API。平台既有不变量要求业务
数据授权只能经过 Backend Gateway，容器不能获得旁路凭证或共享文件系统访问。

同时，查询可能与生产者写入竞态，目录名和 JSON 内容都不可信，SMB 可能断开。首期只需
实验目录查找、文件元数据和通用有界 JSON 检查，不需要二进制投递或领域聚合。

## Options Considered

- **Option A: Agent 容器直接挂载 SMB**。实现直观，但把 NAS 凭证和任意文件读取面交给
  不可信执行环境，绕开 Gateway 授权与统一审计。
- **Option B: 后台扫描并持久化本地索引**。查询快，但违背“无请求不访问”，还引入
  新鲜度、同步、删除一致性和第二份业务数据。
- **Option C: Host 只读挂载 + 可选 Gateway Adapter + 专用 Worker**。每次执行时按需、
  有界读取，可复用可信身份、授权、HMAC 和审计，代价是 SMB 延迟直接体现在请求中。

## Decision

> **拍板**：选择 Option C。

操作系统以只读方式挂载 SMB；可选 Adapter 只在已授权 `/execute` 中触碰挂载目录。
`/describe`、`/authorize`、启动、空闲、句柄过期和关闭均不访问文件系统。Agent 只持逻辑
资源名与短期、用户和 Agent Group 绑定的不透明句柄。

JSON 在完整读取前后比较文件身份、大小和修改时间；变化、消失或无法完整解析时丢弃内容，
返回 busy/not-ready，不在后台重试。二进制读取与聊天附件投递延期到独立决策。

## Consequences

- **Positive**: 保持 Gateway 唯一业务数据/授权路径；容器无 NAS 挂载与凭证；用户请求与
  SMB 访问有一一对应的可审计关系；没有索引新鲜度问题。
- **Negative**: SMB 不可用或延迟会即时影响查询；Gateway 重启会让内存句柄失效；没有
  后台索引意味着宽泛查询必须受目录上限约束。
- **Neutral / Trade-offs**: 通用 JSON read/search 先覆盖未知 Schema，领域事件聚合待拿到
  版本化样本后另做；首期只能返回元数据，不能直接发送 PDF、图片或视频。

## Implementation Notes

- Adapter: `examples/reference-gateway/vision-archive-adapter.mjs`
- Gateway composition: `examples/reference-gateway/server.mjs`
- Worker/topology/launcher: `examples/vision-archive-pilot/`
- Operator guide: `docs/vision-archive-gateway.md`
- Tests use temporary directories and a temporary loopback Gateway; they never
  write to the production archive.
- Depends on ADR-0028 (Gateway contract), ADR-0034 (Host signing proxy),
  ADR-0052 (Organization remains Host-side), and ADR-0069 (trusted child
  requester identity).

## References

- OpenSpec change: `openspec/changes/add-on-demand-vision-archive-query/`
- Baseline commit: `900a817`

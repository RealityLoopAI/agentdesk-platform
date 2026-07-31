# ADR-0080: 用内容绑定凭证自动写入视觉 JSON 结果

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（全自动写表、无确认卡），coding agent（提案、实现与验证）
- **Tags**: `gateway`, `bitable`, `machine-ingress`, `smb`, `idempotency`, `security`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

原 `voice_photos` 示例轮询 NAS 图片并推送到固定飞书私聊。新产物是结构化
JSON：只有清晰、完整且采用帧与最终读数一致时，才把固定测试批次、设备和克数
自动写入多维表格，且不再显示飞书确认卡。

业务写入只能经过 Backend Gateway，不能让文件监控器直连 Bitable，也不能只
依赖模型提示词绕过确认。NAS 必须只读，首次扫描忽略已有文件，普通飞书文本
不能进入同一无人值守写入入口。

## Options Considered

- **Option A：监控器持飞书凭证直接写表。** 最短，但形成平行授权与审计路径，
  违反 ADR-0056。
- **Option B：向普通飞书会话发文本，让通用 Worker 自动写表。** 复用现有路由，
  但用户文本与机器事件无法形成可靠权限边界。
- **Option C：专用 Host ChannelAdapter、专用 Worker 和 Gateway 内容绑定凭证。**
  增加 operator topology 配置，但身份、授权、Schema、幂等和审计仍走既有链路。

## Decision

> **拍板**：选择 Option C。

Host 轮询只读挂载目录，确定性校验 JSON、构造字段，并生成绑定
`版本 + SHA-256 摘要 + 逻辑资源 + 精确字段` 的 HMAC 幂等键。专用
`voice-photo-json` ChannelAdapter 以配置的规范用户身份进入 Host 路由；专用
Worker 只执行 Describe、Authorize、Create、Record Get。Gateway 对
`machineIngestRequired` 资源在提交 Create 前验证凭证。凭证缺失、错误或字段
漂移全部 fail closed；该工作流禁止请求确认卡。

原图片通知不被替换：同一 Host 另行托管原图片监控器，继续用固定飞书 P2P
目标推送启动后新增图片。图片和 JSON 使用独立 SQLite 状态库、基线与重试；
任一链路失败不得修改或停止另一链路。

## Consequences

- **Positive**: 模型不推断字段；普通聊天不路由到机器组；Gateway 保留真实身份、
  writer policy、Schema、审计和幂等；NAS 始终只读；原图片推送体验保持不变。
- **Negative**: Host 和 Gateway 必须安全分发同一机器密钥；运维仍需核对 Gateway
  audit 和真实 Record ID。
- **Neutral / Trade-offs**: 首次扫描有意忽略全部现存 JSON。字段名和“测试版本”
  属于 operator 示例，不进入平台核心。

## Implementation Notes

- `examples/voice-photos-feishu-monitor/json-*.ts`
- `examples/voice-photos-feishu-monitor/image-adapter.ts`
- `examples/voice-photos-feishu-monitor/agent-group/AGENTS.md`
- `examples/reference-gateway/feishu-bitable-adapter.mjs`
- OpenSpec change `add-voice-photo-json-bitable-auto-ingest`

## References

- ADR-0056（飞书 Bitable 只经 Backend Gateway）
- ADR-0061（Bitable 可信用户读取与单条新增）
- ADR-0064（Group 专属指令）

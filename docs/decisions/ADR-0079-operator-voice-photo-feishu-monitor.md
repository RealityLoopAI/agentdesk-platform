# ADR-0079: 以独立运营服务轮询图片并直发固定飞书私聊

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: RealityLoop，Codex（提案与执行）
- **Tags**: `examples`, `feishu`, `smb`, `polling`, `sqlite`, `operator-service`

---

## Context

Vision producer 会异步向 `voice_photos` SMB 目录写入图片。需求是在服务启动并完成一次历史基线后，只把后来出现且写入稳定的图片发到固定的 RealityLoop 机器人私聊。该通知没有用户入站消息，也不需要模型理解、业务授权或长期业务记忆。

平台的 Agent Session 出站库只能由容器写入，Host 维护循环也必须保持业务无关。SMB 远程文件系统的 watch 事件可能丢失或重复，且监控进程不得向生产目录写确认标记。

## Options Considered

- **Option A: 独立运营服务 + 轮询 + 独立 SQLite**。不修改 Agent 消息语义和三库单写者边界；需要单独部署进程和保管状态库。
- **Option B: Agent skill 或合成用户消息**。可复用 Agent 回复链路，但 skill 不能无人值守运行，合成消息会混淆可信用户请求并引入模型成本与非确定性。
- **Option C: 加入 `host-sweep.ts` 或 Session outbox**。进程数量少，但会把特定 SMB 业务写入平台核心，或违反 Session 数据库写入所有权。
- **Option D: 依赖 `fs.watch`**。延迟较低，但 SMB 断线和事件丢失时无法作为可靠事实来源。

## Decision

> **拍板**：选 Option A，并以串行递归轮询作为唯一正确性来源。

监控器作为 `examples/voice-photos-feishu-monitor/` 中默认不启动的运营服务运行。操作系统以只读方式挂载 SMB；服务只接受本地绝对路径。首次完整扫描以事务方式建立不发送的历史基线，之后使用独立 SQLite 保存观察代次、不可变内容事件、发送租约和重试状态。

目的地启动时严格归一化为一个 `feishu:p2p:ou_*`。监控器直接调用抽取出的飞书图片传输组件，不创建 Agent turn、不加载 skill、不调用 Gateway，也不写 Lane、中央会话库或 `messages_out`。事件 ID 由规范相对路径与内容摘要生成，并映射为长度受限的稳定飞书 UUID。

## Consequences

- **Positive**: 不削弱身份信任链、Gateway 唯一路径或三库单写者约束；历史图片不会在首次启用时刷屏；重启、SMB 断线和飞书限流后可恢复。
- **Negative**: 需要运营者部署独立进程和保护本地 SQLite；轮询间隔内创建又删除的文件无法检测；每次轮询有远程目录枚举成本。
- **Neutral / Trade-offs**: 扫描预算超限时整轮 fail closed，不提交部分基线或部分观察；运营者应确认目录规模后显式调高限制。丢失 SQLite 会安全地重新基线，但期间已有图片会成为历史。

## Implementation Notes

- 监控器：`examples/voice-photos-feishu-monitor/`
- 共享飞书图片传输：`src/channels/feishu/outbound-image.ts`
- 飞书适配器复用：`src/channels/feishu.ts`
- 设计与验收：`openspec/changes/add-voice-photos-feishu-monitor/`
- 验收包括目标测试、Host 全量测试、container 测试、只读真实目录基线和固定私聊单图/重启不重放验证。

## References

- OpenSpec change: `add-voice-photos-feishu-monitor`
- ADR-0016: 出站投递韧性
- ADR-0070: 请求驱动的 Vision Archive Gateway

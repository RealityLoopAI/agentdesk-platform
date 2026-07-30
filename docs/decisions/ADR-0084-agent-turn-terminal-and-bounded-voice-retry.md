# ADR-0084: 用 Agent Turn 终态驱动语音队列与有界重试

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 产品/部署负责人，Codex（提案与执行）
- **Tags**: `agent-runner`, `host-runtime`, `xiaohuan`, `retry`, `queue`, `openai`, `context-management`
- **Supersedes**: ADR-0083 中“未产确认只能等待 15 分钟”的部分

---

## Context

真实小环连续语音测试出现一次方舟转写成功、Agent 上游模型最终返回 502。Runner
输出了用户错误，但 Bridge 只观察确认 delivered/resolved；该 turn 没有生成确认卡，
active draft 因此仍占用单飞槽位，后续第三至第五句只能排队到 15 分钟超时。

同一排障还发现两个独立问题：错误和 `/clear` 出站缺少 `in_reply_to`，Host 无法建立
可信回源；OpenAI provider 只按 transcript 字符数触发压缩，没有计入 system
instructions 和 tools，实际请求可能远大于本地判断。

## Options Considered

- **Option A：缩短未产确认超时。** 改动小，但慢 Agent 的迟到确认会与下一句重叠，
  且仍无法区分正常结束和可重试失败。
- **Option B：Bridge 解析聊天错误文本或轮询 Session DB。** 无需新增 Host 事件，但
  耦合展示文本和三 DB 实现，相关性脆弱，也容易形成旁路读取。
- **Option C：Runner 发通用 turn 终态，Host 转为只读事件，Bridge 建两阶段状态机。**
  是加性 container→host 观察契约；可以精确区分 processing、awaiting-confirmation
  和 provider-failed，并保持授权/确认路径不变。

## Decision

> **拍板**：选 Option C，并同时加入 Bridge 有界重试和完整请求上下文预算。

Runner 对每个已处理 turn 写出带可信 `in_reply_to` 的 `agent_turn_resolved` system
action。Host 只把它转换为进程内观察事件，不允许该事件批准或执行 Gateway 操作。
Bridge 正常完成后保留短 settle 窗口等待可能已经在途的确认卡；无卡则释放。有卡则继续
等待权威 confirmation resolved。

可重试的 5xx、timeout、rate limit 和 stale session 在 Bridge 层最多追加两次重试，
默认退避 5 秒、30 秒。fingerprint 和业务幂等来源保持不变，每个 attempt 使用唯一入站
message ID。OpenAI provider 的预算覆盖 transcript、instructions 和 tools；固定开销
本身超限时本地失败关闭。

## Consequences

- **Positive**: 单次 Provider 故障不再把后续语音锁死 15 分钟；错误能回到原会话；
  重试不会改变 Create 幂等意图；上下文过大在请求上游前得到处理。
- **Negative**: Host/Runner 多一个加性观察 action；Bridge 多两个定时器和一次 settle
  延迟；瞬态故障最多增加两次 Agent 调用成本。
- **Neutral / Trade-offs**: 本轮没有强制部署独立 machine-ingress Frontdesk。独立
  session 仍是推荐拓扑，完整请求预算负责兼容当前复用飞书 P2P session 的保护。

## Implementation Notes

- `container/agent-runner/src/poll-loop.ts`
- `container/agent-runner/src/providers/openai.ts`
- `src/modules/agent-turn/`
- `examples/xiaohuan-bitable-bridge/adapter.ts`
- `scripts/xiaohuan-bitable-bridge-adapter.test.ts`
- 所有 system observation 都只读，不改变 RequestIdentity、Gateway 授权或确认状态。

## References

- ADR-0024 OpenAI 上下文压缩
- ADR-0083 完整 WAV 回执与确认串行队列
- `openspec/changes/connect-xiaohuan-experiment-json-to-bitable/`

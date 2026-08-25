# ADR-0091: 由 Host 投影 Web 只读问题卡片

- **Status**: Accepted
- **Date**: 2026-07-31
- **Decider(s)**: 用户（要求 Web 补卡片但不实现交互确认）；coding agent（提案与执行）
- **Tags**: `web`, `feishu`, `interactive`, `history`, `security`, `backward-compat`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0062 让飞书回复持久化到同一 Conversation Lane 并出现在 Web History。标准
`ask_question` 出站在飞书 Adapter 中会转换为互动卡片，但 Web History 只有 `text` 字段，因此把
同一行的 `type/title/question/options` 原样显示为 JSON。

该消息正文由容器写入，不能直接成为浏览器组件协议；Web 也不得新增第二条回答路径，与飞书按钮竞态
解决同一个 Pending Question。现有根 Session 已保存 Host 写入的 `question_response`，中央数据库已
保存 Pending Question，因此只读状态可以从权威数据推导，无需新增 Transcript 或业务授权路径。

## Options Considered

- **Option A：把原始 `messages_out.content` 返回给浏览器并通用渲染。** 工作量最小，但把任意
  Agent JSON 变成开放 UI 协议，扩大 XSS、欺骗式控件和未来兼容风险。
- **Option B：为 Web 新增完整问题查询与回答 API。** 能在 Web 点击选项，但形成第二条解决路径，
  需要处理跨渠道抢占、身份校验和状态迁移，超出“只读卡片”范围。
- **Option C：Host 白名单解析并返回可选只读 Presentation。** 仅投影标准字段和 Host 可验证状态；
  保留文本回退，不提供回答端点，工作量适中。

## Decision

> **拍板**：选择 Option C。

Host 在完成 Lane 所有权和访问门检查后，只解析有界、完整的标准 `ask_question`，向 Web History
添加可选 `presentation.type='ask-question'`。Presentation 只包含标题、问题、选项 Label、选中
布尔值和只读状态；不包含原始 Option Value、回调 Payload、响应用户或任意附加 Agent 字段。

Web 用语义化非控件列表显示选项，不提供回答、确认、拒绝或取消接口。有效的 Host
`question_response` 可以把卡片显示为 `answered` 或 `cancelled`；无响应时根据精确 Pending 记录显示
`awaiting-external-response`，否则显示 `closed`。飞书回答持久化后复用
`conversation.message.available` 通知刷新，不新增 SSE 事件类型。

## Consequences

- **Positive**: Web 与飞书看到同一问题的可读形态；历史不再泄露机器 JSON；旧 Web 客户端仍可读
  `text`。
- **Positive**: 不新增 DB Schema、回答端点、业务授权输入或 Transcript 副本。
- **Negative**: Host History 需要解析并关联少量 System Response 和 Pending 记录；Presentation
  Schema 需要保持向后兼容。
- **Neutral / Trade-offs**: Web 用户只能查看，必须回到飞书等原响应渠道完成选择；缺少有效响应且
  Pending 已消失时只能显示 `closed`，不推断具体过期原因。

## Implementation Notes

- Host 投影与边界：`src/web/read-only-message-cards.ts`、`src/web/conversations.ts`
- 回答后刷新：`src/modules/interactive/index.ts`
- Web 组件：`web/src/messages/ReadOnlyQuestionCard.tsx`
- 契约与验收：`openspec/changes/render-readonly-web-message-cards/`
- 依赖 ADR-0062 的 Lane、三 DB 单写者、访问门和可重放 `web_events`。
- 验收使用既有 `msg-1785468763491-nw5p8s`，应显示“已选择：链路测试”，且飞书原消息投递状态不变。

## References

- ADR-0062
- `docs/web-feishu-unified-messaging-operations.md`
- `openspec/changes/render-readonly-web-message-cards/design.md`

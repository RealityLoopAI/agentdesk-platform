# ADR-0092: 隔离二进制 MCP 结果并逐次约束模型请求

- **Status**: Accepted
- **Date**: 2026-07-31
- **Decider(s)**: 用户（故障修复要求），coding agent（诊断、提案与实现）
- **Tags**: `agent-runner`, `openai`, `mcp`, `multimodal`, `context-budget`, `reliability`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

Windows GUI Worker 的 `gui_observe` 同时返回 accessibility tree 与 PNG
截图。OpenAI-compatible provider 把未知 MCP content block 统一
`JSON.stringify` 为工具文本，导致约 1.66 MB PNG 的 base64 被当作普通文本
送入只声明了文本工具结果的 Chat Completions 请求。该轮输入从约 64k token
膨胀到约 191 万 token，上游返回模型服务不可用。

原有请求预算只在一轮开始前检查。模型调用工具后追加的新结果没有再次检查，
而单个超大 transcript item 又能穿透保留最后一项的 hard trim。因此，即使首个
请求在预算内，第二个请求仍可能远超配置的
`OPENAI_MAX_REQUEST_CONTEXT_CHARS`。

当前部署使用第三方 OpenAI-compatible Chat Completions 网关，未验证其是否支持
把 MCP 图片转换为模型原生图片输入。官方 OpenAI 接口要求图片位于专门的图片
content block，而不是普通工具文本。

## Options Considered

- **Option A：继续把所有 MCP content JSON 化。** 无需改接口，但会把二进制
  数据伪装成文本，重复触发超大请求，不能接受。
- **Option B：默认省略二进制内容、保留元数据，并对工具文本和每次请求设硬
  上限。** 兼容文本型第三方网关，改动局部；模型不能在这条路径直接看图。
- **Option C：无条件把图片转换成原生多模态输入。** 官方 OpenAI 模型可行，
  但 Responses 与 Chat Completions 的 tool-result 续接形状不同，第三方网关
  能力未知；无条件启用会把当前确定的超限故障替换成协议兼容故障。

## Decision

> **拍板**：选 Option B；Option C 只有在 provider 明确声明并经过兼容性测试后
> 才能另行启用。

1. MCP `image` content 不得回退为 JSON 文本。当前文本 provider 路径只输出
   MIME type 与解码后字节数，不携带 base64。
2. 单个 MCP 文本结果限制为 64,000 字符；截断标记要求模型缩小参数后重试。
3. 请求预算在首个模型调用前和每次工具返回后都重新执行；裁剪不得保留孤立的
   `function_call_output`。
4. 发送前再检查实际序列化请求大小，作为所有转换逻辑之后的最终 fail-closed
   防线。
5. GUI `gui_observe` 默认只返回 accessibility tree；截图必须由调用者显式传入
   `include_screenshot: true`。

## Consequences

- **Positive**: base64 不再污染文本上下文；工具循环的每个上游请求都有同一
  预算上限；GUI 常规观察更快、更便宜。
- **Negative**: 当前 OpenAI-compatible 文本路径不能直接分析截图。a11y tree
  不足时，调用者会收到图片已省略的元数据，而不是视觉理解结果。
- **Neutral / Trade-offs**: 未来若要启用多模态，必须增加显式 provider
  capability、分别定义 Responses/Chat Completions 的图片续接结构，并用目标
  网关做契约测试；不能恢复“未知 block JSON 化”的兼容回退。

## Implementation Notes

- `container/agent-runner/src/providers/openai.ts`
- `container/agent-runner/src/providers/openai.test.ts`
- `examples/windows-gui-agent/agent-group/gui-agent-mcp.ts`
- `examples/windows-gui-agent/agent-group/skills/operate-windows-gui/instructions.md`
- `scripts/windows-gui-agent.test.ts`

验收包括：图片 base64 不出现在格式化工具文本中、文本结果有界、预算裁剪不产生
孤立工具结果、GUI 未显式请求时不访问 `/screenshot`、类型检查及定向测试通过。

## References

- [OpenAI Images and vision guide](https://developers.openai.com/api/docs/guides/images-vision)
- ADR-0024（OpenAI 上下文压缩）
- ADR-0086（Windows GUI MCP Worker）

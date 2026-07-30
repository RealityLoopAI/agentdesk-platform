# ADR-0071: Provider-neutral 的 Group 指令与私有 Skill

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（需求与验收），Codex（提案、执行、审计）
- **Tags**: `provider`, `agent-runner`, `prompt`, `skills`, `agent-group`, `openai`
- **Supersedes**: None
- **Superseded by**: None

---

## Context

Vision Archive 的真实飞书验收中，Feishu ingress、Frontdesk destination、
Archive Gateway 和 NAS 读取都可用，但 OpenAI Frontdesk 没有委派请求。原因是
Claude Code 会原生加载工作区 `CLAUDE.md` / `CLAUDE.local.md`，direct OpenAI
provider 只接收到 runtime identity/destination addendum。业务路由、安全规则和
Skill 因 Provider 不同而静默消失。

同时，Archive worker 配置为 `"skills": "all"`；这既没有表达业务 Skill 的
作用域，也会把无关的全局 Skill 加进专职 worker。

已知约束：

- 平台核心保持业务无关；
- group-local 指令必须对不同 Provider 等价；
- 原生加载 Provider 不应重复获得同一提示；
- 私有 Skill 不能成为授权或文件系统访问边界；
- Backend Gateway 身份链和只读约束保持不变。

## Options Considered

- **Option A: 只强化 destination 显示名称。** 改动小，但无法承载强制分类、
  Gateway 工作流和安全规则，仍会发生 Provider 漂移。
- **Option B: 每个 Provider 分别复制业务 prompt。** 可工作，但规则会分叉，
  新 Provider 容易再次遗漏。
- **Option C: Runner 为非原生 Provider 展开同一个 composed prompt，并支持
  group-private Skill。** 单一来源、可测试；需要有界导入解析和 Provider
  capability 标记。

## Decision

> **拍板**：选择 Option C。

Provider 声明是否原生加载 workspace instructions。声明为 true 的 Claude 路径
保持原行为；其他 Provider 由 runner 有界展开 composed `CLAUDE.md`，再附加
`CLAUDE.local.md` 和 runtime addendum。

Skill 解析采用 group-private 优先、shared fallback。业务 Skill 随
`examples/<pilot>/agent-group/skills/` 分发，并通过明确的 `skills` allowlist
只加载到目标 worker。

## Consequences

- **Positive**: OpenAI/未来 direct API Provider 能获得与 Claude 等价的 group
  路由、安全和 Skill 指令；真实演示不再依赖模型猜 destination。
- **Positive**: 业务 Skill 不进入全局 catalog，专职 worker 的提示更小、能力面
  更清晰。
- **Negative**: Runner 增加 Markdown import 展开器，需要维护根目录、深度、
  字节和循环限制。
- **Trade-off**: progressive disclosure 的 `load_skill` 仍以 shared Skill 为
  主；本决策的 group-private pilot 使用明确 allowlist + always-loaded 模式。

## Implementation Notes

- Provider capability: `container/agent-runner/src/providers/types.ts`
- Prompt expansion: `container/agent-runner/src/workspace-instructions.ts`
- Group-private resolution: `src/claude-md-compose.ts`,
  `src/container-runner.ts`
- Archive Skill:
  `examples/vision-archive-pilot/agent-group/skills/vision-archive-query/`
- 验收包括 unit tests、完整 host/container 回归和真实飞书消息。

## References

- ADR-0070: 请求驱动的 Vision Archive Gateway
- OpenSpec change: `add-on-demand-vision-archive-query`

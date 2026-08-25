# ADR-0080: 使用类型化的组级 Provider 模型覆盖

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: RealityLoop（需求与试验授权），Codex（提案与执行）
- **Tags**: `provider`, `container-config`, `agent-group`, `openai`, `security`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

OpenAI-compatible provider 当前从宿主全局环境读取 Base URL、API Key 和模型名。Vision Archive Worker 需要在不影响 Frontdesk 与其他 Worker 的前提下试用 `glm-5.2`，同时复用原有中转站、凭据与 Vault 行为。

`container.json#env` 的既有安全边界明确规定：组级普通环境变量不能覆盖 provider/system 环境。若为了模型试验开放 `env.OPENAI_MODEL` 的特殊优先级，会产生模糊的覆盖顺序，并为后续覆盖凭据、代理等敏感配置制造先例。

## Options Considered

- **Option A：修改全局 `OPENAI_MODEL`**。实现最少，但会同时切换所有 OpenAI-compatible 组，无法隔离试验和回滚。
- **Option B：允许 `container.json#env.OPENAI_MODEL` 覆盖 provider 环境**。字段已有，但破坏 provider/system 环境不可覆盖的边界，且难以阻止范围继续扩大。
- **Option C：新增类型化的 `providerModel` 字段**。只表达非秘密的模型选择，由宿主按 provider 显式映射到模型环境变量；工作量略高但边界清楚。

## Decision

> **拍板**：选 Option C。

`container.json` 新增可选 `providerModel`。宿主验证其为 1–128 个无控制字符的非空字符串，并仅为声明了映射的 provider 应用覆盖：`openai` / `codex` 映射到 `OPENAI_MODEL`。

覆盖发生在 provider contribution 构造之后，只替换模型键；Base URL、API Key、Vault withholding、超时、transport 和代理设置保持原样。无映射 provider 的配置不会转化为任意环境变量。

## Consequences

- **Positive**: 单个 Worker 可独立试验和回滚模型，不影响其他组，也不复制凭据到业务样例。
- **Positive**: `container.json#env` 的 provider/system 不可覆盖边界保持不变。
- **Negative**: 每种新 provider 若要支持组级模型选择，必须显式增加模型键映射。
- **Neutral / Trade-offs**: 该配置只隔离模型选择，不保证不同模型具有相同的 tool-calling 或事实一致性表现。

## Implementation Notes

- 配置与归一化：`src/container-config.ts`
- 启动时覆盖：`src/container-runner.ts`
- 运维参考：`docs/configuration-reference.md`
- 试点应用：`examples/vision-archive-pilot/agent-group/container.json`
- 相关决策：ADR-0035（OpenAI Vault 路由）、ADR-0071（Provider-neutral Group 指令）、ADR-0070（请求驱动 Vision Archive Gateway）
- 验收：配置恶意值、provider 映射、凭据/中转站继承及未配置时向后兼容测试。

## References

- `openspec/changes/trial-vision-archive-clean-context-glm/`

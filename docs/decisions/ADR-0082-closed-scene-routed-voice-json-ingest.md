# ADR-0082: 视觉 JSON 按封闭场景路由到多维表格

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（按 JSON 场景选择表），coding agent（实现与验证）
- **Tags**: `gateway`, `bitable`, `machine-ingress`, `scene-routing`, `fail-closed`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0080 建立了内容绑定的自动写表入口，但最初部署把所有合格 JSON 指向一个
克数表。真实多维表格按实验场景拆成多个表；因此 `场景一 / 650 rpm` 被错误地
拿去校验 `无水氯化铜（克）`，在单位检查阶段拒绝。

## Decision

运营配置提供封闭的 `场景 -> 逻辑资源 + 测量字段 + 允许单位 + 值类型 + 静态字段`
映射。Host 在 Agent 入口前做精确场景匹配、单位校验和字段构造，并把所选逻辑
资源及精确字段绑定进 ADR-0080 的 HMAC。每个逻辑资源由 Gateway 映射到对应物理
表并保留独立 Schema、writer policy、审计和幂等校验。

当前部署为：

- `场景一 -> voice.photo.scene1 -> 转速 (rpm)`
- `场景二 -> voice.photo.scene2 -> 无水氯化铜（克） (g/克)`
- `环境 -> voice.photo.environment -> 温度 (℃/°C/C)`

未知场景、单位不兼容、字段缺失或实时 Schema 不匹配全部 fail closed；禁止模型
猜测场景、回退到其他表、重命名字段或补充字段。

飞书 Number 字段可能以规范十进制字符串回读。核验按实时 Field List 类型处理：
仅 Number 字段允许有限十进制数值等价，其他字段仍严格相等；这不会改变 HMAC
绑定的 Create 输入。

## Consequences

- 场景一转速不会再触碰场景二的克数字段。
- 新增场景需要同时更新 Host 的封闭路由和 Gateway 逻辑资源，错误配置在启动时
  失败。
- 物理 app/table ID 仍只存在于 Gateway 配置，业务写入仍只有 Gateway 一条路径。

## References

- ADR-0056（飞书 Bitable 只经 Backend Gateway）
- ADR-0080（内容绑定的视觉 JSON 自动写表）
- OpenSpec change `add-voice-photo-json-bitable-auto-ingest`

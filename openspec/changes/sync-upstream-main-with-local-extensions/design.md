## Context

当前分支 `codex/feishu-bitable-record-query-create-update` 与 2026-08-20 刷新的 `origin/main@df5d239` 共同基点为 `986b92d`。实施前复核时本地分支独有 56 个提交、远端独有 29 个提交；双方有 45 个已提交文件重叠，远端共修改 134 个文件，最终树合并模拟至少产生 19 个文本冲突。当前工作区另有 7 个已跟踪文件修改和 20 个未跟踪文件，其中 `README.md` 和 `package.json` 与远端提交直接重叠。

远端提交改变了平台底座，包括 frontdesk 双模型路由、按用户状态目录、`agent_groups.role`、persona memory、A2A 返回归属、OCI runtime、admission queue，以及 ADR-0060 定义的“入口 Agent 对用户隐身、以一个助手统一表达”人设。本地提交在旧底座上增加了联邦身份、Web/飞书 Conversation Lane、Bitable Gateway 操作与确认、语音/图片 JSON 接入、Vision Archive 和 GUI Worker。两侧同时修改 Provider、Gateway、容器配置、路由、会话、数据库、依赖与架构文档。

本次集成必须遵守仓库载重不变量：身份信任链不可弱化；业务数据和授权只走 Backend Gateway；组织隔离留在 Host；中央 DB/inbound.db/outbound.db 保持单写者；可观测性保持只读。当前功能分支没有远端跟踪分支，也没有远端分支包含其 HEAD，因此可以在本地改写历史而不影响同事的共享分支。

## Goals / Non-Goals

**Goals:**

- 将本地扩展建立在实施时最新的 `origin/main` 上，并保留清晰、可审查的提交历史。
- 在任何历史改写前保存包含未提交文件的可恢复快照。
- 保留远端安全、隔离、路由、并发和容器运行时改进，同时保持本地业务扩展行为。
- 消除 ADR 与数据库迁移的编号冲突，并保证已有数据库按迁移名称连续升级。
- 通过空数据库、现有数据库副本和端到端业务链路验证后才恢复服务或发布分支。

**Non-Goals:**

- 不在本变更中新增 M1 业务能力、改变 Bitable schema 管理产品边界或重做语音/图片模型。
- 不把华聚或实验室业务逻辑写入平台核心。
- 不对 `origin/main` 做 force-push，不改写任何同事共享分支。
- 不直接在唯一的生产数据库上试跑迁移。
- 不在解决冲突时借机删除现有本地能力或放宽安全校验。

## Decisions

### 1. 使用本地快照分支保存完整 WIP

实施前从当前分支创建只在本地保留的备份分支，将经过敏感信息检查的 tracked/untracked WIP 作为单个快照提交保存，再回到原功能分支执行 rebase。核心 rebase 完成并通过第一轮验证后，才将该快照提交 cherry-pick 回来。

采用快照分支而不是只使用 stash，因为分支提交更容易审计、定位和长期恢复，也不会因后续 stash 操作被误覆盖。快照分支不得在未做凭证检查前推送。

### 2. 在实施时重新 fetch，并线性 rebase 到 `origin/main`

实施阶段先停止本地组合服务，再执行 `git fetch origin --prune`，记录新的远端 HEAD、merge-base 和左右提交数。当前两侧均无 merge commit，因此使用普通 `git rebase origin/main`，不使用 `--rebase-merges`。

不选择 merge commit，是因为用户明确要求 rebase，且当前分支未发布；线性重放也便于逐个判断本地扩展如何适配新的平台底座。

### 3. 按领域所有权处理冲突，不整树选择 ours/theirs

rebase 期间 `ours` 表示新的远端底座及已经重放的本地提交，`theirs` 表示当前正在重放的旧本地提交。禁止对目录或全部冲突执行统一 `--ours`/`--theirs`。

- 安全、组织隔离、per-user state、A2A ownership、dual-LLM routing、OCI runtime、admission queue：以远端实现为底座。
- Web/Feishu Lane、Bitable、Gateway confirmation、语音、图片/JSON、Vision Archive、GUI Worker：保留本地能力，以增量接口适配远端底座。
- Provider：同时保留远端 routing/execution continuation、persona/context budget 与本地 OpenAI-compatible transport、请求重试、provider model 选择。
- Gateway：同时保留远端 memory/persona 契约和本地 Bitable/confirmation 操作，不改变可信身份、签名代理和审计边界。
- Container config：保留远端安全读写、dual-LLM 与 OCI 配置，同时保留本地 `providerModel`、skills 和 MCP servers。
- Router、Session Manager、Delivery、poll-loop、schema 即使自动合并也进入强制人工复核清单。

### 4. ADR 编号采用远端优先、本地整段顺延

保留远端 ADR-0054～0060。将本地 ADR-0054～0085 作为连续区间整体加 7，变为 ADR-0061～0092。同步更新文件名、ADR 标题/正文互引、索引、代码注释、文档和 OpenSpec 引用。

不保留重复编号或增加后缀区分，因为 ADR 约定要求编号全仓单调递增且不可复用。评估未发现本地提交标题引用这些编号，因此无需为编号迁移重写提交信息。

### 5. 迁移文件顺延，但数据库迁移 name 保持稳定

保留远端 `036-agent-group-role`，将本地迁移 036～044 顺延为 037～045，并同步修改导出标识、索引、测试和文档。迁移对象的 `name` 字段保持原值。

迁移框架以 `schema_version.name` 判断是否已执行，数字 `version` 只是顺序提示，实际落库序号按执行顺序分配。因此保留 `name` 能让已运行本地迁移的数据库只补跑新的 `agent-group-role`，而新数据库会按合并后的计划依次执行全部迁移。

迁移顺序固定为：035 multi-tenant organizations → 036 agent-group-role → 037 user-identities → 后续 Web/Lane/Gateway 迁移。升级测试必须覆盖“旧本地数据库已有 user-identities 等 migration name、但没有 agent-group-role”的情况。

### 6. 依赖锁由合并后的 manifest 重新生成

先人工合并 `package.json`，保留远端依赖/安全 override/CI 需求和本地业务依赖及 `services:*` 脚本；随后使用项目包管理器重新生成 `pnpm-lock.yaml`。不手工拼接 lockfile 冲突块。

### 7. 使用分层验证门控制恢复与发布

验证分为四层：静态与完整单测；数据库新装/升级；平台载重不变量；业务扩展端到端。核心 rebase 未通过前三层前，不恢复 WIP；WIP 恢复后再次执行完整验证。任何失败都不得启动正式服务或推送替代分支。

## Risks / Trade-offs

- [逐提交 rebase 可能多次触发同一冲突] → 保留提交粒度以便审查，使用 `git rebase --show-current-patch` 和可选 rerere 辅助，但每次仍人工确认语义。
- [Git 自动合并掩盖身份或隔离回退] → 对 44 个重叠文件建立复核清单，并对 load-bearing invariants 运行专项测试。
- [ADR 批量重编号遗漏引用] → 使用语义映射区分远端 0054～0060 和本地旧编号，验证本地旧语义不存在残留引用，并校验 ADR 索引中编号唯一。
- [迁移重编号导致既有数据库误判] → 保持迁移 `name` 不变，在数据库副本上验证 `schema_version` 和最终 schema；绝不先操作唯一生产库。
- [依赖版本合并导致 native module 或 CI 差异] → 从合并后的 manifest 生成 lockfile，执行干净安装、typecheck、lint、完整测试和安全审计。
- [恢复 WIP 把旧 package 状态重新带回] → WIP 最后单独 cherry-pick，针对 `package.json` 人工保留新底座依赖后再次生成 lockfile。
- [服务在 rebase 中读取变化源码或触发数据库升级] → 实施前停止 Host、Bridge、Adapter、Worker 和监控组合启动进程，完成验收后统一恢复。

## Migration Plan

1. 停止当前组合服务，解析并记录实际 `DATA_DIR`，对中央数据库和必要的会话数据库创建只读验证副本。
2. 获取最新远端引用，记录 `origin/main` HEAD、merge-base、左右提交数、工作区清单和当前服务版本。
3. 创建本地备份分支；检查敏感信息后提交全部 WIP；返回原功能分支并确认工作区干净。
4. 执行线性 rebase，逐提交解决冲突；任何不能证明等价的提交不得 skip。
5. 完成 ADR 0061～0092 和迁移 037～045 的编号整理，保留迁移 name；合并 manifest 并重新生成 lockfile。
6. 运行静态检查、完整测试、schema drift 检查、新数据库迁移和旧数据库副本升级测试。
7. 验证身份链、组织隔离、per-user state、A2A、dual-LLM、admission queue、Web/飞书 Lane、Bitable、语音、图片/JSON、Archive 和 GUI Worker。
8. 核心验证通过后 cherry-pick WIP 快照，解决其独立冲突并重复验证。
9. 只在所有验收门通过后重建容器镜像、启动组合服务并进行人工演示回归。

回滚时首先停止服务；Git 历史使用备份分支恢复，数据使用升级前数据库副本恢复。若 rebase 尚未完成，使用 `git rebase --abort` 回到原提交；不得通过 reset 删除唯一备份。已经运行新代码的数据库不得仅靠切回旧代码视为完成回滚。

## Open Questions

- 实施开始时 `origin/main` 是否出现当前评估之后的新提交；若出现，必须重新生成冲突清单并确认 ADR/迁移最大编号。
- 实际部署使用的中央数据库和会话数据目录以运行环境配置为准，执行前必须解析出明确路径，不能假设为默认目录。

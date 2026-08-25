## ADDED Requirements

### Requirement: Rebase preflight is recoverable
实施流程 MUST 在改写功能分支历史前保存当前提交、全部经检查的 tracked/untracked WIP、远端目标提交、merge-base 和工作区清单，并确保恢复引用不会依赖未命名的临时状态。

#### Scenario: Dirty workspace is protected before rebase
- **WHEN** 当前功能分支存在未提交或未跟踪文件
- **THEN** 系统维护者先将这些文件保存在可审查的本地快照分支提交中，并在 rebase 前确认原功能分支工作区干净

#### Scenario: Preflight detects a changed upstream target
- **WHEN** 实施时 fetch 得到的 `origin/main` 不同于提案评估使用的提交
- **THEN** 系统维护者重新记录 merge-base、提交差异、文件重叠、ADR 最大编号和迁移最大编号后才继续

### Requirement: Shared upstream history remains immutable
实施流程 MUST 只重写没有被同事共享使用的本地功能分支，不得 force-push 或改写 `origin/main` 及其他同事分支。

#### Scenario: Current feature branch has no remote owner
- **WHEN** 分支检查确认当前 HEAD 不被任何远端分支包含且没有远端跟踪分支
- **THEN** 允许在本地对该功能分支执行 rebase，同时保留 rebase 前备份引用

#### Scenario: A shared branch is detected
- **WHEN** 实施前发现功能分支已经被推送或被其他开发者基于其工作
- **THEN** 实施流程停止改写该分支，并改用新的集成分支或与相关开发者确认协作方案

### Requirement: Conflict resolution preserves platform invariants and local extensions
合并结果 MUST 同时保留远端安全、隔离、路由、并发和容器运行时能力，以及本地 Web/Lane、Bitable、语音、图片/JSON、Archive 和 GUI 扩展；MUST NOT 通过全局 ours/theirs 选择绕过逐项审查。

#### Scenario: A load-bearing file has no textual conflict
- **WHEN** Router、Session、Delivery、poll-loop、Gateway、container config 或 schema 被 Git 自动合并
- **THEN** 该文件仍被加入人工语义复核，并通过对应身份、隔离或单写者测试后才视为完成

#### Scenario: Rebase conflict occurs in a shared core file
- **WHEN** 远端平台改进与本地扩展修改同一核心文件
- **THEN** 解决结果以远端平台机制为底座重新叠加本地能力，且保留身份签名、审计、组织隔离、Gateway-only 和三数据库单写者约束

### Requirement: ADR identifiers are globally unique
集成后的 ADR 文件、索引和引用 MUST 使用全仓唯一且单调递增的编号；远端 ADR-0054～0060 MUST 保留，本地原 ADR-0054～0085 MUST 迁移为 ADR-0061～0092。

#### Scenario: Local ADRs are renumbered
- **WHEN** 远端 ADR-0054～0060 与本地 ADR 区间发生编号重叠
- **THEN** 本地 ADR 文件名和所有有效引用整体加 7，且索引中不存在重复编号

#### Scenario: Stale ADR references remain
- **WHEN** 全仓校验发现某个本地旧 ADR 编号仍指向迁移前语义
- **THEN** 验收失败并阻止发布，直到引用被更新或明确证明属于远端 ADR

### Requirement: Database migrations remain upgrade-compatible
集成后的迁移计划 MUST 保留远端 `036-agent-group-role`，将本地原 036～044 顺延为 037～045，并 MUST 保持本地迁移对象的持久化 `name` 不变。

#### Scenario: New database is initialized
- **WHEN** 合并后的代码在空数据库上运行完整迁移
- **THEN** 035 之后依次执行 agent-group-role、user-identities、Web/Lane 和 Gateway 迁移，最终 schema 与 `schema.ts` 一致

#### Scenario: Existing local database is upgraded
- **WHEN** 数据库的 `schema_version` 已包含本地 user-identities、Web/Lane 和 Gateway migration name，但没有 agent-group-role
- **THEN** 升级只补跑缺失的 agent-group-role 及其他真正缺失的 migration name，不重复破坏已有表和数据

#### Scenario: Migration numbering changes
- **WHEN** 本地迁移文件和导出变量被重编号
- **THEN** 迁移 `name`、升级幂等性和现有数据库识别结果保持不变，相关测试和文档引用同步更新

### Requirement: Dependency resolution is reproducible
集成流程 MUST 从人工确认后的 `package.json` 重新生成 `pnpm-lock.yaml`，MUST NOT 通过保留未解析冲突块或手工拼接两个 lockfile 完成依赖合并。

#### Scenario: Both sides changed dependencies
- **WHEN** 远端安全升级和本地业务依赖同时修改 manifest 与 lockfile
- **THEN** 维护者先合并 manifest，再由 pnpm 生成一致的 lockfile，并通过干净安装、lint、typecheck、测试和安全检查

#### Scenario: WIP reintroduces package scripts
- **WHEN** 核心 rebase 后恢复的 WIP 修改 `package.json`
- **THEN** 保留新底座依赖及 override，同时恢复经过确认的本地脚本，并再次生成和验证 lockfile

### Requirement: Validation gates precede WIP restoration and service startup
实施流程 MUST 在核心 rebase 通过静态检查、数据库兼容和载重不变量测试后才恢复 WIP，并 MUST 在完整业务链路通过后才启动正式组合服务或发布分支。

#### Scenario: Core integration tests fail
- **WHEN** typecheck、lint、完整测试、schema drift、数据库升级或身份隔离测试任一失败
- **THEN** 不恢复 WIP、不启动正式服务，并继续修复或回滚到备份分支

#### Scenario: Core integration passes
- **WHEN** 核心 rebase 已通过静态、数据库和平台不变量验证
- **THEN** 允许单独 cherry-pick WIP 快照并再次执行完整验证

#### Scenario: Full business regression passes
- **WHEN** Web/飞书 Lane、Bitable CRUD/确认、语音、图片/JSON、Archive、GUI Worker 和 admission queue 全部通过验证
- **THEN** 允许重建镜像、启动组合服务并进入人工演示验收

### Requirement: Rollback preserves code and data recovery points
迁移过程 MUST 同时保留 Git 历史恢复点和数据库升级前副本；任一恢复点缺失时 MUST NOT 在正式数据上启动合并后的代码。

#### Scenario: Rebase is incomplete
- **WHEN** rebase 过程中出现无法安全解决的冲突
- **THEN** 可以通过 `git rebase --abort` 返回原功能分支状态，且 WIP 仍存在于备份分支

#### Scenario: New code has already migrated a database copy
- **WHEN** 合并后的代码验证失败且已对数据库副本执行迁移
- **THEN** 丢弃该验证副本并从升级前副本重新开始，不把代码回退误认为数据库回滚

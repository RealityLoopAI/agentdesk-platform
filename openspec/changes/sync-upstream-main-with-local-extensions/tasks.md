## 1. 停服、盘点与恢复点

- [x] 1.1 使用现有服务管理脚本停止 Host、Web、语音 Bridge、图片/JSON Adapter、Bitable/Archive Worker 和监控组合进程，并记录停服前健康状态
- [x] 1.2 解析实际 `DATA_DIR`、中央数据库和会话数据库路径，逐项确认目标不是符号链接或意外目录后创建升级前验证副本
- [x] 1.3 执行 `git fetch origin --prune`，记录最新 `origin/main`、当前 HEAD、merge-base、左右提交数、merge commit 数和远端分支包含关系
- [x] 1.4 重新统计双方修改文件、重叠文件、文本冲突预估、ADR 最大编号和迁移最大编号；若不同于提案基线，更新 design 中的评估结果
- [x] 1.5 审查 tracked/untracked WIP 是否包含密钥、数据库、录音、图片、日志或客户数据，移除不应进入 Git 快照的内容
- [x] 1.6 创建仅本地使用的 pre-rebase 备份分支，提交经审查的完整 WIP，记录快照 commit，并确认不推送该分支
- [x] 1.7 返回 `codex/feishu-bitable-record-query-create-update`，确认工作区干净且备份分支能够完整恢复原 HEAD 和 WIP

## 2. 将本地提交重放到远端底座

- [x] 2.1 在当前功能分支执行普通 `git rebase origin/main`，记录 rebase 起始目标且不使用 `--rebase-merges`、全局 ours/theirs 或自动 skip
- [x] 2.2 对每个冲突使用 `git rebase --show-current-patch` 和 index stages 确认 base/远端底座/本地提交的语义后再解决
- [x] 2.3 合并 SECURITY、CI、`package.json` 和供应链改动，保留远端安全修复与本地实际需要的脚本/依赖声明
- [x] 2.4 合并 Runner Provider 与入口，保留远端 dual-LLM、persona、context budget/continuation 机制和本地 OpenAI-compatible transport、重试、provider model 能力
- [x] 2.5 合并 Gateway 工具与文档，保留远端 memory/persona 契约和本地 Bitable/confirmation 契约，并检查签名代理、RequestIdentity 与 `gateway_audit` 未被绕过
- [x] 2.6 合并 container config/runner，保留远端安全读写、per-user state、OCI runtime 和本地 `providerModel`、skills、MCP servers 配置
- [x] 2.7 人工复核 Router、Session Manager、Delivery、poll-loop、host-sweep、metrics、A2A 和 schema 的所有自动合并结果
- [x] 2.8 完成全部提交重放，确认没有未解决冲突标记、没有未经证明的 skipped commit，并保存 rebase 前后提交映射

## 3. ADR 编号迁移

- [x] 3.1 生成并审查本地 ADR 映射表：0054→0061、0055→0062，依次直到 0085→0092，同时保留远端 0054～0060
- [x] 3.2 使用两阶段临时文件名重命名本地 ADR 文件，避免顺序重命名时覆盖目标文件
- [x] 3.3 更新每份 ADR 的编号、自身标题、相互引用、`docs/decisions/README.md` 索引、代码注释和相关架构/配置文档
- [x] 3.4 更新 OpenSpec proposal/design/tasks/spec/verification 中指向本地旧 ADR 语义的引用，不误改指向远端新 ADR-0054～0060 的引用
- [x] 3.5 全仓校验 ADR 文件名和索引编号唯一、0061～0092 连续，并逐项判断残留的 0054～0060 引用确实属于远端 ADR

## 4. 数据库迁移编号与升级兼容

- [x] 4.1 保留远端 `036-agent-group-role.ts`，将本地 036～044 迁移文件和对应测试文件安全顺延为 037～045
- [x] 4.2 更新本地迁移导出标识、import、迁移数组与测试引用，固定顺序为 035 organizations → 036 agent-group-role → 037 user-identities → 038～045 本地后续迁移
- [x] 4.3 逐项断言本地迁移对象的持久化 `name` 与 rebase 前完全一致，并增加防止 name 意外变化或重复的回归测试
- [x] 4.4 合并 `schema.ts` 的远端 `agent_groups.role` 与本地 identity/Web/Lane/Gateway schema，运行 schema/migration drift 守卫
- [x] 4.5 更新 `docs/db-central.md`、ADR、OpenSpec verification 和测试命令中的迁移文件编号引用
- [x] 4.6 在空数据库上运行完整迁移，验证全部表、索引、约束、`agent_groups.role` 和本地扩展 schema
- [x] 4.7 在升级前数据库副本上运行迁移，验证已有本地 migration name 不重复执行、缺失的 `agent-group-role` 正确补跑且业务数据保持不变
- [x] 4.8 重复运行合并后的迁移计划，验证幂等且 `schema_version.name` 无重复或遗漏

## 5. 依赖与静态质量门

- [x] 5.1 人工确认合并后的 `package.json` 同时保留远端依赖升级、安全 overrides、lint 配置和本地 Web/Bitable/语音/GUI 依赖
- [x] 5.2 从无冲突的 manifest 使用 pnpm 重新生成 `pnpm-lock.yaml`，确认文件中无 conflict marker 且 lockfile 可以冻结安装
- [x] 5.3 执行 `pnpm typecheck` 和 CI 对应的 eslint 检查，修复所有由接口合并或依赖升级导致的错误
- [x] 5.4 执行完整 `pnpm test`，对需要监听本地端口的测试使用允许 loopback 的测试环境，不把 sandbox `EPERM` 误判为代码失败
- [x] 5.5 执行仓库供应链审计和 schema drift 检查，确认远端已修复的高危 advisory 未被本地 lockfile 回退

## 6. 平台载重不变量与核心能力回归

- [x] 6.1 验证 batch RequestIdentity、`origin_user_id` A2A 传播、HMAC、Gateway signing proxy 和 `gateway_audit` 的身份信任链测试
- [x] 6.2 验证 Host 侧跨组织拒绝、RBAC scope、Gateway org 隔离以及 Backend Gateway-only 业务访问路径
- [x] 6.3 验证中央 DB/inbound.db/outbound.db 单写者、open-write-close 和附件路径 containment 未被本地扩展削弱
- [x] 6.4 验证 per-user state scope、旧 session continuation、自愈逻辑和 Conversation Lane 同时成立且不会跨用户串上下文
- [x] 6.5 验证 A2A owner cross-check、turn-anchor return path 与本地 cross-channel reply mirroring 不产生重复回复或跨用户回传
- [x] 6.6 验证 dual-LLM frontdesk 路由/执行、Provider continuation、context budget、`providerModel` 和 OpenAI-compatible transport 组合
- [x] 6.7 验证 OCI runtime 配置、container config 保全、admission queue FIFO/关闭排空和相关 Prometheus 指标

## 7. 本地业务扩展回归

- [x] 7.1 验证 Feishu SSO、Web 登录、会话列表、SSE 重放、消息幂等和 Web/飞书同一 Conversation Lane
- [x] 7.2 验证 Bitable `field.list`、查询、新增、更新、删除确认、逻辑资源审计和 Gateway confirmation 生命周期
- [x] 7.3 验证语音 Bridge 的早期确认、转录镜像、重试边界、字段归一化与确认后写表链路
- [x] 7.4 验证图片/JSON Adapter 的内容绑定、场景路由、飞书投递、Archive 检索和 Bitable 写入链路
- [x] 7.5 验证 Windows GUI Worker、二进制 MCP 结果预算和远端 Provider/context 改动兼容
- [x] 7.6 验证业务扩展仍位于 `examples/` 或 operator 部署层，没有向平台核心引入华聚/实验室专用逻辑

## 8. 恢复 WIP 并二次验证

- [x] 8.1 仅在第 4～7 组全部通过后 cherry-pick pre-rebase WIP 快照，保留备份分支直到最终验收完成
- [x] 8.2 解决 WIP 的 `package.json` 冲突，保留新底座依赖和 overrides，同时恢复 `services:*` 评测脚本，并重新生成 lockfile
- [x] 8.3 复核本地评测文档、launchd 服务脚本、监控 Compose、Web 模型选择器和对应测试在新底座上的行为
- [x] 8.4 再次执行 typecheck、lint、完整测试、迁移兼容、身份隔离和供应链检查
- [x] 8.5 比较备份快照与最终分支，确认每项 WIP 已恢复、明确替代或记录为有意舍弃，没有静默丢失文件

## 9. 服务恢复、人工验收与交付

- [x] 9.1 在所有自动化门通过后重新构建 agent 容器镜像，并使用统一服务进程启动 Host、Web、语音 Bridge、图片/JSON Adapter、Bitable/Archive Worker 和监控栈
- [x] 9.2 验证 Web、Host `/readyz`、语音入口、签名代理、Bitable、Archive、Prometheus、Grafana 和 Phoenix 的端口与健康探针
- [ ] 9.3 人工完成飞书/Web 普通对话、语音唤醒、拍照/JSON、确认卡、Bitable 查询/写入和归档查询的端到端演示
- [ ] 9.4 检查日志、`gateway_audit`、企业审计、指标和 trace，确认没有身份漂移、跨用户混线、重复投递、502 或未消费任务
- [ ] 9.5 记录最终远端基点、rebase 后 HEAD、ADR/迁移映射、数据库验证结果、测试结果和服务健康结果
- [ ] 9.6 确认不需要 force-push 共享分支；如需发布，推送新的集成分支并通过 PR 合入，不删除 pre-rebase 备份直到 PR 与现场验收完成

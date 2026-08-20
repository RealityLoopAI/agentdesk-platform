# Rebase 与迁移验证记录

## Git 恢复点

- 远端底座：`origin/main@df5d239`
- Rebase 前功能提交范围：`986b92d..86a8abb`（56 个提交）
- Rebase 后功能提交范围：`origin/main..601f14e`（56 个提交）
- OpenSpec 计划提交：`2951614` → `fc09e35`
- 本地备份分支：`codex/backup-pre-rebase-20260820`
- WIP 快照：`ceb2dfb`
- 数据库只读恢复副本：`data/rebase-backups/20260820-pre-rebase-86a8abb/`

`git range-diff` 的逐项映射如下。第 6、22、38 项因冲突解决和底座依赖变化显示为
左右各一条，而不是 `=`/`!`；提交位置、主题和最终内容审计均一一对应，没有执行
`git rebase --skip`。

| # | Rebase 前 | Rebase 后 |
|---:|---|---|
| 1 | `f4bd05c` | `60417ce` |
| 2 | `b5abf6d` | `638c909` |
| 3 | `625177d` | `880afcd` |
| 4 | `6a7d268` | `c1ddec6` |
| 5 | `b9ba984` | `f1763ed` |
| 6 | `e2ef42c` | `e7deefb` |
| 7 | `5ad9bd1` | `753a706` |
| 8 | `e44921e` | `5980d27` |
| 9 | `17df447` | `0780d0d` |
| 10 | `7e001b5` | `d030405` |
| 11 | `a89d6ac` | `6d94e6c` |
| 12 | `eac9917` | `7193f02` |
| 13 | `40d8995` | `3a36dbf` |
| 14 | `d0e7bed` | `669d23f` |
| 15 | `d3293c7` | `fbe4d6c` |
| 16 | `cf66a27` | `041e1a0` |
| 17 | `abd1945` | `9436ef1` |
| 18 | `cd825d5` | `07d9509` |
| 19 | `c18271c` | `b251a2c` |
| 20 | `87494c2` | `d73be56` |
| 21 | `4685ab8` | `2ecf1d2` |
| 22 | `9d0c28f` | `fca8f83` |
| 23 | `21f5a7e` | `57a4329` |
| 24 | `af8be02` | `fc9dfd3` |
| 25 | `3f34276` | `ca0a7bf` |
| 26 | `c8f0339` | `00396f6` |
| 27 | `c69026d` | `9235420` |
| 28 | `758e0eb` | `ae77202` |
| 29 | `bbae3d9` | `4930753` |
| 30 | `eb8e7b1` | `7e10d47` |
| 31 | `f0b8505` | `0e76850` |
| 32 | `b4b0f31` | `8d26ae7` |
| 33 | `911e465` | `23bc67e` |
| 34 | `c854327` | `28da3ea` |
| 35 | `be5eae1` | `13d51bf` |
| 36 | `c236ae9` | `c67a48b` |
| 37 | `121fa5a` | `ac895d8` |
| 38 | `5f87d18` | `e92c7e0` |
| 39 | `75c85bf` | `ea50a75` |
| 40 | `f8c6238` | `1daf954` |
| 41 | `772c809` | `314f78d` |
| 42 | `900a817` | `3e20dea` |
| 43 | `c963018` | `5be1ad8` |
| 44 | `917db94` | `f5e6db7` |
| 45 | `525cfda` | `5d294ed` |
| 46 | `1e0d0af` | `c357f77` |
| 47 | `bd9bd8d` | `761b44f` |
| 48 | `2109eda` | `937d5c9` |
| 49 | `d8c2970` | `32299dc` |
| 50 | `72acc35` | `a9fc1af` |
| 51 | `af11c3a` | `61a6b82` |
| 52 | `932392c` | `567de10` |
| 53 | `5e36ead` | `9ecbb24` |
| 54 | `4e0bf59` | `0da0677` |
| 55 | `da83514` | `4ec1ded` |
| 56 | `86a8abb` | `601f14e` |

## ADR 映射

- 保留远端 `ADR-0054`～`ADR-0060`。
- 本地 ADR 整体顺延 7：`0054→0061`、`0055→0062`，依次到 `0085→0092`。
- 自动校验结果：文件编号唯一；文件名与一级标题一致；索引链接全部存在且编号唯一；
  `0061`～`0092` 连续无缺口；残留的 `0054`～`0060` 引用逐项属于远端语义。

## 数据库迁移映射与兼容性

- 保留远端 `036-agent-group-role.ts`。
- 本地文件 `036`～`044` 顺延为 `037`～`045`，持久化 `name` 保持不变。
- 新增 `migration-plan-integrity.test.ts` 固定已部署名称、合并顺序、唯一性和重复运行幂等性。
- 空库迁移 + schema drift：5 个测试文件、10 个测试通过。
- 升级前数据库副本：升级前 42 个迁移；仅新增 `agent-group-role`；升级后 43 个；
  所有业务表行数保持一致；第二次运行无新增；`schema_version.name` 无重复。

## 第一次质量门（恢复 WIP 前）

- 依赖：从合并后的 manifest 重新生成 `pnpm-lock.yaml`；冻结、离线 lockfile 校验通过；
  Runner 的 `bun.lock` 在安全 overrides 更新后通过 `bun install --frozen-lockfile`。
- 静态检查：Host `pnpm typecheck`、Runner `bun run typecheck`、Web typecheck 和 Web production build
  全部通过；ESLint 为 0 error（保留 210 个既有 warning）。
- Host：完整 Vitest 为 138 个文件、1365 项通过；Reference Gateway 为 36 项通过。
- Runner：40 个文件、438 项、1183 个断言通过，覆盖 RequestIdentity、A2A、dual-LLM、
  continuation、OpenAI-compatible transport、MCP 二进制结果与请求预算。
- Web：8 个文件、23 项通过；迁移后的 Web/飞书/Gateway/语音图片专项回归为 30 个文件、
  250 项通过。
- 小华 Bridge：独立 TypeScript 检查和 `assertChannelAdapterContract` 自检通过。
- 供应链：Host 的 production high-level 审计仅保留 `SECURITY.md` 已记录且与静态 SPA 无关的
  React Router RSC advisory；Runner 无 high，仅保留已记录的 Anthropic 本地 filesystem memory
  tool 默认权限 moderate advisory，平台 Gateway memory 路径不调用该工具。
- 业务边界：`src/` 中没有华聚、实验室或 Xiaohuan 专用逻辑；核心中的飞书 Bitable 代码仅为
  通用 Gateway 操作、确认和凭证无关审计契约，具体映射、语音、图片、Archive 与 GUI Worker
  均位于 `examples/`。

WIP 恢复、第二次全量质量门和运行态验收结果在后续步骤追加。

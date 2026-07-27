# 实施验证记录

## 变更前基线

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 依赖 | `pnpm install --frozen-lockfile` | 通过 |
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Host 测试 | `pnpm test` | 通过，76 个测试文件、864 个测试 |
| Runner 依赖 | `bun install --frozen-lockfile` | 通过 |
| Runner 类型检查 | `bun run typecheck` | 通过 |
| Runner 测试 | `bun test` | 通过，320 个测试 |

受限沙箱内运行 Host 测试时，`scripts/q.test.ts` 的 7 个子进程用例因 `tsx` 无权创建本地 IPC
而失败；在允许本地 IPC 的执行环境中复跑后 864/864 全部通过。该环境差异发生在任何实现
修改之前，不属于本变更的代码回归。

## 规范用户与外部身份数据层

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| 身份层类型检查 | `pnpm typecheck` | 通过 |
| 身份迁移、DB 模块、Sender Resolver、飞书可信身份、Organization/Gateway 守卫 | `pnpm exec vitest run src/db/migrations/036-user-identities.test.ts src/db/user-identities.test.ts src/modules/permissions/user-identity-resolver.test.ts src/channels/feishu-webhook.test.ts src/modules/permissions/operability-gateway-isolation.test.ts` | 通过，5 个测试文件、35 个测试 |
| Host 全量回归 | `pnpm test` | 通过，79 个测试文件、874 个测试 |

本阶段还验证了新 Channel Inbound 会由 Host 把解析后的规范用户写入
`messages_in.origin_user_id`。旧 Session 行仍可回退到正文中的 `senderId`，但新身份映射不会
在 A2A 多跳中退化回未经映射的外部 ID。

## Web 配置、认证数据层与飞书 SSO 核心

验证日期：2026-07-27

| 范围 | 命令 | 结果 |
|---|---|---|
| Host 类型检查 | `pnpm typecheck` | 通过 |
| Web 配置、Hash Session、一次性 OAuth 事务、飞书 SSO 与身份冲突 | `pnpm exec vitest run src/web/feishu-sso.test.ts src/db/web-auth.test.ts src/config-validate.test.ts` | 通过，3 个测试文件、47 个测试 |

SSO 测试覆盖合法登录、浏览器绑定的 State、S256 PKCE、Code 重放拒绝和已登录用户身份冲突
Fail Closed。持久化快照断言数据库与 Enterprise Audit 中均没有飞书 App Secret、Authorization
Code、Access Token、原始 Web Session Token 或原始 CSRF Token。

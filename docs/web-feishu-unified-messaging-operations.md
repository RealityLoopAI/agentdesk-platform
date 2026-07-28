# Web 与飞书统一消息：部署、分阶段启用和回滚手册

本文面向第一次接手项目的开发者和运维人员，说明怎样安全地启用 Web 端、怎样让同一位用户在 Web
和飞书中继续同一条会话，以及怎样开放飞书多维表格能力。先记住三个边界：

1. **飞书聊天适配器**只收发聊天消息，不读写多维表格。
2. **Host**负责登录身份、Organization/Agent Group 访问控制、Session 和跨渠道 Lane。
3. **Backend Gateway**是多维表格授权和执行的唯一入口，只有它可以持有飞书应用凭证和真实
   `app_token`/`table_id`。

这三个边界不能为了部署方便而合并。尤其不能把多维表格 Secret 放进浏览器、Agent Prompt、
Channel Adapter 或 Agent 容器。

## 1. 四个独立 Feature Flag

| 开关                           | 所属进程 |  默认值 | 打开后发生什么                                                | 关闭后的保证                                                |
| ------------------------------ | -------- | ------: | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `WEB_ENABLED`                  | Host     | `false` | 启动独立 Web Listener，提供 SSO、API、SSE 和前端静态文件      | 不监听 `WEB_PORT`；飞书入口继续工作                         |
| `CROSS_CHANNEL_LANES_ENABLED`  | Host     | `false` | 原生飞书消息可按已验证的 Identity + Binding 自动命中 Web Lane | 飞书继续使用旧 Session Key；Web 自己的 Lane 不受影响        |
| `FEISHU_BITABLE_READ_ENABLED`  | Gateway  | `false` | `/describe` 发布 5 个多维表格只读 Operation                   | 只读 Operation 不可发现，直接调用返回 `OPERATION_NOT_FOUND` |
| `FEISHU_BITABLE_WRITE_ENABLED` | Gateway  | `false` | `/describe` 发布 6 个 Record 写 Operation                     | 写 Operation 不可发现，也不会触达飞书 API                   |

这里的“独立”是指可以分别回滚，不代表可以跳过依赖。例如，打开
`CROSS_CHANNEL_LANES_ENABLED` 前仍必须有经过验证的 `user_identities` 和
`conversation_bindings`；打开多维表格写操作前仍必须先配置资源白名单、用户授权、确认和幂等。

Host 在每次原生 Channel 路由时读取 Lane 开关，但生产环境仍建议修改配置后重启，以便部署记录、
进程状态和实际行为一致。Web Listener 与参考 Gateway 的 Operation Catalog 都在启动时确定，
修改相应开关后必须重启所属进程。

## 2. Web 与飞书 SSO 配置

### 2.1 飞书开放平台

使用产生聊天事件的同一个飞书应用配置 Web SSO，至少确认：

- 已配置浏览器重定向地址：
  `https://<你的域名>/auth/feishu/callback`；
- 地址必须与 `WEB_PUBLIC_ORIGIN` 拼出的地址逐字一致；
- 当前只读取登录结果中的 `open_id`，`FEISHU_SSO_SCOPE` 默认留空，Host 不会在授权地址中强制附加
  `scope` 参数；
- 只有部署确实需要额外用户字段或 API、且应用已经开通对应 OAuth 权限时，才填写飞书开放平台当前
  文档列出的有效 Scope；
- 聊天事件和 SSO 返回的是可以在同一个 `FEISHU_APP_ID` Scope 下比较的身份。

这里有两个容易混淆的“Scope”：`FEISHU_SSO_SCOPE` 是浏览器登录时向飞书额外申请的 OAuth
权限；下文的 App Scope 是 `open_id` 所属的飞书应用边界。二者不是同一概念。飞书 `open_id`
是应用范围内的标识。项目在 `user_identities` 中使用
`provider + provider_scope + identifier_type + external_subject` 作为唯一外部身份，其中
`provider_scope` 通常就是 `FEISHU_APP_ID`。如果聊天 Bot 和 SSO 使用不同应用，即使两边看起来是
同一个人，也不能仅凭相似字符串自动合并；应先确认飞书的身份换取/映射方案，再由受审计的身份关联
流程处理。冲突时系统会 Fail Closed，不会“猜一个用户”。

### 2.2 Host 环境变量

最小生产配置示例：

```dotenv
WEB_ENABLED=true
CROSS_CHANNEL_LANES_ENABLED=false
WEB_PORT=3100
WEB_PUBLIC_ORIGIN=https://agent.example.com
WEB_SESSION_SECRET=<使用 openssl rand -hex 32 生成并从 Secret Manager 注入>
WEB_SESSION_IDLE_TTL_MINUTES=60
WEB_SESSION_ABSOLUTE_TTL_HOURS=24
WEB_AUTH_TRANSACTION_TTL_MINUTES=10
WEB_COOKIE_NAME=agentdesk_web_session
WEB_ALLOW_INSECURE_HTTP=false
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=<从 Secret Manager 注入>
# 当前 open_id 登录流程不需要强制附加 OAuth Scope
FEISHU_SSO_SCOPE=
```

不要把示例占位符直接用于运行。启动校验会拒绝弱 Secret、非 HTTPS 公网 Origin、超出范围的 TTL 和
含糊的 Feature Flag 值。完整参数见 [`.env.example`](../.env.example) 和
[`src/web/config.ts`](../src/web/config.ts)。

`FEISHU_SSO_SCOPE` 未填写或只包含空白时，授权跳转不会携带 `scope` 参数；明确填写时，Host 会原样
传给飞书，不会替你猜测或扩张权限。不要填写已经下线、拼写不确定或应用尚未审批的 Scope。

本机开发可设置 `WEB_ALLOW_INSECURE_HTTP=true`，但只允许
`http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。它不是生产反向代理的替代品。

## 3. 反向代理

Web Listener 监听独立的 `WEB_PORT`。公网只应暴露反向代理，飞书 Webhook、Metrics 和 Web
Listener 继续使用各自端口。下面是 Nginx 最小示例：

```nginx
server {
  listen 443 ssl http2;
  server_name agent.example.com;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # SSE 需要及时把事件送给浏览器，不能在代理层缓冲。
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
}
```

检查项：

- TLS 证书有效，浏览器最终 Origin 与 `WEB_PUBLIC_ORIGIN` 完全一致；
- `/healthz` 返回 `200`；
- `/api/*`、`/auth/*` 不被代理缓存；
- `text/event-stream` 响应不被缓冲、压缩聚合或中途截断；
- 不要由 CDN 缓存 HTML、认证响应或 SSE；Hash 静态 Asset 的缓存策略由 Host 返回；
- 不要在代理层删除 Host 返回的 CSP、HSTS、`X-Content-Type-Options` 等安全 Header。

## 4. Cookie、CSRF 与浏览器 Session

浏览器 Cookie 只保存随机、不透明的 Session Token，并带 `HttpOnly`、`SameSite=Lax`；生产 HTTPS
还带 `Secure`。数据库只保存加 Key 的 Hash，不保存可直接重放的 Token。飞书 OAuth Access Token、
Refresh Token 和 Authorization Code 不落中央数据库。

对会改变状态的 API，浏览器必须同时满足：

- 有效的服务端 Web Session；
- 请求 `Origin` 与 `WEB_PUBLIC_ORIGIN` 完全一致；
- 提交服务端为该 Session 派生的 CSRF Token。

因此，“能读到页面”不等于“能伪造发消息请求”。不要在反向代理里伪造 Origin，也不要把
`WEB_SESSION_SECRET` 或 CSRF Token 写进前端构建环境变量、日志、Trace 或监控标签。

单用户登出走 `/auth/logout`。运营者撤销单个用户或全体 Session 时，先停止 Host，使用带审计的
CLI；命令默认只预览：

```bash
pnpm exec tsx scripts/revoke-web-sessions.ts \
  --all \
  --actor canonical-operator-id \
  --reason unified-messaging-rollback
```

核对候选用户后才添加 `--execute`。只撤销一个人时将 `--all` 改为
`--user <canonical-user-id>`。不要直接 `DELETE web_auth_sessions`，否则会丢失撤销时间、审计事件
和指标刷新。

## 5. 身份关联和 Lane 隐私

可以把 `Conversation Lane` 理解为“某个规范用户在某个 Agent Group 下的一条逻辑会话”。它不是
飞书群，也不是浏览器标签页。Lane 的所有权由 `owner_user_id + agent_group_id` 决定，根 Session
通过 `conversation_lane_id` 连接。

自动跨渠道关联必须同时满足：

1. 飞书事件已由 Adapter 验证；
2. 事件中的外部身份能解析为当前规范用户；
3. Binding 的 Channel、Platform、Thread、External Identity、用户和 Agent Group 全部匹配；
4. Lane 仍是 Active；
5. Session 模式属于 `per-user` 或 `per-user-per-thread`；
6. `CROSS_CHANNEL_LANES_ENABLED=true`。

`shared`、`per-thread`、`agent-shared` Session 可能含其他参与者内容，永远不能自动并入用户自己的
Web History。Organization 访问仍由 Host 通过 Agent Group 推导；Organization 不复制到 Lane，
也不作为 Gateway 业务授权输入。`conversation_thread_id` 只用于观测关联，不能作为 Lane 查询键。

上线前先为少量已验证的旧飞书 `per-user` Session 做显式关联。系统不会批量扫描和猜测历史归属，
也不会把两个用户的历史合并。

## 6. 多维表格 Gateway 配置

参考 Gateway 需要以下配置，全部只存在 Gateway 进程：

```dotenv
FEISHU_BITABLE_READ_ENABLED=true
FEISHU_BITABLE_WRITE_ENABLED=false
FEISHU_BITABLE_APP_ID=cli_xxx
FEISHU_BITABLE_APP_SECRET=<Secret Manager>
FEISHU_BITABLE_CURSOR_SECRET=<至少 32 字符>
FEISHU_BITABLE_CONFIRMATION_SECRET=<至少 32 字符>
FEISHU_BITABLE_RESOURCES_JSON=<逻辑资源白名单 JSON>
```

两个开关都默认关闭。只要开关为真但凭证/资源配置不完整，Gateway 就会启动失败；配置完整但开关
关闭时，Adapter 可以初始化，但 `/describe` 不发布相应 Operation。

`FEISHU_BITABLE_RESOURCES_JSON` 使用 `sales.pipeline` 一类逻辑别名。每个资源分别列出规范
`users.id` 的 `readers`/`writers`，不要写浏览器自报 ID、Organization ID 或任意原始
`app_token`/`table_id`。详细字段、Batch、确认和幂等规则见
[`examples/reference-gateway/README.md`](../examples/reference-gateway/README.md) 与
[`docs/enterprise-erp-gateway.md`](enterprise-erp-gateway.md)。

启用只读后检查：

```bash
curl -sS -X POST https://gateway.example.com/describe \
  -H 'content-type: application/json' \
  -d '{"contractVersion":1,"agent":{},"requester":{},"requesterSource":"agent-asserted"}'
```

结果应只含 5 个 `mutating=false` 的 `feishu.bitable.*` Operation。写开关关闭时，直接请求写
Operation 应返回 `OPERATION_NOT_FOUND`，飞书 Mock/Provider 不应收到请求。

## 7. 推荐的分阶段启用顺序

| 阶段           | Web | 跨渠道 Lane | 多维表格读 | 多维表格写 | 验收重点                                                            |
| -------------- | --: | ----------: | ---------: | ---------: | ------------------------------------------------------------------- |
| 0：只迁移      |  关 |          关 |         关 |         关 | 旧飞书消息、旧 Session 和 NULL-org 行为不变                         |
| 1：内部 Web    |  开 |          关 |         关 |         关 | SSO、Cookie/CSRF、会话隔离、SSE；用代理/IP/飞书应用范围限制试用人群 |
| 2：只读数据    |  开 |          关 |         开 |         关 | `/describe` 只发布读操作；资源和用户白名单正确；审计完整            |
| 3：小范围 Lane |  开 |          开 |         开 |         关 | 只关联已验证 `per-user` Session；Alice/Bob 同群不串线               |
| 4：受控写入    |  开 |          开 |         开 |         开 | 先开放低风险逻辑资源；确认、幂等、限流、审计和告警全部通过          |

每阶段至少观察一个完整业务周期，再进入下一阶段。不要在同一次发布里同时打开 Lane 和写操作，
否则出现异常时很难判断是身份关联、会话路由还是业务授权问题。

## 8. 回滚演练

回滚不删除新表、不删除新列、不删除身份关联、不合并或改写历史。加性 Schema 留在数据库里，旧
飞书 Session 仍按原方式工作。

建议按以下顺序演练：

1. 在反向代理摘除 Web 流量，避免产生新浏览器请求。
2. 把 Host 的 `WEB_ENABLED`、`CROSS_CHANNEL_LANES_ENABLED` 设为 `false`。
3. 把 Gateway 的 `FEISHU_BITABLE_READ_ENABLED`、
   `FEISHU_BITABLE_WRITE_ENABLED` 都设为 `false`。
4. 优雅停止 Host 和 Gateway。此时中央数据库没有并发写者。
5. 先预览、再执行全体 Web Session 撤销：

   ```bash
   pnpm exec tsx scripts/revoke-web-sessions.ts \
     --all --actor canonical-operator-id --reason unified-messaging-rollback

   pnpm exec tsx scripts/revoke-web-sessions.ts \
     --all --actor canonical-operator-id --reason unified-messaging-rollback --execute
   ```

6. 重启 Gateway，调用 `/describe`，确认不存在 `feishu.bitable.*`。
7. 重启 Host，确认 `WEB_PORT` 不再监听，飞书消息仍命中原有 Feishu-only Session。
8. 只读检查中央数据库：

   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db \
     "SELECT COUNT(*) AS active_web_sessions
        FROM web_auth_sessions
       WHERE revoked_at IS NULL"

   pnpm exec tsx scripts/q.ts data/v2.db \
     "SELECT id, owner_user_id, messaging_group_id, conversation_lane_id
        FROM sessions
       WHERE status = 'active'
       ORDER BY last_active DESC
       LIMIT 20"
   ```

验收结果应为：活动 Web Session 为 0；Gateway 不再发现多维表格 Operation；新的飞书消息正常回复；
关闭 Lane 后不会再自动创建/命中跨渠道 Binding；现存 Lane、Binding 和 Web 历史仍保留，供恢复后
继续使用。

代码版本回滚只允许在确认旧版本能容忍这些加性表/列时进行。项目的兼容测试会用旧字段投影只读打开
升级后的数据库；这不等于允许旧版本与新版本同时写数据库。任何时刻仍只能有一个 Host 版本作为
中央数据库写者。

## 9. 上线前检查清单

- `pnpm typecheck && pnpm test`
- `pnpm web:typecheck && pnpm web:test && pnpm web:build`
- Runner Typecheck/Test、Gateway Conformance 和真实容器 Smoke Test
- `pnpm format:check && pnpm lint && pnpm audit`
- SSO Redirect URI、TLS、Origin、Cookie、CSRF 和 SSE 代理均通过
- Alice/Bob 同群隔离测试通过，Shared Session 不进入 Web History
- Gateway `/describe` 与 Feature Flag 阶段一致
- `gateway_audit`、`enterprise_audit`、Web/Lane/Bitable 指标和告警可见
- 已执行一次本节的回滚演练并保存命令输出

# reference-gateway — a runnable backend gateway

A minimal, **zero-dependency** implementation of the AgentDesk backend gateway
contract. It is the executable companion to the prose contract in
[`docs/enterprise-erp-gateway.md`](../../docs/enterprise-erp-gateway.md) and the
machine-verifiable source of truth at
[`container/agent-runner/src/mcp-tools/gateway-contract.ts`](../../container/agent-runner/src/mcp-tools/gateway-contract.ts).

Use it to:

- see a complete gateway answer all eight endpoints with contract-compliant shapes,
- run the conformance runner against something real and watch it go green,
- copy as the skeleton for your own gateway (replace the in-memory store and the
  no-op operations with calls into your ERP / CRM / ticketing backend).

It is **not** production code: storage is an in-memory `Map` (lost on restart)
and authorization is illustrative. The idempotency cache is process-local (a
real backend persists it with the write). The inline comments in
[`server.mjs`](server.mjs) mark exactly where a real backend plugs in.

The optional Feishu Bitable adapter is stricter than the generic demo
operations, but is still a reference implementation: its idempotency and
confirmation-use stores are in memory. Production must persist those records
transactionally.

A dedicated unattended single-record Create resource may additionally set
`machineIngestRequired: true` and a Gateway-only `machineIngestHmacKey` of at
least 32 characters. The Gateway then requires an idempotency proof bound to
the source digest, logical resource and exact fields. The key is never exposed
through Describe, and canonical requester, writer policy, schema validation,
audit and idempotency checks still apply.

> **Going to production?** [`docs/gateway-kickstart.md`](../../docs/gateway-kickstart.md)
> walks this skeleton → your backend, with the hardening recipes (identity
> mapping, permission denial, idempotency, audit, HMAC + clock-skew + nonce
> cache, error-code mapping) and an Express port.

## What it implements

| Endpoint                                                         | Behaviour                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /describe`                                                 | returns an operation catalog (`conformance.noop`, `demo.echo`, `demo.order.create`, plus a realistic read+write pair `todo.list` / `todo.create`) and a memory-namespace catalog                                            |
| `POST /authorize`                                                | allows reads; denies a **mutating** op when `requesterSource` is `agent-asserted`                                                                                                                                           |
| `POST /execute`                                                  | `dryRun` → `preview`; otherwise → `result`; **replays the same result for a repeated `idempotencyKey`** so host retries can't double-write; returns an `auditId`; unknown op → structured `OPERATION_NOT_FOUND`             |
| `POST /bulk_execute`                                             | runs many operations in one round-trip (ADR-0036); per-op idempotency replay; `atomic` pre-validates then commits all-or-nothing; best-effort returns per-op `results[]` + `partial`                                        |
| `POST /task/status`                                              | async task poll (ADR-0037); `submitAsync:true` on `/execute` returns a `taskId`, this returns its `{status, result?}` (idempotent by key; unknown id → `failed`, not 404)                                                   |
| `POST /memory/get`                                               | exact lookup by `(namespace, subject)`; returns the live `value` + `source` provenance + `validAt`                                                                                                                          |
| `POST /memory/upsert`                                            | A.U.D.N. reconciliation (ADR-0050): canonical-value equality → `no-op`; change → supersede (invalidate the old version, append a new one). Returns `value` + `source` + `validAt` + `op`                                    |
| `POST /memory/search`                                            | naive keyword match over stored JSON, scoped by namespace + subject; returns `{ value, source, score, validAt, invalidAt? }[]` — live only by default, `includeHistory: true` adds superseded versions (ADR-0033, ADR-0050) |
| `feishu.bitable.*` through `/describe`, `/authorize`, `/execute` | optional Gateway-only App/Table/Field discovery and Record CRUD; disabled unless all credential, signing-secret and resource-whitelist settings are present                                                                 |
| `vision.archive.*` through `/describe`, `/authorize`, `/execute` | optional, strictly on-demand experiment search, file metadata listing, and bounded JSON read/search through opaque handles                                                                                                  |

Every response carries `contractVersion: 1`. The `requesterSource='session'` vs
`'agent-asserted'` gate on mutating operations is the contract's identity-trust
model in miniature — a real backend should keep that gate and harden it.

The optional Vision Archive adapter is disabled unless its root, resource
policy, and feature configuration are present. Configuring it performs no
filesystem access; only an authorized `/execute` touches the read-only Host
mount. See the
[`Vision Archive operator guide`](../../docs/vision-archive-gateway.md) and
[`pilot README`](../vision-archive-pilot/README.md).

## Run it

No install, no build step — Node built-ins only (`node:http`, `node:crypto`):

```bash
node examples/reference-gateway/server.mjs            # listens on http://localhost:8088
PORT=9090 node examples/reference-gateway/server.mjs  # custom port
```

Optional HMAC verification (off by default). When `GATEWAY_SIGNING_KEY` is set,
every request must carry a valid `<timestamp>.<nonce>.<body>` signature in the
brand-namespaced headers (`x-agentdesk-timestamp/nonce/signature`, following
`BRAND_NAMESPACE`):

```bash
GATEWAY_SIGNING_KEY="$(openssl rand -hex 32)" node examples/reference-gateway/server.mjs
```

## Verify it with the conformance runner

The conformance runner POSTs a contract-compliant sample to each endpoint and
validates the response against the **same** zod schemas the runtime uses. From
the container runner package:

```bash
cd container/agent-runner
bun scripts/gateway-conformance.ts http://localhost:8088
```

No `bun`? The script is plain TypeScript with no `bun:` imports, so `tsx` works
just as well:

```bash
cd container/agent-runner
pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088
```

Expected output — all eight green:

```
  PASS        /describe       [200]
  PASS        /authorize      [200]
  PASS        /execute        [200]
  PASS        /bulk_execute   [200]
  PASS        /task/status    [200]
  PASS        /memory/get     [200]
  PASS        /memory/upsert  [200]
  PASS        /memory/search  [200]

All 8 endpoints conformant.
```

Other modes (all pass against this reference):

```bash
# Strict response mode — fail on any response-schema mismatch:
GATEWAY_STRICT_RESPONSES=true pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088

# Signed gateway — start it with GATEWAY_SIGNING_KEY, then probe with the same key:
GATEWAY_SIGNING_KEY=test-key pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8089
```

(Probing a signed gateway _without_ the key returns `401` on every endpoint —
that is the verification working, not a contract violation.)

## 可选：在 Gateway 中启用飞书多维表格

多维表格能力默认关闭。启用后，Agent 仍只看见通用
`gateway_describe`/`gateway_authorize`/`gateway_execute`，飞书聊天 Adapter
不会持有多维表格凭证或调用 Record API。

需要设置以下环境变量：

| 变量                                 | 说明                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| `FEISHU_BITABLE_APP_ID`              | 飞书自建应用 App ID，只存在 Gateway 进程              |
| `FEISHU_BITABLE_APP_SECRET`          | 飞书自建应用 Secret，只存在 Gateway 进程              |
| `FEISHU_BITABLE_RESOURCES_JSON`      | 逻辑资源白名单和规范用户读写策略                      |
| `FEISHU_BITABLE_CURSOR_SECRET`       | 至少 32 字符，用于签名不透明分页 Cursor               |
| `FEISHU_BITABLE_CONFIRMATION_SECRET` | 至少 32 字符，用于签名用户确认凭据                    |
| `FEISHU_BITABLE_BASE_URL`            | 可选；仅供 Mock/私有代理测试，默认飞书开放平台        |
| `FEISHU_BITABLE_READ_ENABLED`        | 默认 `false`；发布 5 个只读 Operation                 |
| `FEISHU_BITABLE_WRITE_ENABLED`       | 默认 `false`；发布 6 个写 Operation，必须晚于只读灰度 |

任一必需项缺失都会在启动时 Fail Closed；未配置任何一项则保持功能关闭，`/describe`
不会宣传多维表格能力。配置完整但两个 Feature Flag 都关闭时同样不宣传；关闭的 Operation
直接返回 `OPERATION_NOT_FOUND`，不会访问飞书。

资源白名单示例：

```json
{
  "sales": {
    "appToken": "bas...",
    "name": "销售应用",
    "readers": ["canonical-user-alice"],
    "writers": [],
    "allowedOperations": ["feishu.bitable.app.get", "feishu.bitable.table.list"]
  },
  "sales.pipeline": {
    "appToken": "bas...",
    "tableId": "tbl...",
    "name": "销售管道",
    "readers": ["canonical-user-alice"],
    "writers": ["canonical-user-alice"],
    "requiredFields": ["客户"],
    "highImpactFields": ["成交金额"],
    "atomicBatchOperations": [],
    "views": { "board": "vew..." },
    "filters": {
      "active": {
        "conjunction": "and",
        "conditions": []
      }
    },
    "sorts": {
      "recent": [{ "field_name": "更新时间", "desc": true }]
    }
  }
}
```

这里的 `readers`/`writers` 必须填写 Host 传来的规范 `users.id`，不能填写浏览器自报
身份，也不能用 Organization 代替 Gateway 业务授权。显式写入 `"*"` 才表示该资源对所有
规范用户开放；省略列表默认为拒绝。

Agent 输入只能使用 `sales.pipeline` 这样的逻辑 `resource`。真实 `appToken` 和
`tableId` 只保存在上面的 Gateway 配置中；响应、错误和审计不会返回这些映射。Record List
中的 `viewAlias`、`filterAlias`、`sortAlias` 也必须来自该资源的白名单，不能提交任意飞书
表达式。

临时自然语言条件使用同一个 `feishu.bitable.record.list` Operation 的结构化
`query`/`orderBy`，不新增 `record.query`：

```json
{
  "resource": "sales.pipeline",
  "fields": ["客户", "状态", "成交金额"],
  "query": {
    "conjunction": "and",
    "conditions": [
      { "field": "状态", "operator": "eq", "value": "进行中" },
      { "field": "成交金额", "operator": "gte", "value": 10000 }
    ]
  },
  "orderBy": [{ "field": "成交金额", "direction": "desc" }],
  "pageSize": 20
}
```

Gateway 会先拉取当前 Field Schema，再校验字段存在性、值类型和单选选项，随后才转换成
飞书 `/records/search` 的 `filter`/`sort`。支持单层 `and|or`、最多 10 个条件和 3 个排序项。
文本支持 `eq/ne/contains/notContains`；数字支持 `eq/ne/gt/gte/lt/lte`；日期支持
`eq/gt/gte/lt/lte` 且值为 Unix 毫秒；单选支持 `eq/ne`；复选框支持布尔
`eq/ne`；上述字段都支持 `isEmpty/isNotEmpty`。`startsWith` 虽属于通用封闭词汇，但当前
飞书 Provider 没有等价结构化操作符，因此参考 Adapter 会在调用飞书前 Fail Closed。

`filterAlias`/`sortAlias` 不得与 `query`/`orderBy` 混用；`viewAlias` 可以保留。Cursor 绑定
资源、视图、字段投影、条件和排序，换条件重放会被拒绝。Gateway 只请求单个有界页面、再次
执行字段投影并检查响应字节上限，不会先拉取整表多页交给模型筛选。

Batch 必须显式选择 `best-effort` 或 `atomic`。参考实现默认只接受
`best-effort`；只有运营者确认上游调用真的能保证“全成或全败”后，才可把对应
`feishu.bitable.record.batch_*` 名称加入 `atomicBatchOperations`。不能用多次单条飞书
调用伪装成原子事务。

建议使用 Secret Manager 注入变量。下面只演示本地启动方式，不要把真实 Secret 提交到仓库：

```bash
export FEISHU_BITABLE_APP_ID='cli_...'
export FEISHU_BITABLE_APP_SECRET='从 Secret Manager 注入'
export FEISHU_BITABLE_CURSOR_SECRET="$(openssl rand -hex 32)"
export FEISHU_BITABLE_CONFIRMATION_SECRET="$(openssl rand -hex 32)"
export FEISHU_BITABLE_RESOURCES_JSON='{"sales.pipeline":{"appToken":"bas...","tableId":"tbl...","readers":["canonical-user-alice"],"writers":["canonical-user-alice"]}}'
export FEISHU_BITABLE_READ_ENABLED=true
export FEISHU_BITABLE_WRITE_ENABLED=false
node examples/reference-gateway/server.mjs
```

启用后可要求 Conformance Runner 验证完整 Operation Catalog：

```bash
cd container/agent-runner
GATEWAY_REQUIRE_FEISHU_BITABLE=true \
  pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088
```

单条 Update 在当前试点中全部需要确认；`highImpactFields` 只保留为风险标签。Worker 先用
`dryRun=true` 取得 Gateway 生成的 Diff、Record Fingerprint、Binding Hash 和 opaque
`confirmationRequest`，再把精确 Preview 交给 Host 的 `gateway_request_confirmation`。
Host 从可信入站链重新确定原请求者，用户确认后经签名代理调用 `POST /confirmation/issue`；
Gateway 校验 opaque Request、展示摘要、用户、Agent Group 和有效期后才签发短期凭据。签发
入口不能暴露为 Agent Tool，Token 也不能进入卡片、Web API、日志或审计明文。

Update Commit 重新读取 Record 并比较 Preview Fingerprint；变化返回 `CONFLICT`，成功后再
Get 核验。Delete 仍要求绑定确认，但 Query/Create/Update 试点资源不发布 Delete 或 Batch。

运行 Mock 飞书 API 回归：

```bash
node --test examples/reference-gateway/feishu-bitable-adapter.test.mjs
```

测试覆盖 Token 隔离、白名单、规范用户授权、结构化查询、Operator Matrix、字段投影、
Cursor 重绑定、分页/响应边界、Schema 漂移、字段校验、限流、超时、封闭错误、幂等重放、
Update Preview/确认/Fingerprint 冲突/提交后 Get、未确认删除，以及 Best-effort 部分失败。

## Point an agent group at it

After bootstrapping a topology (see [`../README.md`](../README.md)), point your
group's `backendGateway.baseUrl` at the reference gateway with the configure
helper — don't hand-edit `container.json`:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url http://localhost:8088 \
  --folders agentdesk-frontdesk
```

Now `gateway_describe` / `gateway_authorize` / `gateway_execute` /
`gateway_memory_get` / `gateway_memory_upsert` / `gateway_memory_search` from
that group's agent hit this server. Watch the per-call audit trail land in the
central DB:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, user_id, path, operation, status, http_status
     FROM gateway_audit ORDER BY id DESC LIMIT 20"
```

## Quick manual probe

```bash
# upsert a memory record (session-trusted requester)
curl -s -X POST http://localhost:8088/memory/upsert -H 'content-type: application/json' -d '{
  "contractVersion": 1,
  "agent": { "agentGroupId": "ag1", "groupName": "FD", "assistantName": "FD" },
  "requester": { "userId": "feishu:ou_alice" },
  "requesterSource": "session",
  "namespace": "conversation.summary.ag-frontdesk",
  "subject": { "type": "user", "id": "feishu:ou_alice" },
  "value": { "note": "alice prefers async approvals for the Q3 budget" },
  "merge": true,
  "context": {}
}'

# search it back (keyword match → score 1.0, with provenance)
curl -s -X POST http://localhost:8088/memory/search -H 'content-type: application/json' -d '{
  "contractVersion": 1,
  "agent": { "agentGroupId": "ag1", "groupName": "FD", "assistantName": "FD" },
  "requester": { "userId": "feishu:ou_alice" },
  "requesterSource": "session",
  "namespace": "conversation.summary.ag-frontdesk",
  "query": "Q3 budget approvals",
  "subject": { "type": "user", "id": "feishu:ou_alice" },
  "limit": 5,
  "context": {}
}'
```

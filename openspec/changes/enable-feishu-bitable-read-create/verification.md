# Verification

Date: 2026-07-29

## Baseline before implementation

Command: `pnpm typecheck && pnpm test`

- Typecheck: passed.
- Vitest: 99 files passed, 2 failed; 959 tests passed, 10 failed.
- The failures were environmental: the managed sandbox rejected local listener
  creation with `listen EPERM`, which caused webhook/Web and
  `enterprise-autowire` cascade failures. No Bitable implementation changes had
  been made when this baseline ran.

## Completed checks

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 195 pre-existing warnings and no errors.
- `pnpm --dir container/agent-runner typecheck`: passed.
- `pnpm web:typecheck`: passed.
- Bitable reference adapter: 13/13 passed.
- Prompt/topology, original A2A user propagation, and Gateway Audit targeted
  tests: 17/17 passed.
- Real Docker Frontdesk → Worker → Gateway E2E passed: the Host-propagated
  canonical user arrived as `requesterSource=session`, two Create requests used
  the same stable idempotency key, and the mock Gateway committed once.
- OpenSpec strict validation: passed.
- Reference Gateway strict conformance: all 9 endpoints passed.
- Full quality gate outside the managed listener sandbox: 105/105 Vitest files
  and 991/991 tests passed, followed by 13/13 reference Gateway adapter tests.
- The three initially failing enterprise-autowire assertions were traced to a
  test isolation gap: the test inherited the operator's local
  `ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY=shared`. The test now shadows local
  strategy configuration while exercising the legacy isolated-mode alias, and
  all 9 enterprise-autowire tests pass.
- Enabling the local signing proxy exposed the same isolation issue in its
  default-value unit test. The test now mocks `.env` loading and all 24 signing
  proxy tests pass independently of operator configuration.
- Bitable `/describe` catalog contained exactly:
  `field.list`, `record.list`, `record.get`, and `record.create`; it did not
  contain Update, Delete, or Batch operations.

## External/real-runtime checks

- The approved logical resource `pilot.records` now maps to the operator-provided
  table and view in the ignored local `.env`.
- The existing Feishu application successfully completed real Field/List/Get
  calls: 9 fields, 5 records on the first page, an opaque 284-character cursor,
  a 5,832-byte list response, and a successful Get. Each call returned an
  `auditId`.
- Host and Gateway were restarted after configuration. Web `/healthz`, Web
  `/login`, Host `/healthz`, Host `/readyz`, and Host `/metrics` all returned
  HTTP 200. Feishu long connection reached ready state.
- Gateway now requires HMAC on every request. The Host signing proxy is
  listening on port 8799, withholds the long-lived signing key from Agent
  containers, and the unsigned-group metric is `0`. Signed strict conformance
  passed all 9 endpoints after restart.
- The current OpenAI-compatible Worker configuration remains
  `https://api.nianfeng.tech/v1`, model
  `claude-haiku-4-5-20251001`, forced `chat-completions`; the existing API key
  was not changed.
- The operator explicitly approved transmitting Bitable content to the current
  `nianfeng.tech` external model endpoint; the Bitable Worker uses the existing
  OpenAI-compatible provider/model configuration without changing the API key.
- The built-in MCP child now loads its mounted Runner config before accepting
  tools and reconstructs the current A2A requester from processing message IDs
  plus Host-written `inbound.db` rows. Runner 335/335 tests and typecheck passed.
- Host signing proxy mode now translates the container-authored
  `host.docker.internal` Gateway target to Host loopback only for the Host-side
  upstream fetch. The focused proxy/topology suite passed 27/27, and the full
  Host typecheck/test gate passed after the change.
- Host was cleanly restarted with the corrected signing proxy. A subsequent
  Web → Frontdesk → Bitable Worker request reached Gateway with
  `requesterSource=session`, the canonical Feishu user, logical resource
  `pilot.records`, the Bitable Worker group signature, and the approved stable
  idempotency key.
- The initial real Create attempts correctly failed before commit with HTTP 403
  until the operator granted the Feishu application write access. After that
  external permission was enabled, the same approved request succeeded through
  Web → Frontdesk → Bitable Worker → Host signing proxy → Gateway → Feishu.
- The committed record is `recvqJKvN33m56`. The first Create audit ID is
  `d4eeef52-4cf1-4ce2-a3e6-6ba3e591541e`. Replaying the exact stable key
  `bitable-pilot-smoke-2026-07-29-v1` returned `replayed=true`, the same
  `recordId`, and did not issue a second business write; Gateway recorded the
  replay audit as `8c20f365-39ce-4ed9-b8cf-ba46ec429559`.
- A subsequent real `feishu.bitable.record.get` succeeded with audit ID
  `8c950fb1-a0c4-4373-b7a0-43aca3007e0e` and verified the committed fields:
  `待办事项=AgentDesk Bitable 接入冒烟测试 2026-07-29`,
  `优先级=🟢P2-低优`, and `是否已完成=false`.
- The successful Create, replay, and Get all retained
  `requesterSource=session`, the canonical Feishu user, and logical resource
  `pilot.records`. The final Agent response was delivered only to the
  triggering Web lane; no Feishu delivery was emitted by this Web-triggered
  turn.
- Post-write Host readiness remained `ready`. Final metrics showed
  `agentdesk_gateway_unsigned_groups 0`, six successfully signed proxy
  forwards, three successful Create terminal audit messages (authorize/first
  commit/replay), and one successful `record.get`; the earlier permission
  failures remain visible as two Create errors rather than being erased.
- Cross-channel live acceptance passed. A Feishu P2P request read
  `recvqJKvN33m56` through Frontdesk → Bitable Worker and preserved
  `originUserId=feishu:ou_097bdc0be98566144e04c57348dc8ceb` across both A2A
  hops. Gateway completed only `feishu.bitable.record.get`, returning audit ID
  `c0285a99-dd7c-4075-bbdf-8db298de3dc3`.
- The Host central audit recorded the Feishu-origin Get as
  `requesterSource=session`, logical resource `pilot.records`, canonical Feishu
  user, and signed group `ag-1785299111604-g5h2vx`. The reply was delivered
  once to `channelType=feishu`.
- Web SSO displayed both the Feishu-origin request and the resulting read in
  the existing Lane, with the Agent result labelled `来自飞书`. No Web-origin
  delivery or second business operation was emitted for that turn. Together
  with the earlier Web-origin Create, which replied only to Web, this verifies
  trigger-source delivery in both directions without a routing loop.
- After the cross-channel read, Host `/readyz` remained `ready`. Final metrics
  showed `agentdesk_gateway_unsigned_groups 0`, seven signed proxy forwards,
  three successful Create terminal audit messages, two successful
  `record.get` messages, and the two earlier Create permission errors retained
  for audit history.

## A2A history projection regression fix

- Live acceptance exposed that the Web history projection treated every
  user-owned inbound row as user-authored. The Bitable Worker result correctly
  retained the canonical user's `origin_user_id`, but its
  `channel_type=agent` A2A row was therefore rendered as a second user bubble
  before the real Frontdesk reply.
- Web history now excludes internal A2A inbound rows from the user timeline and
  excludes outbound rows whose trusted reply target is internal. The underlying
  A2A row, `source_session_id`, and `origin_user_id` remain unchanged for
  authorization and audit continuity.
- A regression test constructs a real user ingress, a same-origin A2A Worker
  result, and a final Agent reply. History contains only the user ingress and
  final reply. The focused Web conversation suite passed 5/5.
- Post-fix quality gates passed: Host 105/105 test files and 993/993 tests,
  reference Gateway 13/13, Runner 335/335, Host/Web/Runner typechecks, and
  lint with zero errors (196 pre-existing warnings).
- Host was restarted with the fix and returned `ready`. Reloading the existing
  real Feishu Lane showed audit ID
  `c0285a99-dd7c-4075-bbdf-8db298de3dc3` exactly once as
  `助手 · 来自飞书`; the raw Worker result no longer appeared as a user bubble.
  Existing Create, replay, Get, Feishu delivery, and Web history remained
  visible.

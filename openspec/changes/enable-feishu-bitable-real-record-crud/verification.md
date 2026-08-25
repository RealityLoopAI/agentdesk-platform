# Verification

Date: 2026-07-30

## Automated contract and regression evidence

- Host and Reference Gateway: `pnpm typecheck` and `pnpm test`
  - 116 test files passed.
  - 1113 Host tests passed.
  - 34 Reference Gateway tests passed.
- Agent Runner: `bun test && bun run typecheck`
  - 32 test files and 361 tests passed.
- Web: `pnpm test && pnpm typecheck && pnpm build`
  - 7 test files and 20 tests passed.
  - Production Vite build passed.
- Real-container A2A Gateway: `pnpm e2e:container:a2a-gateway`
  - Frontdesk → Worker identity propagation passed.
  - Create replay stayed idempotent.
  - Update and Delete confirmation stayed bound to the canonical user, Agent
    Group, logical resource, target, preview fingerprint, expiry and nonce.
  - Confirmation tokens remained in the Worker-private response path.
- OpenSpec: `pnpm exec openspec validate enable-feishu-bitable-real-record-crud --strict`
  passed.
- Lint completed with zero errors and the repository's existing warnings.
- Web formatting passed. Repository-wide Host formatting exposed one
  pre-existing failure in unmodified `src/gateway-signing-proxy.test.ts`;
  changed-file formatting is checked separately so this change does not absorb
  unrelated formatting work.

## Real resource discovery and closed-path evidence

- The ignored runtime environment maps the user-selected physical Base, Table
  and View to the logical resource `pilot.records` and view alias `pilot`.
- Signed `field.list` against the real provider passed and returned three
  writable optional Text fields: `批次`, `设备仪器`, `无水氯化铜（克）`.
- Signed bounded `record.list` against view alias `pilot` passed with an empty
  result page, `hasMore=false` and an audit identifier.
- The unsigned Gateway describe path returned HTTP 401.
- Gateway and Host health probes passed, the Host signing proxy is listening,
  and the Feishu long connection is ready.
- The first real Feishu P2P retry exposed a signing-key precedence mismatch:
  the Gateway selected the explicit runtime `GATEWAY_SIGNING_KEY`, while the
  topology reconciler retained an older Worker key derived from the app
  secret. The reconciler now uses the same precedence as the Gateway launcher
  and replaces stale materialized Worker keys. After topology sync and Host
  restart, the same real user and Worker completed signed `/describe`,
  `field.list`, and `record.create` authorization with HTTP 200.
- The first proposed test payload used a value absent from a real single-select
  field. Gateway rejected it with `VALIDATION_FAILED` before confirmation or
  write, proving current-schema validation remained fail-closed. The Worker
  prompt and eval now require exact select-option membership before
  authorization, confirmation, or execution.
- The operator explicitly requested adding the missing single-select option.
  The app-identity Field Update API failed closed with Feishu `91403`
  (`FORBIDDEN`) because the current Gateway app lacks field-update authority;
  no schema change occurred through that path. Using the authenticated Feishu
  document UI, the requested option was appended without changing the field
  type or removing the existing option. A subsequent signed Gateway
  `field.list` returned both the original option and `链路测试`.
- A clean Worker P2P retry then discovered `链路测试`, passed Create
  authorization and produced a dry-run preview, but the real Create returned
  HTTP 403. The Feishu read-only document permission probe for the same app and
  Base returned `view=true`, `edit=false`, `share=false`, proving the remaining
  Provider blocker is document edit authority rather than Gateway signing,
  resource policy or field validation. A subsequent signed exact query for the
  unique marker returned zero records with `hasMore=false`, proving no partial
  Create was left behind.
- That retry also exposed an OpenAI-compatible tool-schema regression:
  `gateway_request_confirmation` published only a top-level `oneOf`, which the
  configured model endpoint presented as a no-argument tool. The public schema
  now uses explicit top-level `kind`, `title` and `preview` properties while
  the handler retains the strict discriminated-union validation. The targeted
  Runner test, including all Create/Update/Delete confirmation cases, passes
  7/7.
- After document edit authority was enabled, the real Create completed once and
  exact Get/Query both returned the unique test marker. The following Update
  Preview was valid, but every confirmation issue returned 409. Replaying the
  persisted request through the trusted Host proxy proved that its payload,
  display hash, requester, Agent Group and expiry were valid while its HMAC did
  not match the current Gateway secret: the external model had rewritten the
  opaque string while copying it into `gateway_request_confirmation`.
- ADR-0078 removes that model round-trip. Runner now stores the exact validated
  Update/Delete Preview in a bounded Session-private TTL cache, removes
  `confirmationRequest` before returning the display Preview to the model, and
  restores the original only after Binding Hash lookup plus exact display-field
  comparison. Missing, expired, malformed or altered previews fail closed.
- Feishu card delivery also exposed provider error 200861 because the JSON 2.0
  card contained the removed JSON 1.0 `action` container. Confirmation and
  roster cards now render root-level JSON 2.0 buttons with
  `behaviors:[{type:"callback", value:...}]`; plaintext remains only the
  delivery-failure fallback.
- Targeted verification after both fixes:
  - Runner typecheck passed.
  - Runner confirmation/Gateway/contract tests passed 84/84.
  - Feishu JSON 2.0 card tests passed 14/14.

## Completed real-write and channel evidence

- The original Feishu requester completed the run using the unique marker
  `AgentDesk CRUD E2E 20260730-1426-F9C2`. The only record touched was the
  record created by that run, `recvqPR0xHgLiH`.
- Create committed once with audit
  `48551ebe-5ea8-4614-8c64-ee7911903f7e`. Get and exact structured Query
  verified the marker and uniqueness with audits
  `e10d7706-acff-4c5e-b3aa-5eebac8e297b` and
  `7b85eb55-9b35-48f3-b550-ce808950e5bb`.
- The requester approved the Update confirmation in Feishu. The persisted Host
  confirmation row is `approved` and bound to the canonical Feishu user.
  Post-write Get verified `无水氯化铜（克）` changed from `0` to `1`; the
  verification audit is `ba78bb10-99aa-4d34-ad51-cfa407afe796`.
- The requester then approved the Delete confirmation for the same record.
  Provider Delete completed with audit
  `73cd428f-d52d-49be-bb4d-f16930a496e7`; final Get returned Provider 404
  `NOT_FOUND` with audit `dcd32e8d-7be7-4e95-9bfa-8e3c4311c628`.
- Central Host audit rows contain the matching real `record.list`, `record.get`,
  `record.update`, `record.delete` and final 404 operations for
  `pilot.records`. The Frontdesk session outbox contains one Feishu-facing
  final report; the Worker A2A result remains an internal `channel_type=agent`
  row, so Web history no longer duplicates or attributes it to the user.

## Feishu card callback regression and live proof

- The JSON 2.0 card send fix exposed client error `200672` on click. The
  application was already subscribed to `card.action.trigger`, but the Host
  registered only message and roster handlers on its long-connection
  `EventDispatcher`; only the webhook transport had a card-action handler.
- The long-connection dispatcher now registers `card.action.trigger`, validates
  the same card-action shape and requester identity as the webhook transport,
  dispatches the selected option, and returns an explicit empty successful
  callback body inside Feishu's three-second acknowledgement window.
- A dedicated long-connection regression test proves registration, valid
  confirmation dispatch, empty acknowledgement, malformed-payload rejection
  and clean teardown.
- After Host restart, the real Feishu connection became ready and two physical
  card clicks arrived as `eventType="card.action.trigger"`. This proves the
  deployed app subscription is active; no manual permission or callback-console
  change is required for this deployment.
- A dedicated post-fix, no-business-side-effect smoke test
  `AD-CARD-20260730-150256` was sent through the real Feishu application as
  message `om_x100b699b30d2e0a0b29432a46271c3e`. The requester clicked the
  requester-scoped JSON 2.0 button and Host persisted the physical callback at
  `2026-07-30T07:06:27.992Z`. No Gateway audit row was created during the test,
  proving the callback smoke did not read or mutate the configured Bitable
  resource.

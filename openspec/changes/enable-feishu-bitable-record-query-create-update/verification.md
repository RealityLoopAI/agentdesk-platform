## Verification

### 2026-07-30 — Pre-change baseline

- `pnpm typecheck`: pass
- `pnpm test`: pass outside the filesystem/network sandbox
  - Host Vitest: 108 files, 1041 tests passed
  - Reference Gateway: 24 tests passed
- `pnpm --dir container/agent-runner typecheck`: pass
- `pnpm --dir container/agent-runner test`: 31 files, 340 tests passed
- `openspec validate enable-feishu-bitable-record-query-create-update --strict`: pass

The first sandboxed Host test attempt failed because local HTTP listeners were
denied with `listen EPERM 127.0.0.1`; rerunning the same `pnpm test` command
with local listener/process permissions passed in full.

### 2026-07-30 — Gateway and Bitable contract schemas

- `pnpm --dir container/agent-runner typecheck`: pass
- `bun test src/mcp-tools/gateway-contract.test.ts`: 19 tests passed
- `bun test src/mcp-tools/feishu-bitable-contract.test.ts`: 9 tests passed
- `/confirmation/issue` rejects agent-asserted or empty canonical identity and
  requires a security-bearing success response.
- Structured Query/Order, Update Preview, Record Fingerprint and Confirmation
  Binding fixtures pass their machine schemas; bounds and ambiguous values fail.

### 2026-07-30 — Structured Record Query

- `node --test examples/reference-gateway/feishu-bitable-adapter.test.mjs`:
  18 tests passed
- `pnpm test:reference-gateway`: 29 tests passed (run with local listener
  permission for the composition test)
- `bun test src/mcp-tools/feishu-bitable-contract.test.ts`: 10 tests passed
- `pnpm --dir container/agent-runner typecheck`: pass
- Covered text, single-select, number, date and boolean conversion; invalid
  field/operator/value/option pairs fail before record search.
- Covered alias ambiguity, raw Provider payload rejection, field projection,
  provider page and response byte bounds, `hasMore`, and Cursor rebinding across
  Query/Order/projection changes.

### 2026-07-30 — Update Preview, confirmation binding and verification

- `node --test examples/reference-gateway/feishu-bitable-adapter.test.mjs`:
  20 tests passed
- `pnpm test:reference-gateway`: 31 tests passed (run with local listener
  permission for the composition test)
- `bun test src/mcp-tools/feishu-bitable-contract.test.ts
src/mcp-tools/gateway-contract.test.ts`: 29 tests passed
- `pnpm --dir container/agent-runner typecheck`: pass
- Covered stable full-record fingerprints, Gateway-owned field Diff, ordinary
  and high-impact Update confirmation, trusted user/Agent Group binding,
  record/Patch/fingerprint substitution, expiry, Nonce reuse, idempotent
  replay/key rebinding, conflict-before-write, and post-Update Get verification.
- Gateway audits contain only safe hashes/fingerprints and linked Update/Get
  audit IDs; confirmation tokens and unrestricted cell plaintext are absent.

### 2026-07-30 — Host-mediated user confirmation

- Host targeted tests: 15 tests passed across durable Pending state, the
  confirmation broker, and Web conversation projection.
- Runner confirmation protocol: 3 tests passed.
- Web confirmation UI + event invalidation: 7 tests passed.
- Host, Runner and Web TypeScript checks passed.
- Covered Host-derived direct and A2A requester identity/route, actor-bound
  Feishu/Web decisions, duplicate click, expiry, restart recovery, Gateway 404
  and authentication/signing failure, forged Preview rejection, and the shared
  low-risk Create confirmation flow.
- The Feishu card and Web API expose only the Gateway display subset. The opaque
  preview request stays Host-side; the issued bearer token is written only to
  the waiting Worker's inbound system response and is absent from cards, Web
  events, Web API responses, application logs, and enterprise-audit details.

### 2026-07-30 — Worker and pilot policy

- `pnpm exec vitest run scripts/bitable-pilot-topology.test.ts`: 4 tests passed.
- `bun test src/mcp-tools/gateway-confirmation.test.ts`: 4 tests passed.
- Host and Runner TypeScript checks passed.
- Worker now uses only exact discovered Field/List/Get/Create/Update Operation
  names, a Field-Schema-validated structured query, and bounded result pages.
- Zero/multiple matches and a single visible result with `hasMore=true` cannot
  enter Update; the Worker never defaults to the first candidate.
- Create and Update use the shared Host confirmation broker. Update passes the
  exact Gateway preview and commits with the returned token and fingerprint;
  both writes are followed by Record Get verification.
- The pilot template keeps trusted canonical users at `readers:["*"]` and
  `writers:["*"]`, enables single Update, and leaves Delete/Batch disabled.
- The topology reconciler completed against the current deployment. The
  stopped legacy Bitable Worker session was archived recoverably; the next
  delegation will create a root-session-scoped Worker with the new Prompt.

### 2026-07-30 — Mock and real-container vertical tests

- `node --test examples/reference-gateway/feishu-bitable-adapter.test.mjs`:
  21 tests passed, including one stateful Query/Create/Update lifecycle.
- The lifecycle covers Field-Schema query validation, opaque pagination,
  stable Create replay, Gateway Update Preview, external-change fingerprint
  conflict, Host-issued confirmation, stable Update replay and post-commit Get.
- `pnpm e2e:container:a2a-gateway`: passed with real Frontdesk and Worker
  containers plus production A2A routing, Gateway MCP handlers, Host
  confirmation broker and Host signing path.
- The container E2E proves the original canonical Web user remains
  `requesterSource=session` after A2A, the root-session Worker Pending is bound
  to that user, and `/confirmation/issue` returns its token only through the
  private Worker inbound response.
- The first E2E run intentionally failed closed because the test Worker still
  used `agent-shared`; changing the fixture to production `root-session`
  restored the trusted root origin and made the complete test pass.

### 2026-07-30 — Final automated quality gate

- Host full suite: 110 files, 1044 tests passed.
- Reference Gateway full suite: 32 tests passed, including the listener-backed
  Archive/Bitable composition test.
- Runner full suite: 32 files, 351 tests passed.
- Web full suite: 7 files, 19 tests passed; TypeScript check and production
  Vite build passed.
- Host and Runner TypeScript checks passed.
- `pnpm lint`: passed with 199 existing warnings and zero errors.
- `openspec validate enable-feishu-bitable-record-query-create-update
--strict`: passed.
- A sandboxed attempt was unable to open local listeners and therefore caused
  listener/subprocess tests to fail. The unchanged suites passed outside that
  filesystem/network sandbox; no code or test was weakened to bypass it.

### 2026-07-30 — Local release-order and runtime smoke check

- Started the least-privilege Bitable Gateway first on `:8088`; startup reported
  Bitable enabled and HMAC signing required. An unsigned `/describe` request
  returned `401 BACKEND_UNAUTHORIZED`, proving the unsigned path stays closed.
- Restarted the existing Host development process after the Gateway was ready.
  Startup initialized the central DB (including the confirmation migration),
  Web and CLI channels, the Host-only signing proxy on `:8799`, delivery polls,
  Host sweep, the Web listener on `:3100`, and the Feishu long connection.
- The Feishu adapter reported `long-connection ready`; no unsigned Gateway
  agent group or fallback path was reported during startup.
- `GET http://127.0.0.1:3100/` returned `200`. Reloading the in-app login page
  rendered the Feishu login action and produced no browser console errors.
- Live Feishu Query/Create/Update, replay/conflict, cross-user group denial,
  Web conversation history and correlated audit evidence remain intentionally
  unchecked below because they require a user-driven real interaction and, for
  writes, an explicit per-operation confirmation.

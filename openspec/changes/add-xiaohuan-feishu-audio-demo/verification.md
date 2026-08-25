# Verification Log

## Baseline — 2026-07-29

- `pnpm typecheck`: passed before implementation.
- `pnpm test`: 966 tests passed; 7 tests in `scripts/q.test.ts` failed because
  the managed sandbox denied `tsx`'s local IPC socket with
  `listen EPERM .../tsx-501/*.pipe`. A direct `pnpm exec tsx scripts/q.ts`
  reproduced the same environment failure before application code changed.
- Three Vitest worker processes also exited unexpectedly during that run. New
  module tests are run independently after each small implementation.

This baseline issue is unrelated to the Xiaohuan Demo and is not modified by
this change.

## Final automated verification — 2026-07-29

- `pnpm exec vitest run scripts/xiaohuan-audio-demo-*.test.ts`: 13 files and
  103 tests passed.
- `node --import tsx examples/xiaohuan-audio-demo/index.selftest.ts`: passed.
- `pnpm typecheck`: passed.
- `pnpm test`: 114 files and 1069 tests passed. The only 7 failed assertions
  remain the baseline `scripts/q.test.ts` local IPC `EPERM` failures; three
  workers were denied `listen` on `127.0.0.1` by the managed environment.
- Focused Host invariant suite: 6 files and 61 tests passed, covering
  `origin_user_id`, organization isolation, Gateway isolation, session DB
  single-writer behavior, channel ingress, and Gateway signing.
- `bun test` in `container/agent-runner`: 30 files and 336 tests passed,
  including batch `RequestIdentity`, origin propagation, HMAC proxying,
  Bitable authorization, and stable idempotency.
- `openspec validate add-xiaohuan-feishu-audio-demo --strict`: passed.

## Scenario evidence map

- Disabled/configured extension, fail-closed preflight, port conflict, ASR
  scope, and P2P target: `xiaohuan-audio-demo-config.test.ts`,
  `xiaohuan-audio-demo-adapter.test.ts`, and
  `xiaohuan-audio-demo-run-host.test.ts`.
- Approved RTP/Opus, rejected source, corrupt input, FFmpeg lifecycle, and
  cleanup: `xiaohuan-audio-demo-receiver.test.ts`.
- Bounded PCM chunks, VAD silence/timeout/single-stream lifecycle:
  `xiaohuan-audio-demo-pcm-vad.test.ts` and
  `xiaohuan-audio-demo-pipeline.test.ts`.
- Ordered ASR actions, sequence validation, final-only output, abort/error
  handling, bounded safe diagnostics, and real-SDK request-shape spike:
  `xiaohuan-audio-demo-asr.test.ts` and
  `xiaohuan-audio-demo-asr-spike.test.ts`.
- Wake-word gating, fixed identity, synthetic Channel ingress, and adapter
  contract: `xiaohuan-audio-demo-pipeline.test.ts`,
  `xiaohuan-audio-demo-adapter.test.ts`, and `index.selftest.ts`.
- Schema-guided extraction, P2P confirmation/cancel/expiry, exact-once Create,
  write-after-read, audit evidence, and out-of-scope rejection:
  `xiaohuan-audio-demo-workflow-contract.test.ts` and
  `xiaohuan-audio-demo-workflow.e2e.test.ts`.
- No raw-audio persistence, secret/transcript log redlines, shutdown/reload,
  and safe provider errors: `xiaohuan-audio-demo-privacy.test.ts` and
  `xiaohuan-audio-demo-receiver.test.ts`.
- macOS operations, no-write smoke path, and live-demo acceptance checklist:
  `xiaohuan-audio-demo-runbook.test.ts` and
  `xiaohuan-audio-demo-smoke.test.ts`.

All normative scenarios have automated or documented live-demo evidence. The
remaining unchecked tasks are deliberately real-environment gates: tenant ASR
permission/final-response semantics and the physical Xiaohuan-to-Bitable run.

## Real Feishu ASR attempt — 2026-07-29

- Root `.env` contains non-placeholder Feishu app credentials; values were
  never printed.
- The custom-app tenant access token endpoint returned HTTP 200/code 0, proving
  that the configured App ID and rotated App Secret authenticate successfully.
- Both streaming ASR and file ASR reached Feishu but returned HTTP 400/code
  `99991400`. The safe response classification contains frequency/limit terms
  and contains no permission, scope, tenant-edition, or concurrency term.
- A paced streaming retry after a 30-second cooldown returned the same
  `rate_limit` category on the first audio chunk.
- The offline spike now sends chunks at 160 ms intervals and preserves SDK
  auth/rate-limit categories. Its focused tests and privacy regressions passed
  25/25, `pnpm typecheck` passed, and the functional fix was committed as
  `258b65c`.
- No Agent, Host, or Bitable path was started. No transcript or credential was
  logged. The synthetic PCM/AIFF files were removed after the attempt.

Task 1.2 remains open. A tenant administrator must confirm that the tenant has
available ASR capacity (and that no other tenant application is exhausting the
shared quota) before rerunning the paced spike and observing a non-empty final
response plus partial-text semantics.

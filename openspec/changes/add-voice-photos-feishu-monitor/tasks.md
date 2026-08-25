## 1. Shared Feishu Image Transport

- [x] 1.1 Characterize the current Feishu adapter's token refresh, upload, p2p target normalization, timeout, image-message creation, fallback, and error behavior with focused tests before refactoring.
- [x] 1.2 Extract a provider-specific outbound image helper that accepts Feishu credentials, a validated p2p target, image bytes, filename, and an optional stable idempotency key without importing Agent session or central-database state.
- [x] 1.3 Update `src/channels/feishu.ts` to use the shared helper while preserving the `ChannelAdapter` contract and existing text, card, reply, reaction, attachment-fallback, and image-delivery behavior.
- [x] 1.4 Add tests proving stable request UUID reuse, provider UUID length bounds, token caching/refresh, upload failure classification, request timeouts, retry hints, and rejection of non-p2p monitor destinations.

## 2. Monitor Service Configuration and Packaging

- [x] 2.1 Create the optional `examples/voice-photos-feishu-monitor/` TypeScript service, package scripts, example environment file, and ignored local state path without enabling it in default host startup.
- [x] 2.2 Implement fail-fast configuration parsing for the absolute mounted root, external SQLite path, `feishu:p2p:ou_*` target, poll interval, stability count, byte limit, scan budget, delivery concurrency, send rate, retry policy, and shutdown deadline.
- [x] 2.3 Reject `smb://` roots, relative roots, group targets, malformed Open IDs, state paths contained by the monitored root, invalid numeric limits, and missing credentials before any filesystem scan or provider call.
- [x] 2.4 Add configuration tests covering valid macOS/Linux mount paths, normalized p2p targets, safe defaults, secrets redaction, and every fail-closed case.

## 3. Monitor-Owned Durable State

- [x] 3.1 Define and initialize the monitor-local SQLite schema for metadata/baseline completion, observed path generations, immutable notification events, delivery attempts/status, retry times, sending leases, provider message IDs, and sanitized failures.
- [x] 3.2 Implement transactional repository operations for baseline commit, observation upsert/reset, ready-event reservation, lease recovery, delivery success, transient retry, and terminal failure.
- [x] 3.3 Derive immutable event IDs from normalized relative path plus stable content digest and derive provider-safe request UUIDs deterministically from those IDs.
- [x] 3.4 Add a single-owner process/database lease with bounded stale-owner recovery so concurrent instances cannot drain the same state database.
- [x] 3.5 Add database tests for schema initialization, atomic rollback, unchanged rediscovery, same-path changed content, delete/recreate unchanged content, restart recovery, lease contention, and a missing-database fresh baseline.

## 4. Recursive Polling and First-Run Baseline

- [x] 4.1 Implement a serialized, abortable recursive walker using directory entries and containment-aware paths, with no reliance on `fs.watch` and no overlapping scans.
- [x] 4.2 Filter hidden, temporary/partial, unsupported, symlinked, non-regular, escaped, and over-budget entries without following or mutating them.
- [x] 4.3 Implement the all-or-nothing first successful baseline transaction and emit readiness only after every eligible existing image generation has been recorded without notification events.
- [x] 4.4 Reuse a completed baseline on restart and treat an unavailable or partially failed initial scan as unready without committing partial history.
- [x] 4.5 Add temporary-tree tests for the observed `device/date/time/*.jpg` layout, arbitrary safe nesting, Unicode names, empty roots, large roots, symlink escape, disappearing directories, scan-budget fail-closed behavior, overlapping-timer prevention, and baseline race semantics.

## 5. Stable Image Validation and Event Creation

- [x] 5.1 Track consecutive successful observations and reset stability when identity, size, or modification metadata changes or a scan fails.
- [x] 5.2 Implement bounded reads with pre-read/post-read metadata checks, regular-file revalidation, maximum-byte enforcement, recognized image signature validation, and streaming or bounded SHA-256 content digest calculation.
- [x] 5.3 Create exactly one ready event for each stable valid path/content generation and record terminal validation outcomes for oversized or malformed candidates without blocking later files.
- [x] 5.4 Add race-focused tests for growing files, same-size replacement, disappearance during read, metadata change after read, fake image extensions, valid supported signatures, oversized files, unchanged repeated scans, and same-path new content.

## 6. Durable Feishu Delivery

- [x] 6.1 Implement the default single-concurrency delivery worker that claims ready/retry-due events in deterministic discovery order and reads only the claimed stable image generation.
- [x] 6.2 Upload and send every claimed image as its own message to the configured p2p target using the event's stable provider UUID, then persist the returned Feishu message ID and delivered state.
- [x] 6.3 Classify transient, throttled, and permanent provider failures; apply capped exponential backoff with jitter and provider retry hints; and ensure a poison event cannot block later ready events.
- [x] 6.4 Enforce delivery concurrency and send-rate limits while retaining excess work durably in SQLite.
- [x] 6.5 Add mocked Feishu tests for one image, multiple separately visible images, preserved ordering, rate-limited backlog, retry success, permanent rejection, crash-after-provider-acceptance recovery, duplicate UUID suppression, and target immutability during one attempt.

## 7. Availability, Lifecycle, and Observability

- [x] 7.1 Treat root resolution, enumeration, and metadata failures as scan unavailability without inferring deletions, resetting the baseline, or manufacturing events; add disconnect/reconnect tests.
- [x] 7.2 Add structured logs and bounded counters for initialization/readiness, scan duration/outcome, SMB availability, candidates, queue depth, delivery attempts, retries, successes, and terminal failures.
- [x] 7.3 Verify logs and errors redact credentials, tokens, image bytes, unbounded provider bodies, and the concrete configured Open ID where not operationally required.
- [x] 7.4 Implement `SIGINT`/`SIGTERM` cancellation that stops new scans, bounds active work settlement, releases the ownership lease, and closes SQLite; test graceful and deadline-forced shutdown.
- [x] 7.5 Add a deterministic end-to-end self-test using a temporary source tree, mocked Feishu endpoints, process restart, share outage/recovery, and assertions that no Agent Session, Gateway, skill, Lane subscription, or `messages_out` state is touched.

## 8. Operator Documentation and Architecture Record

- [x] 8.1 Document read-only macOS/Linux SMB mounting, local root selection, external state-directory permissions, existing bot credential reuse, fixed p2p target configuration, tuning limits, startup, readiness, health diagnosis, restart, and rollback.
- [x] 8.2 Document that first-run baseline images are intentionally ignored, notification guarantees start only after `monitor ready`, deleting the database re-baselines, and files that exist entirely between polls cannot be detected.
- [x] 8.3 Add an operator-safe real-share/private-chat smoke-test procedure that creates one uniquely named test image after readiness, verifies exactly one message, restarts the monitor, verifies no replay, and does not alter producer-owned history.
- [x] 8.4 Add an ADR recording the separate operator-service boundary, polling-over-watch choice, no-Agent/no-skill delivery path, monitor-owned state, fixed p2p destination, Feishu idempotency strategy, and rejection of host-sweep/container-outbox integration; update the ADR index.

## 9. Verification and Handoff

- [x] 9.1 Run formatter/linter and the focused Feishu transport, configuration, SQLite, scanner, validation, delivery, outage, lifecycle, and end-to-end monitor tests.
- [x] 9.2 Run `pnpm typecheck`, the full host test suite, and container tests to prove the Feishu refactor preserves existing channel, identity, routing, database-ownership, and delivery behavior.
- [x] 9.3 Perform an approved read-only baseline smoke test against `/Volumes/video_database/voice_photos` and verify that the existing archive produces zero Feishu notifications before readiness.
- [x] 9.4 Perform the approved post-readiness private-chat test, verify exactly one image notification and no replay after restart, and preserve sanitized evidence for the manual demonstration checklist.
- [x] 9.5 Inspect the final diff for hardcoded SMB credentials or Open IDs, writable NAS operations, direct Session outbox writes, synthetic Agent turns, background core timers, unbounded reads/queues/logs, missing rollback guidance, and unrelated changes.

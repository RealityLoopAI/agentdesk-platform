## 1. Archive Adapter Contract and Configuration

- [x] 1.1 Add `examples/reference-gateway/vision-archive-adapter.mjs` with exact descriptors for `vision.archive.experiment.search`, `vision.archive.file.list`, `vision.archive.json.read`, and `vision.archive.json.search`.
- [x] 1.2 Implement opt-in environment parsing for the mounted archive root, read enablement, canonical-user/resource policy, operation limits, handle expiry, and clock injection without performing any filesystem access at adapter construction or Gateway startup.
- [x] 1.3 Implement strict operation input validation, closed category/extension rules, normalized date selector validation, and structured Gateway error mapping.
- [x] 1.4 Add tests proving disabled/partial configuration fails safely and startup/idle adapter activity performs zero `stat`, `realpath`, `readdir`, open, or watch operations.

## 2. Identity, Authorization, and Opaque Handles

- [x] 2.1 Implement discovery and authorization hooks that require `requesterSource: session`, canonical user ID, read enablement, and matching user/resource policy without touching SMB.
- [x] 2.2 Implement execution-time authorization rechecks and requester/Agent-Group-bound random archive/file handles with bounded in-memory storage and expiry.
- [x] 2.3 Add tests for authorized users, denied users, `agent-asserted` callers, cross-user and cross-Agent-Group handle reuse, wrong handle type, expiry, eviction, and post-restart unknown handles.
- [x] 2.4 Verify archive-derived input or output cannot supply identity, authorization, operation-name, or routing decisions.

## 3. On-Demand Filesystem Query Operations

- [x] 3.1 Implement lazy root resolution and component-by-component containment validation that rejects absolute paths, parent traversal, control/NUL characters, symlinks, non-directories, non-regular files, hidden temporary entries, partial files, and canonical targets outside the root.
- [x] 3.2 Implement bounded first-level experiment search with Unicode NFC comparison, final `_YYYYMMDD` parsing, valid-calendar checks, explicit date ranges, request-time relative-day resolution, pagination, and separate same-name/same-date candidates.
- [x] 3.3 Implement bounded file listing for one selected archive and optional allowed category/extension filter without recursively enumerating unrelated archives.
- [x] 3.4 Implement bounded JSON reads with maximum bytes, JSON Pointer selection, depth/item projection, explicit truncation, and no unbounded raw-text response.
- [x] 3.5 Implement bounded JSON key/scalar search with safe previews, JSON Pointer results, traversal/result limits, and explicit truncation.
- [x] 3.6 Implement pre-read/post-read file identity, size, and modification checks; map replacement, disappearance, malformed JSON, missing category, unavailable SMB root, and timeout conditions to distinct not-ready, busy, validation, or retryable backend errors.
- [x] 3.7 Add temporary-directory tests covering Chinese and decomposed Unicode names, names containing underscores, invalid dates, empty roots, large directories, symlink escape, traversal attempts, file replacement races, malformed/oversized/deep JSON, missing categories, and unavailable roots.
- [x] 3.8 Support the observed `exp_YYYYMMDD_HHMMSS_id` production layout with bounded manifest-name resolution and logical category mapping; verify it with a focused fixture and a read-only smoke test against the mounted NAS.

## 4. Reference Gateway Composition

- [x] 4.1 Extend `examples/reference-gateway/server.mjs` to optionally load the Vision Archive adapter, merge its exact descriptors into `/describe`, and dispatch `/authorize` and `/execute` without changing the generic Gateway wire schema.
- [x] 4.2 Ensure Archive adapter absence preserves byte-for-byte existing reference and Bitable Gateway behavior and that read operations are classified as non-mutating.
- [x] 4.3 Add composition tests for Archive-only and Archive-plus-Bitable operation catalogs, exact dispatch, authorization recheck, error responses, and Gateway audit metadata.
- [x] 4.4 Run the Gateway conformance suite with the adapter disabled and enabled.

## 5. Archive Worker and Frontdesk Pilot

- [x] 5.1 Add `examples/vision-archive-pilot/agent-group/CLAUDE.local.md` requiring exact discovery, per-operation authorization, minimum on-demand reads, ambiguity handling, untrusted-data treatment, honest asynchronous-incompleteness reporting, and read-only behavior.
- [x] 5.2 Add the Archive worker `container.json` using its dedicated Gateway endpoint, `memoryMode: gateway`, `a2aSessionMode: root-session`, no archive mount, and no SMB credentials.
- [x] 5.3 Add an idempotent `configure-topology.ts` that creates or reuses `agentdesk-vision-archive-worker`, exposes it as Frontdesk destination `archive`, preserves existing `bitable` and other destinations, writes the reverse `frontdesk` destination, and refreshes active-session destination files.
- [x] 5.4 Add a managed Frontdesk prompt block routing experiment archive/date/key-frame/key-clip/report/structured-data/file-discovery intents to `archive` only after classification.
- [x] 5.5 Add topology tests proving idempotency, existing destination preservation, `root-session` identity propagation configuration, no `additionalMounts`, no credential leakage, and correct managed prompt updates.
- [x] 5.6 Add focused Agent eval cases for a unique report lookup, multiple experiment candidates, missing asynchronous output, busy JSON, SMB unavailability, absent operation discovery, authorization denial, prompt injection in archive content, and mutation/attachment refusal.

## 6. Operator Launcher, Documentation, and Decision Record

- [x] 6.1 Add a least-privilege `examples/vision-archive-pilot/start-gateway.mjs` that loads only Archive Gateway variables, selects a dedicated default port, and never injects provider, Feishu, SMB, or unrelated application credentials into the worker.
- [x] 6.2 Document read-only host mounting for macOS/Linux, `VISION_ARCHIVE_ROOT`, canonical-user policy, limits, HMAC signing proxy setup, startup commands, failure diagnosis, and rollback in the pilot README and an operator-facing guide.
- [x] 6.3 Document explicitly that an idle Gateway performs no SMB access and that there is no watcher, callback, startup scan, scheduled refresh, local copy, or persistent archive catalog.
- [x] 6.4 Add an ADR recording the request-driven SMB Gateway boundary, rejection of direct Agent mounts/background indexing, concurrent-writer handling, and binary-delivery deferral; update the ADR index.

## 7. Verification and Handoff

- [x] 7.1 Run formatting/linting and focused adapter, reference Gateway, topology, Agent eval, mount-security, Gateway identity, and audit tests.
- [x] 7.2 Run `pnpm typecheck`, the full host test suite, reference Gateway tests/conformance, and container tests; distinguish environment-only failures from product regressions.
- [x] 7.3 Perform a read-only smoke test against an operator-mounted fixture or approved SMB mount covering search, file list, JSON structure read, JSON search, an in-progress file, and share unavailability without modifying any archive content.
- [x] 7.4 Inspect the final diff for NAS credentials, physical archive paths in Agent-visible output, direct container mounts, background timers/watchers/scanners, persistent catalog writes, unrelated changes, and missing documentation.

## 8. Provider-Neutral Group Prompt and Private Archive Skill

- [x] 8.1 Add bounded, cycle-safe workspace-instruction expansion for providers that do not natively load `CLAUDE.md` / `CLAUDE.local.md`, while preserving the native Claude path without duplicate instructions.
- [x] 8.2 Add host/container tests proving OpenAI receives group-local routing, module, and selected Skill instructions and Claude continues to receive only the runtime addendum.
- [x] 8.3 Extend Skill composition and runtime symlinks to resolve explicitly selected group-private Skills before shared Skills without exposing them to unrelated groups.
- [x] 8.4 Add the worker-private `vision-archive-query` Skill, narrow the Archive worker Skill allowlist, and update the idempotent topology reconciler and tests to deploy it.
- [x] 8.5 Add focused natural-language eval coverage for report lookup plus `experiment_summary.json` field discovery and document the provider/Skill loading model for operators.
- [x] 8.6 Rotate the local pilot signing key, run typecheck and full host/reference/container regressions, then repeat the authorized Feishu message and verify Frontdesk delegation, Archive Gateway audit calls, NAS-backed answer content, and successful Feishu delivery.

## 9. Portable Archive Root Compatibility

- [x] 9.1 Point the local deployment and operator documentation at `VisionCortexExperimentArchive` while preserving OS-mounted, request-driven, read-only access.
- [x] 9.2 Support the observed `{English-Experiment-Name}-{YYYY-MM-DD}` layout and map its English category directories to the existing logical Chinese category contract.
- [x] 9.3 Add focused regression coverage, redeploy the worker-private query Skill, and perform a read-only smoke query against the new mounted root.

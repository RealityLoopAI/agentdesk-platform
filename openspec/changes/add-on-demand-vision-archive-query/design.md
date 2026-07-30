## Context

AgentDesk already provides a trusted, audited Backend Gateway path and a
Frontdesk-to-specialist-worker topology. The deployed Frontdesk currently
delegates Bitable work to a dedicated worker whose Gateway configuration is
separate from the Frontdesk. The new archive capability should follow the same
pattern.

The only external fact this change depends on is that VisionCortex
asynchronously writes experiment archives below:

`smb://192.168.66.149/video_database/VisionCortex实验档案库`

The share may contain the documented human-readable layout
`{实验名称}_{YYYYMMDD}/{关键帧|关键片段|专业报告|结构化数据}`. The production
fixture inspected on 2026-07-30 also contains the legacy producer layout
`exp_{YYYYMMDD}_{HHMMSS}_{id}` with `experiment_manifest.json` and
`analysis/{keyframes|segments}`. AgentDesk does not own the producer, does not
receive completion events, and must tolerate a query racing with an in-progress
archive write.

The load-bearing platform constraints remain unchanged:

- business authorization stays behind Backend Gateway;
- trusted `RequestIdentity` and `origin_user_id` propagation are not weakened;
- Agent containers do not receive NAS credentials or unrestricted shared
  filesystem access;
- the platform core remains business-agnostic;
- user/session isolation and conservative group-chat behavior remain intact.

## Goals / Non-Goals

**Goals:**

- Let an authenticated user ask the Agent to find an experiment archive, list
  its files, and inspect bounded structured JSON content.
- Access the SMB share only while executing an authenticated, user-initiated
  archive Gateway request.
- Keep all archive operations read-only, bounded, identity-bound, auditable,
  and fail-closed.
- Reuse the existing Gateway and Frontdesk/worker contracts without changing
  host routing, session databases, or the container-to-host protocol.
- Treat an archive that is concurrently being written as temporarily
  unavailable rather than returning a partial or fabricated answer.

**Non-Goals:**

- Monitoring, watching, synchronizing, pre-indexing, or periodically scanning
  the SMB directory.
- Receiving callbacks or status from VisionCortex.
- Depending on VisionCortex source code, APIs, schemas, databases, or manifests.
- Mounting SMB into Agent containers or giving Agents SMB credentials.
- Writing, renaming, deleting, repairing, or moving archive content.
- Persisting a local archive catalog or copying archive contents to AgentDesk.
- Delivering binary files as Feishu attachments.
- Defining schema-specific scientific event aggregation before a representative
  material-index JSON schema is available.

## Decisions

### 1. Use an optional Backend Gateway adapter and a dedicated worker

Add a zero-dependency optional `vision-archive-adapter.mjs` to the reference
Gateway and a `vision-archive-pilot` example that provisions
`agentdesk-vision-archive-worker` behind the Frontdesk alias `archive`.

The worker uses `root-session` A2A mode and the existing `gateway_describe`,
`gateway_authorize`, and `gateway_execute` tools. The adapter is enabled only
when explicit environment configuration opts in.

This keeps business behavior in `examples/`, follows the existing Bitable pilot
pattern, and avoids changes to the generic host/runtime.

Alternative considered: add archive-specific MCP tools to the runner. Rejected
because it would hardcode a business data source into the platform core and
would require a new authorization surface.

### 2. Let the host OS mount SMB read-only

The operator mounts `smb://192.168.66.149/video_database` read-only using the
host OS and configures `VISION_ARCHIVE_ROOT` to the mounted
`VisionCortex实验档案库` directory. The adapter uses Node filesystem APIs against
that local mount.

SMB credentials stay in the OS credential facility and are never copied into
the repository, `container.json`, Gateway tool arguments, or Agent container
environment.

Alternative considered: add an SMB client dependency to the Gateway. Rejected
because it duplicates OS mount/reconnect/credential behavior and introduces a
new network credential surface.

Alternative considered: use `additionalMounts` to expose the archive directly
to the worker. Rejected because every worker session would gain broad,
unaudited filesystem access that bypasses Gateway authorization.

### 3. Make filesystem access strictly execution-triggered

Adapter construction and Gateway startup validate only environment syntax. They
MUST NOT call `stat`, `realpath`, `readdir`, open, watch, or otherwise access
the archive root.

Only execution of one of the archive read operations may touch the filesystem.
After the operation finishes, the adapter performs no further access until
another authenticated archive operation executes. There is no watcher, timer,
scheduled refresh, startup scan, persistent catalog, or background promise.

Short-lived handle metadata may remain in process memory after a query, but
creating, expiring, or deleting that metadata performs no filesystem access.

### 4. Provide four generic, bounded operations

The first version advertises:

1. `vision.archive.experiment.search`
   - filters first-level directories by optional normalized experiment name and
     explicit date range or `relativeDayOffset + timezone`;
   - parses either the final `_YYYYMMDD` suffix or the recognized legacy
     `exp_YYYYMMDD_HHMMSS_id` form;
   - for a legacy archive, reads only its bounded `experiment_manifest.json`
     during that user-triggered search to obtain `experiment_name`, falling
     back to the directory name if the manifest is unavailable;
   - returns bounded metadata and an opaque archive handle.
2. `vision.archive.file.list`
   - lists regular files inside one selected archive and optional category;
   - maps the four logical Chinese categories onto the legacy `analysis`
     layout without exposing physical paths;
   - filters by a closed category vocabulary and bounded extension list;
   - returns opaque file handles and safe metadata.
3. `vision.archive.json.read`
   - reads one JSON file by file handle;
   - optionally selects a JSON Pointer;
   - returns a depth/item/byte-bounded structural projection.
4. `vision.archive.json.search`
   - recursively searches keys and scalar values in one bounded JSON document;
   - returns bounded JSON Pointers and scalar previews.

The adapter never accepts an absolute path, SMB URL, or arbitrary relative
filesystem path from an Agent.

Schema-specific operations such as `vision.archive.event.aggregate` require a
separate proposal after the actual JSON schema is known.

### 5. Use requester-bound, short-lived opaque handles

Search and list operations create random archive/file handles stored in an
in-memory map. Each record contains only the normalized relative components
needed to resolve the resource, its type, the canonical requester user ID, the
Agent Group ID, and an expiry time.

The adapter validates the same requester and Agent Group on every follow-up
operation. Handles expire after a bounded interval and are invalid after a
Gateway restart; the Agent can recover by repeating the search.

The map is not an archive index: it is populated only from a user-triggered
result and handle expiry never reads the filesystem.

Alternative considered: expose normalized relative paths. Rejected because
paths leak physical layout and enlarge traversal/confused-deputy risk.

### 6. Enforce containment and regular-file semantics on every access

For every filesystem-touching operation, the adapter lazily resolves the
configured root, resolves the selected child, and verifies containment using
path-component-aware comparisons. It rejects:

- symlinks at any selected path component;
- non-directory archive/category targets;
- non-regular file targets;
- absolute, parent, empty, control-character, or NUL-bearing components;
- files outside the configured root after canonicalization;
- hidden, temporary, or partial names such as `.tmp` and `.partial`;
- entries beyond configured directory, result, JSON byte, depth, or item
  limits.

Directory names and queries are normalized to Unicode NFC for comparison while
preserving display names in results.

### 7. Detect concurrent producer writes conservatively

For JSON reads/searches, the adapter records file identity, size, and
modification time before reading; performs a bounded read; parses the complete
JSON document; and checks the same metadata after reading. A changed,
disappeared, oversized, or malformed file is not returned as valid content.

When a requested archive/category/file is absent but its parent experiment
directory exists, the adapter returns a typed not-ready/not-found result that
lets the worker explain that asynchronous processing may still be in progress.
It does not poll or retry in the background.

### 8. Keep authorization independent of filesystem discovery

`/authorize` checks the trusted requester source, canonical user ID, feature
flag, configured user/resource policy, operation, and input shape without
touching SMB. `/execute` repeats authorization immediately before dispatch.

Only `requesterSource: session` is accepted for archive reads. The initial pilot
supports an explicit canonical-user allowlist, with optional logical resource
rules that map users to allowed directory-name prefixes. AgentDesk
Organization remains a host access boundary and is not forwarded or reused as
Gateway business authorization input.

### 9. Return normalized data, never instructions

The adapter does not return raw unbounded JSON text. It returns a normalized,
bounded JSON value/projection and marks archive-derived content as untrusted
business data. The worker prompt requires treating every filename and JSON
value as data, never as instructions, tool names, destinations, or
authorization claims.

### 10. Preserve conservative chat behavior

Frontdesk routes archive intent to `archive` only after `classify_intent`.
The worker checks discovery and authorization before execution, asks for the
smallest missing date/name/category input, and returns only tool-backed
metadata. When multiple experiments match, it returns candidates for user
selection rather than reading all of them.

The first version does not send binary attachments or expose filesystem paths.
Sensitive details in a group chat remain subject to the existing conservative
Frontdesk behavior and Gateway authorization.

### 11. Compose group instructions for providers that do not load them natively

The direct OpenAI provider does not interpret `CLAUDE.md` imports or
automatically load `CLAUDE.local.md`. The runner therefore expands the composed
workspace instruction entry point and appends the group-local file before
building the OpenAI system prompt. Providers such as Claude Code that already
load workspace instructions natively continue receiving only the runtime
identity/destination addendum, avoiding duplicate instructions.

The expansion follows only explicit Markdown import lines from the composed
entry point, rejects cycles, applies byte/depth limits, and allows imports only
inside the group workspace or trusted `/app` instruction roots. Missing
optional imports fail closed with a clear startup error rather than silently
dropping routing or security rules.

Alternative considered: copy Archive routing into the generic destination
description. Rejected because it would not load the mandatory classification,
authorization, and safety rules and would duplicate business behavior in core
routing code.

### 12. Use a narrowly selected group-private Archive query Skill

The Archive worker receives a private `vision-archive-query` Skill stored with
the pilot agent-group assets. The topology reconciler copies that Skill into
the worker group and sets `container.json#skills` to the explicit one-item
allowlist. Generic prompt/skill composition resolves an explicitly selected
group-private Skill before the shared Skill catalog; other groups do not see it.

`CLAUDE.local.md` remains the always-on role and safety contract. The Skill
contains domain vocabulary and query recipes: translating dates and experiment
names, selecting report/structured-data categories, preferring known summary
JSON, handling truncation, and formatting tool-backed answers. Backend Gateway
remains the only authorization and filesystem enforcement boundary.

Alternative considered: add the Archive Skill to global `container/skills` and
leave `"skills": "all"`. Rejected because it exposes business-specific
guidance to unrelated agents and loads unrelated browser/self-modification
Skills into the dedicated Archive worker.

## Risks / Trade-offs

- **[Risk] A user queries while VisionCortex is writing an archive.**
  → Compare file metadata before/after bounded reads, require complete JSON
  parsing, return a retryable busy/not-ready result, and never background-poll.

- **[Risk] A large archive root makes first-level lookup slow.**
  → Require bounded directory enumeration, apply name/date filters before
  descending, paginate results, and refuse unbounded recursive searches. This
  deliberately trades pre-index speed for the no-background-access requirement.

- **[Risk] Folder names alone cannot distinguish same-name, same-date
  experiments.**
  → Return every matching directory as a separate opaque candidate and require
  user selection. Do not merge them by inferred identity.

- **[Risk] Material-index JSON shape is unknown or changes.**
  → Provide generic bounded JSON read/search now; postpone semantic aggregation
  until a versioned representative schema is available.

- **[Risk] SMB disconnects or stalls during a request.**
  → Bound Gateway operation time, map filesystem/network errors to structured
  retryable failures, and do not fall back to stale local copies.

- **[Risk] Archive content contains prompt injection text.**
  → Normalize and bound output, label it untrusted, and require the worker to
  treat content as data only.

- **[Trade-off] In-memory handles do not survive Gateway restart.**
  → Fail with an expired/unknown handle and instruct the Agent to repeat the
  search; avoid persistent state and background catalog maintenance.

## Migration Plan

1. Add and test the optional archive adapter with temporary local directory
   fixtures; keep it disabled by default.
2. Extend the reference Gateway to compose the adapter's discovery,
   authorization, and execution only when configured.
3. Add the idempotent pilot topology reconciler, dedicated worker prompt/config,
   and Frontdesk managed routing block.
4. Mount the SMB share read-only on the operator host and configure
   `VISION_ARCHIVE_ROOT`, the read feature flag, canonical-user policy, port,
   and dedicated Gateway signing key.
5. Start the archive Gateway and run conformance, adapter, topology, and focused
   Agent routing tests.
6. Pilot with metadata and JSON reads only.

Rollback consists of stopping the archive Gateway, removing the managed
`archive` Frontdesk destination/prompt block, and unmounting the read-only SMB
share. No central DB schema or archive data migration is required.

## Open Questions

- What maximum root directory count and JSON byte limit match the production
  archive size without causing SMB timeouts?
- Which canonical AgentDesk users should be allowed during the pilot, and do
  any need directory-prefix restrictions?
- Which filename suffixes besides `.json` should count as structured data?
- After a representative material-index JSON is available, should a follow-up
  capability add typed event/material aggregation?

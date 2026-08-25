# Vision Archive Gateway operator guide

The optional Vision Archive adapter reads an operator-mounted view of
`smb://192.168.66.149/video_database/VisionCortexExperimentArchive` through the existing
Backend Gateway contract. Agent containers receive neither the mount nor SMB
credentials. VisionCortex code, APIs, callbacks, and schemas are not required.

## Request-driven access model

Only an authorized `/execute` call performs filesystem operations. Adapter
construction, Gateway startup, `/describe`, `/authorize`, idle time, lazy
handle expiry, and shutdown perform zero archive filesystem access. The
implementation has no watcher, callback, startup scan, scheduled refresh,
background retry, local copy, or persistent catalog.

Each request performs the minimum needed operation:

1. `vision.archive.experiment.search` enumerates only first-level experiment
   directories and returns short-lived archive handles.
2. `vision.archive.file.list` enumerates one selected archive/category and
   returns short-lived file handles.
3. `vision.archive.json.read` returns a bounded structural projection at an
   optional JSON Pointer.
4. `vision.archive.json.search` returns bounded JSON Pointers and safe scalar
   previews.

All four descriptors are non-mutating. Paths are neither accepted nor exposed.
Handles are random, memory-only, expiring, and bound to canonical user, Agent
Group, and resource type. Restarting the Gateway invalidates them.

## Environment

| Variable | Default | Purpose |
|---|---:|---|
| `VISION_ARCHIVE_ROOT` | required | Absolute Host path to the read-only mounted archive root |
| `VISION_ARCHIVE_RESOURCES_JSON` | required | Logical resource → readers, Agent Groups, optional categories/name prefixes |
| `VISION_ARCHIVE_READ_ENABLED` | `false` | Exact opt-in flag |
| `VISION_ARCHIVE_ALLOWED_CATEGORIES` | four documented categories | Closed comma-separated global category allowlist |
| `VISION_ARCHIVE_ALLOWED_EXTENSIONS` | JSON/PDF/image/video suffixes | Closed comma-separated extension allowlist |
| `VISION_ARCHIVE_MAX_ROOT_ENTRIES` | `2000` | Maximum first-level entries examined by one search |
| `VISION_ARCHIVE_MAX_LIST_ENTRIES` | `2000` | Maximum entries in one selected directory |
| `VISION_ARCHIVE_MAX_RESULTS` | `100` | Maximum page/search result count |
| `VISION_ARCHIVE_MAX_JSON_BYTES` | `2097152` | Maximum complete JSON file bytes |
| `VISION_ARCHIVE_MAX_JSON_DEPTH` | `8` | Maximum returned projection depth |
| `VISION_ARCHIVE_MAX_JSON_ITEMS` | `500` | Maximum projected items |
| `VISION_ARCHIVE_MAX_JSON_NODES` | `20000` | Maximum JSON search traversal nodes |
| `VISION_ARCHIVE_HANDLE_TTL_MS` | `600000` | In-memory handle lifetime |
| `VISION_ARCHIVE_MAX_HANDLES` | `5000` | Bounded process-local handle store |
| `VISION_ARCHIVE_OPERATION_TIMEOUT_MS` | `10000` | Per-execute deadline |
| `VISION_ARCHIVE_GATEWAY_PORT` | `8090` | Dedicated launcher port |

Policy example:

```json
{
  "vision": {
    "readers": ["canonical-user-id"],
    "agentGroups": ["archive-worker-agent-group-id"],
    "experimentPrefixes": ["固体称量", "酸碱滴定"],
    "categories": ["专业报告", "结构化数据"]
  }
}
```

`"*"` must be written explicitly to allow every canonical user or Agent Group.
The adapter requires `requesterSource: session`; agent-asserted calls are always
denied, including reads. `/authorize` evaluates only configuration and identity
and never probes SMB. `/execute` repeats authorization before touching the
mount.

## Filesystem safety and concurrent producers

The adapter lazily resolves the root, validates every component, rejects
absolute/traversal/control-character input, rejects symlinks and non-regular
files, and confirms canonical containment. Hidden/temporary/partial entries are
not returned. Experiment dates come only from a valid final `_YYYYMMDD` suffix
or a recognized `exp_YYYYMMDD_HHMMSS_id` directory, never modification time.

Two producer layouts are supported:

- readable: `{实验名称}_{YYYYMMDD}/{关键帧|关键片段|专业报告|结构化数据}`;
- legacy: `exp_YYYYMMDD_HHMMSS_id`, whose bounded
  `experiment_manifest.json` supplies `experiment_name`; logical categories map
  to `analysis/keyframes`, `analysis/segments`, and `analysis` for report/JSON
  files;
- portable: `{English-Experiment-Name}-{YYYY-MM-DD}`, whose logical categories
  map to `Key-Materials/Key-Frames`, `Key-Materials/Key-Clips`,
  `Professional-PDFs`, and `JSON-Config-Files`.

The legacy manifest is opened only as part of an authorized, user-triggered
search. This compatibility does not add startup scanning, monitoring, or a
persistent index.

JSON is size-checked before allocation and parsed as one complete document. The
adapter compares device/inode, byte size, and modification time before and
after reading. Replacement, disappearance, or change produces a retryable
busy/not-ready result; partial content is discarded. There is no silent or
background retry.

Archive-derived names and values are marked `untrusted: true`. They cannot
supply identity, operation names, routing, or authorization. The worker prompt
must treat them as evidence only.

## Deployment and verification

Follow the read-only macOS/Linux mount examples in
[`../examples/vision-archive-pilot/README.md`](../examples/vision-archive-pilot/README.md),
then configure the worker and start the dedicated Gateway. Put the Gateway
behind the Host signing proxy where possible:

```bash
export AGENTDESK_GATEWAY_SIGNING_PROXY=true
pnpm exec tsx examples/vision-archive-pilot/configure-topology.ts
node examples/vision-archive-pilot/start-gateway.mjs
```

Run focused verification:

```bash
node --test examples/reference-gateway/vision-archive-adapter.test.mjs
node --test examples/reference-gateway/vision-archive-composition.test.mjs
pnpm exec vitest run scripts/vision-archive-pilot-topology.test.ts
```

Run the generic Gateway conformance suite against `http://localhost:8090`.
Audit rows are still recorded through the existing Host Gateway audit path;
the adapter additionally emits operation/resource/user/group/outcome metadata
without input content or physical paths.

## Security boundary and rollback

Do not put SMB usernames/passwords in `.env`, the launcher, resource JSON,
worker prompt, or container configuration. Use an OS credential facility and a
read-only mount. The Gateway process is the only archive reader and should run
with an OS identity that has read permission only.

Rollback is state-light: stop the dedicated Gateway, remove the managed route,
and unmount. In-memory handles disappear automatically. No archive, catalog, or
AgentDesk schema data is modified.

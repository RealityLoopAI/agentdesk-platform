## Why

VisionCortex asynchronously writes completed experiment archives to
`smb://192.168.66.149/video_database/VisionCortex实验档案库`, but AgentDesk
currently has no identity-bound, auditable way to inspect those archives when a
user asks about an experiment, report, key frame, key clip, or structured JSON
index. The capability must be strictly request-driven: AgentDesk must not
monitor, pre-index, synchronize, or otherwise access the SMB share while no
authenticated user query is being processed.

## What Changes

- Add an optional, operator-owned Vision Archive adapter behind the existing
  Backend Gateway contract. The adapter reads an OS-mounted, read-only view of
  the SMB share only while handling an authenticated Gateway request.
- Expose bounded read operations for experiment-directory search, archive file
  listing, JSON inspection by pointer, and JSON value search.
- Return short-lived opaque handles rather than accepting or exposing SMB paths.
- Add fail-closed path containment, symlink rejection, file-size/result/depth
  limits, concurrent-write detection, and explicit unavailable/busy/malformed
  outcomes.
- Add a dedicated `archive` worker and Frontdesk routing example, preserving
  `root-session` identity propagation and requiring Gateway discovery and
  authorization before every archive read.
- Make group-local instructions and explicitly selected group-private Skills
  part of the effective system prompt for every provider, including the direct
  OpenAI provider used by the Feishu pilot.
- Add a narrowly scoped `vision-archive-query` Skill to the Archive worker for
  natural-language query planning and structured-file selection; do not expose
  it globally or use it as an authorization boundary.
- Explicitly exclude background watchers, startup scans, scheduled refreshes,
  persistent archive catalogs, VisionCortex callbacks, direct Agent-container
  SMB mounts, and write/delete operations.
- Defer binary attachment delivery and schema-specific scientific aggregation
  until separate changes; this change returns bounded metadata and structured
  JSON information only.

## Capabilities

### New Capabilities

- `vision-archive-query`: Authenticated, on-demand, bounded, read-only access to
  the VisionCortex SMB experiment archive through Backend Gateway operations.
- `vision-archive-agent-routing`: Frontdesk-to-worker routing and tool-use
  behavior for user-initiated experiment archive queries.

### Modified Capabilities

None.

## Impact

- Adds an optional adapter and tests under `examples/reference-gateway/`.
- Adds an optional pilot topology, worker prompt/configuration, launcher, and
  tests under `examples/vision-archive-pilot/`.
- Extends provider-neutral prompt composition and group-private Skill
  resolution without changing the container-to-host message protocol.
- Extends the reference Gateway's optional operation discovery, authorization,
  and execution dispatch without changing the core Gateway wire contract.
- Requires the operator to mount
  `smb://192.168.66.149/video_database` read-only on the AgentDesk host and set
  `VISION_ARCHIVE_ROOT` to the mounted `VisionCortex实验档案库` directory.
- Introduces no AgentDesk database migration, channel contract change,
  container-to-host protocol change, VisionCortex dependency, SMB library, or
  direct NAS credential exposure to Agent containers.

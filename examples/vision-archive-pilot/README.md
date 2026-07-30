# Vision Archive on-demand query pilot

This example adds a dedicated `archive` worker that can find experiment
archives and inspect bounded JSON through Backend Gateway. VisionCortex remains
an independent asynchronous producer.

The worker enables only its group-private `vision-archive-query` Skill. That
Skill translates natural-language archive questions into the minimum Gateway
query sequence and selects known structured JSON such as
`experiment_summary.json`. It does not access SMB or authorize requests.

The invariant is simple: **no user query, no archive access**. Gateway startup,
discovery, authorization, idle time, handle expiry, and shutdown do not stat,
resolve, enumerate, open, or watch the mount. There is no watcher, callback,
startup scan, scheduled refresh, local copy, or persistent archive catalog.

## 1. Mount the share read-only on the Host

Create a dedicated mount point and keep SMB credentials in the OS credential
store or a root-readable credentials file. Never put them in AgentDesk `.env`
or a worker `container.json`.

macOS example (password is obtained by the OS, not stored in this repository):

```bash
mkdir -p /Volumes/visioncortex-video
mount_smbfs -o rdonly //SMB_USER@192.168.66.149/video_database /Volumes/visioncortex-video
export VISION_ARCHIVE_ROOT='/Volumes/visioncortex-video/VisionCortex实验档案库'
```

Linux example:

```bash
sudo mkdir -p /mnt/visioncortex-video
sudo mount -t cifs //192.168.66.149/video_database /mnt/visioncortex-video \
  -o ro,credentials=/root/.visioncortex-smb,vers=3.0,nosuid,nodev,noexec
export VISION_ARCHIVE_ROOT='/mnt/visioncortex-video/VisionCortex实验档案库'
```

Verify the mount itself is read-only using OS mount inspection. Do not test by
creating a file in the producer-owned archive.

## 2. Configure policy and limits

The resource policy uses canonical AgentDesk `users.id` values and exact Agent
Group IDs. It does not accept Feishu `open_id`, user-supplied identity, or an
Organization ID.

```bash
export VISION_ARCHIVE_READ_ENABLED=true
export VISION_ARCHIVE_RESOURCES_JSON='{
  "vision": {
    "readers": ["canonical-user-id"],
    "agentGroups": ["archive-worker-agent-group-id"],
    "categories": ["关键帧", "关键片段", "专业报告", "结构化数据"]
  }
}'
export VISION_ARCHIVE_MAX_JSON_BYTES=2097152
export VISION_ARCHIVE_MAX_RESULTS=100
export VISION_ARCHIVE_OPERATION_TIMEOUT_MS=10000
export GATEWAY_SIGNING_KEY="$(openssl rand -hex 32)"
```

Re-run `configure-topology.ts` after rotating this value. The reconciler
updates the Archive worker to the current environment key, so the worker and
the dedicated Gateway stay in sync for the next session.

Additional knobs are documented in
[`../../docs/vision-archive-gateway.md`](../../docs/vision-archive-gateway.md).
The Gateway accepts only logical resource aliases and opaque handles; it never
returns the SMB URL or Host mount path.

## 3. Configure the worker and start the Gateway

```bash
pnpm exec tsx examples/vision-archive-pilot/configure-topology.ts
node examples/vision-archive-pilot/start-gateway.mjs
```

The launcher uses port `8090` by default. It removes unrelated application and
provider environment variables before importing the reference Gateway.

The topology reconciler copies the private Skill into
`groups/agentdesk-vision-archive-worker/skills/` and writes the worker's
explicit one-Skill allowlist. Do not copy this business-specific Skill into
`container/skills`; unrelated Frontdesk/worker groups must not load it.

AgentDesk composes `CLAUDE.md` plus `CLAUDE.local.md` for providers that do not
natively load workspace instructions. This is required for direct OpenAI
providers; Claude Code continues to load the same files natively. If a worker
asks for the storage location instead of routing an obvious archive request,
verify the deployed runner includes the provider-neutral prompt loader and
start a fresh session after upgrading.

For production-like deployments, enable
`AGENTDESK_GATEWAY_SIGNING_PROXY=true`. The Host then holds the HMAC key and
gives the worker only a scoped session token. The Gateway still receives the
same signed request. The `GATEWAY_SIGNING_KEY` injected into the launcher must
match the worker group's configured key.

## Failure diagnosis

- `OPERATION_NOT_FOUND`: adapter is disabled/partially configured, or the
  operation was not advertised. Check the feature flag and `/describe`.
- `BACKEND_UNAUTHORIZED`: caller is not session-trusted or its canonical user /
  Agent Group is absent from the selected resource policy.
- `BACKEND_UNAVAILABLE`: the read-only OS mount is missing or disconnected.
  This is not proof that an experiment does not exist.
- `RESOURCE_NOT_READY`: VisionCortex may still be producing the requested
  category/file, or a JSON document is incomplete.
- `BACKEND_BUSY`: the file identity, size, or modification time changed during
  the bounded read. Re-query only after an explicit user request.
- `PAYLOAD_TOO_LARGE` / `RESULT_LIMIT_EXCEEDED`: narrow the query or adjust an
  operator-reviewed bound; do not remove the bound.

## Rollback

Stop the Gateway, remove the managed
`<!-- vision-archive-pilot:start -->` block and the Frontdesk `archive`
destination if desired, then unmount the read-only share. No AgentDesk DB
migration, archive write, local index, or copied archive data must be reversed.

This pilot returns metadata and bounded JSON only. Binary attachment delivery,
schema-specific scientific aggregation, archive mutation, and background
monitoring are deliberately outside its scope.

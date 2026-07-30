## Context

An external producer writes images beneath:

`smb://192.168.66.149/video_database/voice_photos`

The approved host mount currently appears as
`/Volumes/video_database/voice_photos` and contains a recursive
`device/date/time/image.jpg` layout. AgentDesk does not control the producer,
does not receive a completion callback, and must assume that a directory entry
can become visible before its image bytes are complete.

The Feishu channel adapter already uploads common image formats and sends
`msg_type=image` messages. Its normal delivery path, however, consumes
container-owned `messages_out`; the host and an external monitor must not write
that database. The existing cross-channel delivery ledger is also unsuitable
because it references an Agent reply in a Session and represents explicit
reply-mirroring consent, not an operator-configured machine event.

This notification is an operator deployment concern. It has one approved
destination: the private conversation between the configured user and the
RealityLoop bot. It must run without an inbound chat message, Agent wake-up,
skill load, Gateway call, or LLM execution.

## Goals / Non-Goals

**Goals:**

- Recursively discover images added after the monitor has established its
  first durable baseline.
- Send every completed new image once to one explicitly configured Feishu p2p
  target, subject to crash-safe idempotency.
- Survive monitor restarts, temporary SMB unavailability, Feishu throttling,
  and producer writes that overlap polling.
- Keep the SMB mount read-only and keep business paths, credentials, and target
  identities out of generic defaults.
- Reuse Feishu transport behavior without weakening Session database ownership
  or channel identity boundaries.

**Non-Goals:**

- Sending any image that existed when the first baseline completed.
- Monitoring the VisionCortex experiment archive or changing its request-driven
  query behavior.
- Asking an Agent to classify, caption, summarize, approve, or route an image.
- Supporting groups, multiple subscribers, user-selectable destinations, or
  Conversation Lane mirroring in the first version.
- Modifying, deleting, renaming, acknowledging, or writing marker files into
  the SMB share.
- Guaranteeing notification for a file created and removed entirely between
  two polls.
- Treating filenames or image metadata as trusted instructions.

## Decisions

### 1. Run an optional operator service outside the Agent host message loop

Add `examples/voice-photos-feishu-monitor/` as a separately launched Node
service. It owns its polling lifecycle and SQLite state and uses the same
Feishu application credentials as the RealityLoop bot.

This keeps the platform core business-agnostic and prevents file events from
being forged into user turns or container outbound rows. It also lets an
operator deploy, stop, or roll back this monitor without changing Agent
routing.

Alternative considered: install a group or worker skill. Rejected because a
skill runs only as part of an Agent turn and cannot provide unattended,
durable monitoring.

Alternative considered: inject a synthetic inbound message and let an Agent
send the image. Rejected because it adds latency and model cost, makes delivery
non-deterministic, and confuses a machine event with a trusted user request.

Alternative considered: add the timer to `host-sweep.ts`. Rejected because it
hardcodes a business-specific filesystem source into generic maintenance and
couples notification availability to an unrelated core loop.

### 2. Use an operator-mounted, read-only filesystem root

The service accepts a local absolute root such as
`/Volumes/video_database/voice_photos`; it does not accept an `smb://` URL or
SMB credentials. The OS owns SMB authentication, mounting, reconnect policy,
and read-only enforcement.

The monitor resolves the configured root and recursively walks only contained
directories. It does not follow symlinks and never opens a path constructed
from chat or Agent input.

Alternative considered: add an SMB client package. Rejected because it creates
a second credential and reconnect surface and is unnecessary when the
operator-approved OS mount already exists.

### 3. Poll serially instead of relying on filesystem watch events

Use one lifecycle-aware recursive scan at a time, scheduled again only after
the preceding scan finishes. A configurable interval defaults to five seconds.
Directory enumeration uses `readdir` with directory entries; metadata and
content reads are limited to plausible image candidates and changed paths.

`fs.watch` is not the source of truth because remote SMB event delivery can be
lost, duplicated, or disconnected. A future watch hint may trigger an earlier
scan, but durable detection remains poll-based.

### 4. Establish the first baseline as an explicit durable phase

The monitor database begins in `initializing`. The first successful recursive
scan records every eligible existing image generation in a single baseline
transaction, then records `baseline_completed_at` and emits `monitor ready`.
No baseline row is enqueued for delivery.

Notification semantics begin only after readiness. A file that becomes visible
during the initial scan and is included in that completed snapshot is treated
as historical. If the share is unavailable or the scan fails, readiness is not
recorded and no delivery begins.

On ordinary restart, the existing database and completed marker are reused, so
the monitor never creates a new baseline or replays historical rows. Deleting
the database is an explicit reset that intentionally creates a fresh baseline.

### 5. Require stable, bounded, regular image files

The recursive walker ignores hidden files, temporary/partial suffixes,
directories masquerading as images, symlinks, and unsupported extensions.
Supported candidates are bounded by a configurable byte limit and validated by
recognized image magic bytes rather than extension alone.

A newly observed path enters `observed` with its identity, size, modification,
and change metadata. It becomes readable only after the same metadata is observed in at
least two consecutive successful scans. Before and after the bounded read, the
service compares identity, size, modification, and change metadata. Any change returns
the candidate to observation instead of sending partial bytes.

After a stable read, the service computes a content digest. A durable event ID
is derived from the normalized relative path plus the digest. This suppresses
unchanged rediscovery while allowing a path whose contents are genuinely
replaced to generate a new notification.

### 6. Use a monitor-owned SQLite state machine and outbox

The service stores its database outside the SMB root. Conceptually it contains:

- monitor metadata and baseline completion;
- observed path/generation metadata and consecutive-stability count;
- immutable notification events with event ID and content digest;
- delivery status, attempt count, next retry time, Feishu message ID, and
  sanitized failure classification.

Transitions are transactional:

`observed -> ready -> sending -> delivered`

Transient delivery failures become `retry_wait` and are reclaimed after an
exponential backoff with jitter. A startup recovery pass reclaims expired
`sending` leases. Invalid images and non-retryable provider rejections become
terminal failures without blocking later files.

Only one service instance may own a database at a time. A process/database
lease prevents two monitor instances from sending the same event concurrently.

Alternative considered: use AgentDesk's central database. Rejected for the
pilot because these rows are operator-service state, not conversation history,
business memory, or Agent authorization, and coupling them would require a
host runtime migration for an optional example.

### 7. Extract a narrow reusable Feishu outbound-image primitive

Factor token acquisition, bounded HTTP calls, image upload, p2p target
normalization, and image-message creation into a provider-specific helper used
by both `src/channels/feishu.ts` and the monitor. The `ChannelAdapter` public
contract remains unchanged.

The helper accepts a host-generated idempotency key. The monitor derives a
stable Feishu request UUID of at most the provider limit from its durable event
ID. If the process crashes after Feishu accepted the image message but before
SQLite records `delivered`, a retry reuses that UUID. Re-uploading bytes may
create an unused Feishu image key, but message creation does not intentionally
create a second visible notification.

The target configuration must normalize to exactly one
`feishu:p2p:ou_*` address. Group targets and arbitrary receive-id types fail
startup. The actual Open ID is supplied through deployment environment and is
not committed.

### 8. Bound delivery and preserve discovery order

A configurable worker concurrency defaults to one so images appear in stable
discovery order. Per-scan discovery and per-minute sends are bounded. Excess
ready events remain in SQLite and drain later; they are not discarded.
Exceeding the per-scan candidate budget fails the entire scan closed; it never
commits a truncated baseline or treats omitted paths as a complete view.

Transient filesystem and Feishu errors use capped exponential backoff. Provider
rate-limit hints take precedence when available. Logs never contain image
bytes, access tokens, app secrets, or full provider response bodies.

### 9. Make share outages an availability state, not a content change

If root resolution, enumeration, or metadata access fails, the entire scan is
unsuccessful. The service records/logs unavailability and retries later, but
does not mark known files deleted, reset the baseline, or manufacture new
events.

Deletion is otherwise informational: removing a delivered file does not remove
its delivery history. Recreating the same relative path with different stable
content creates a new event; recreating it with the same content does not.

### 10. Provide explicit lifecycle and operational evidence

The service validates all configuration before polling, exposes structured
logs and counters for readiness, scan duration, candidates, queue depth,
delivery outcomes, retry counts, and SMB availability, and handles
`SIGINT`/`SIGTERM` with an abort signal. Shutdown stops new scans, lets the
current bounded operation settle within a deadline, releases the lease, and
closes SQLite.

The real-share smoke test uses a new uniquely named image copied by the
operator into the approved mount and verifies one message in the configured
private conversation. It never edits or deletes producer-owned historical
content.

## Risks / Trade-offs

- **[A file exists only between polls]** → This polling design cannot observe
  it; document that producers must leave completed images in the archive.
- **[Initial scan races with producer writes]** → Readiness is explicitly
  defined at baseline completion; files included in that scan are historical,
  and operators can observe the ready marker before testing.
- **[SMB metadata is coarse or unstable]** → Require two stable observations,
  compare before/after read metadata, and use the content digest for final
  event identity.
- **[Crash after provider acceptance]** → Persist the event before sending and
  reuse a stable Feishu message UUID on every retry.
- **[Large bursts delay delivery]** → Bound concurrency and rate while retaining
  ready events durably; expose queue depth.
- **[SQLite state is lost]** → A missing database safely re-baselines instead
  of flooding history, but images added between loss and baseline completion
  will intentionally be treated as historical.
- **[Provider helper extraction regresses normal chat delivery]** → Preserve the
  adapter contract and add parity tests around token refresh, upload, timeout,
  target normalization, fallback behavior, and idempotency.
- **[A fixed Open ID becomes invalid]** → Fail visibly with retryable delivery
  state; changing the configured target affects future retries and does not
  rewrite historical delivery records.

## Migration Plan

1. Add the shared Feishu outbound-image helper with adapter parity tests.
2. Add the optional monitor, local schema, deterministic fixtures, and mocked
   Feishu delivery tests; keep it disabled by default.
3. Mount the share read-only, create a dedicated writable state directory, and
   configure the p2p target and existing bot credentials outside version
   control.
4. Start the service and wait for the durable `monitor ready` signal. Confirm
   that no historical image was sent.
5. Add one approved uniquely named test image and verify exactly one private
   message, then restart the service and verify no replay.
6. Install the process under the operator's service manager with restart and
   log retention policy.

Rollback stops and disables the optional service. Its SQLite database is
retained for audit and safe re-enable; no NAS or conversation data needs
migration or rollback.

## Open Questions

None for the first version. Poll interval, byte limit, rate limit, retry timing,
state path, mount path, and p2p target remain deployment configuration with
documented safe defaults.

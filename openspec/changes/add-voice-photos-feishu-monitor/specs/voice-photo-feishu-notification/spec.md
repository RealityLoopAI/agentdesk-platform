## ADDED Requirements

### Requirement: Monitoring is explicitly configured and destination-bound

The monitor SHALL remain disabled unless an operator supplies a local absolute
filesystem root, a writable state database path outside that root, valid Feishu
bot credentials, and exactly one destination normalized as
`feishu:p2p:ou_*`. It MUST reject SMB URLs, group-chat destinations, malformed
Open IDs, and state paths inside the monitored root.

#### Scenario: Valid private target is configured

- **WHEN** the operator starts the monitor with a valid mounted root, external state path, credentials, and `feishu:p2p:ou_*` target
- **THEN** the monitor validates configuration and may begin baseline initialization

#### Scenario: Group target is configured

- **WHEN** the destination identifies a Feishu group rather than a p2p Open ID
- **THEN** startup fails before scanning or sending any file

#### Scenario: SMB URL is configured as the filesystem root

- **WHEN** the operator supplies `smb://192.168.66.149/video_database/voice_photos` instead of a local mount path
- **THEN** startup fails with guidance to configure an operator-mounted read-only local path

### Requirement: First successful scan establishes a no-send baseline

The monitor SHALL durably record every eligible image present during its first
successful recursive scan as baseline history and SHALL NOT enqueue or send
those images. It SHALL begin new-image notification semantics only after the
baseline transaction commits and the monitor reports ready.

#### Scenario: Existing archive is first monitored

- **WHEN** the first successful scan finds existing images in nested directories
- **THEN** all found image generations are persisted as baseline entries, none is sent, and readiness is recorded after the scan completes

#### Scenario: Share is unavailable during initialization

- **WHEN** the configured root cannot be resolved or fully enumerated during the first scan
- **THEN** the monitor remains unready, sends nothing, and retries initialization without committing a partial baseline

#### Scenario: Monitor restarts with completed baseline

- **WHEN** the process restarts using a database whose baseline is complete
- **THEN** it reuses that baseline and does not treat existing images as new

#### Scenario: State database is intentionally removed

- **WHEN** the monitor starts without its previous state database
- **THEN** it creates a fresh baseline and again ignores every image present before the new ready point

### Requirement: Polling recursively detects post-baseline images

After readiness, the monitor SHALL perform serialized, periodic, recursive scans
of the configured root and SHALL detect supported image candidates at any
contained directory depth. It MUST NOT depend on filesystem watch events for
correctness and MUST NOT overlap scans.

#### Scenario: Image is added below device, date, and time directories

- **WHEN** a supported image appears after readiness at
  `device/date/time/image.jpg`
- **THEN** a later poll records it as a new candidate without requiring a watch event

#### Scenario: Previous scan runs longer than the interval

- **WHEN** a recursive scan has not completed by the next nominal poll time
- **THEN** the monitor does not start a concurrent scan and schedules the next scan after the current one settles

#### Scenario: Non-image filesystem entry appears

- **WHEN** a directory, hidden file, unsupported extension, symlink, or temporary/partial file appears
- **THEN** the monitor neither follows it as an image nor enqueues it for Feishu delivery

### Requirement: Only stable, bounded, valid images become notifications

The monitor SHALL require unchanged file identity, size, and modification
metadata across at least two consecutive successful scans before reading a new
candidate. It SHALL enforce a configured byte limit, validate recognized image
magic bytes, and recheck file metadata after the bounded read. Changed,
disappeared, oversized, malformed, non-regular, and symlinked files MUST NOT be
sent as completed images.

#### Scenario: Producer is still writing an image

- **WHEN** a candidate's size or modification metadata changes between polls
- **THEN** its stability count resets and no notification is sent

#### Scenario: File changes during read

- **WHEN** pre-read and post-read identity, size, or modification metadata differ
- **THEN** the read bytes are discarded and the candidate returns to observation

#### Scenario: Extension disguises non-image content

- **WHEN** a `.jpg` candidate lacks an accepted image signature
- **THEN** it becomes a terminal validation failure and no bytes are uploaded to Feishu

#### Scenario: Stable valid image is observed

- **WHEN** a contained regular image remains unchanged across the required scans and passes size, signature, and post-read checks
- **THEN** the monitor creates one durable ready notification event for that path and content

### Requirement: Filesystem access is read-only and contained

The monitor SHALL access only descendants of the configured canonical root,
SHALL reject symlinks and containment escapes, and MUST NOT create, modify,
rename, delete, lock, or acknowledge any file or directory on the SMB mount.
SMB credentials MUST remain outside the service configuration and repository.

#### Scenario: Symlink points outside the root

- **WHEN** an enumerated entry resolves through a symlink to another location
- **THEN** the monitor rejects it without opening the target

#### Scenario: Image is successfully delivered

- **WHEN** Feishu confirms delivery of a monitored image
- **THEN** the monitor updates only its external SQLite state and leaves the SMB file unchanged

### Requirement: Notification identity and state are durable

Before provider delivery, the monitor SHALL persist an immutable event identity
derived from normalized relative path and stable content digest. It SHALL
persist observation, readiness, attempts, retry scheduling, provider message
ID, and delivered or terminal status in its own SQLite database. The host MUST
NOT write the event into a Session `messages_out` database or represent it as
an Agent reply.

#### Scenario: Same unchanged file is seen repeatedly

- **WHEN** later scans rediscover an already recorded relative path with the same stable content
- **THEN** the unique event identity prevents another notification event

#### Scenario: Existing path receives different content

- **WHEN** a previously delivered relative path later contains different stable image bytes
- **THEN** the new digest creates one new notification event

#### Scenario: Delivered file is deleted and recreated unchanged

- **WHEN** a delivered file disappears and later returns at the same path with the same content
- **THEN** its durable event identity remains delivered and it is not sent again

### Requirement: Each new image is delivered to the fixed Feishu private conversation

For every ready event, the service SHALL upload the validated image bytes and
create an image message addressed only to the configured Feishu p2p target.
Each image SHALL be a distinct visible notification and MAY include a bounded
text companion containing only sanitized device/date/time or relative-path
metadata.

#### Scenario: One new image becomes ready

- **WHEN** the delivery worker claims one ready image event
- **THEN** it uploads the image and creates one image message in the configured RealityLoop bot private conversation

#### Scenario: Multiple images become ready

- **WHEN** several new image events are queued
- **THEN** the service delivers each as a separate image notification subject to configured ordering and rate limits

#### Scenario: Filename contains instruction-like text

- **WHEN** a relative path contains text that resembles a prompt or tool instruction
- **THEN** the service treats it only as sanitized display data and does not execute or route it

### Requirement: Feishu retries are idempotent and bounded

The monitor SHALL reuse one stable provider request UUID derived from the
durable event ID on every message-creation retry. It SHALL classify failures,
apply capped backoff with jitter and provider retry hints, recover expired
sending leases after a crash, and preserve failed work without blocking later
events.

#### Scenario: Process crashes after Feishu accepts the message

- **WHEN** message creation succeeds but the process exits before recording delivery
- **THEN** recovery retries with the same provider request UUID and does not intentionally create a second visible message

#### Scenario: Feishu rate-limits delivery

- **WHEN** Feishu returns a retryable throttling response
- **THEN** the event enters retry wait using the provider hint when available and is attempted again later

#### Scenario: Image is permanently rejected

- **WHEN** Feishu returns a classified non-retryable rejection
- **THEN** the event records a terminal sanitized failure and subsequent ready events continue to drain

### Requirement: SMB outages do not reset or replay state

A failed root resolution, enumeration, or metadata operation SHALL make the
current scan unsuccessful. The monitor SHALL retain its completed baseline and
all known event states, SHALL NOT infer deletion from the failed scan, and
SHALL retry after a bounded delay.

#### Scenario: Mounted share disconnects after readiness

- **WHEN** a poll cannot access the configured root
- **THEN** the monitor reports unavailable, sends no newly inferred event, and preserves all baseline and delivery records

#### Scenario: Share reconnects with historical files intact

- **WHEN** a later poll succeeds after an outage
- **THEN** historical and delivered files remain suppressed while genuinely new stable images proceed normally

### Requirement: Work and resource use are bounded

The monitor SHALL enforce configured bounds for image bytes, candidates
processed per scan, concurrent delivery, and send rate. Events exceeding the
current delivery budget SHALL remain durably queued rather than being dropped.
The default delivery concurrency SHALL be one.

#### Scenario: Large burst arrives

- **WHEN** more valid new images become ready than the current send-rate budget
- **THEN** only the bounded number is attempted and the remainder stays queued for later drain

#### Scenario: Oversized image appears

- **WHEN** a candidate exceeds the configured maximum byte size
- **THEN** it is not read into memory or uploaded and its validation failure is recorded

### Requirement: Monitoring does not invoke Agent capabilities

Discovery and delivery SHALL operate without creating an inbound user message,
waking an Agent container, invoking an LLM, loading a skill, calling Backend
Gateway, or changing Conversation Lane reply-mirroring subscriptions.

#### Scenario: New image appears while no user is chatting

- **WHEN** a stable new image is discovered after readiness and no Agent session is active
- **THEN** the service delivers it directly through the configured Feishu notification transport

#### Scenario: Agent platform is processing unrelated conversations

- **WHEN** the monitor sends an image while Agent sessions are active
- **THEN** their inbound/outbound databases, routing, identity chain, and delivery subscriptions remain unchanged

### Requirement: Lifecycle and outcomes are observable

The service SHALL validate configuration before scanning, expose structured
readiness, scan, SMB availability, queue-depth, attempt, retry, delivered, and
terminal-failure evidence, and handle graceful shutdown without starting new
work after cancellation. Logs MUST NOT contain image bytes, Feishu credentials,
access tokens, or unbounded provider responses.

#### Scenario: Baseline completes

- **WHEN** the first baseline transaction commits
- **THEN** the service emits an explicit `monitor ready` signal with bounded counts and no sensitive values

#### Scenario: Service receives SIGTERM

- **WHEN** the process receives a shutdown signal
- **THEN** it stops scheduling scans, bounds settlement of current work, releases its ownership lease, and closes SQLite

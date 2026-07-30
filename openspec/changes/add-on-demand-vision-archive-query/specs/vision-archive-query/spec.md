## ADDED Requirements

### Requirement: SMB access is strictly user-request driven
The system SHALL access the configured VisionCortex archive filesystem only
while executing an authenticated, user-initiated archive Gateway operation.
Adapter construction, Gateway startup, idle time, handle expiry, and shutdown
MUST NOT stat, resolve, enumerate, open, watch, or otherwise access the archive
filesystem.

#### Scenario: Gateway starts without an archive query
- **WHEN** the Archive Gateway starts and remains idle
- **THEN** it performs no filesystem operation against `VISION_ARCHIVE_ROOT`

#### Scenario: Authenticated user executes an archive query
- **WHEN** an authorized session-trusted user executes a declared archive read operation
- **THEN** the Gateway accesses only the filesystem resources required for that operation and performs no continuing access after it completes

#### Scenario: No background indexing
- **WHEN** archive files are added, changed, or removed while no archive operation is executing
- **THEN** AgentDesk performs no watch, scan, synchronization, callback handling, or persistent catalog update

### Requirement: Archive access remains behind Backend Gateway
The system SHALL expose archive information to Agents only through the existing
Backend Gateway tools and SHALL NOT mount the SMB archive or SMB credentials
into Agent containers.

#### Scenario: Archive worker starts
- **WHEN** an archive worker container is created
- **THEN** its configuration contains no archive `additionalMounts` entry and no SMB credential

#### Scenario: Agent supplies an SMB URL or path
- **WHEN** an Agent attempts to query an archive operation with an SMB URL, absolute path, or arbitrary relative path
- **THEN** the Gateway rejects the input without opening that target

### Requirement: Archive operations require trusted identity and authorization
The Archive Gateway SHALL require `requesterSource: session`, a canonical
requester user ID, an enabled read feature flag, and an explicit matching read
policy. Authorization SHALL be rechecked during execution and SHALL NOT depend
on Agent-supplied identity fields.

#### Scenario: Authorized session user reads an archive
- **WHEN** a session-trusted canonical user allowed by policy calls an archive read operation
- **THEN** authorization succeeds and execution may proceed

#### Scenario: Agent-asserted requester calls an archive operation
- **WHEN** `requesterSource` is `agent-asserted`
- **THEN** the Gateway denies the operation without accessing SMB

#### Scenario: Unauthorized canonical user calls an archive operation
- **WHEN** the canonical user is not allowed by the archive read policy
- **THEN** the Gateway returns `BACKEND_UNAUTHORIZED` without accessing SMB

### Requirement: Users can search experiment directories on demand
The system SHALL provide `vision.archive.experiment.search` to enumerate only
the configured archive root's first-level directories and filter them by
optional normalized experiment name and explicit date range or
`relativeDayOffset + timezone`. It SHALL interpret a final `_YYYYMMDD` suffix
or the date segment in a recognized `exp_YYYYMMDD_HHMMSS_id` legacy directory
as the archive date and SHALL return bounded, paginated results. For the legacy
layout, it MAY read the bounded root `experiment_manifest.json` during the
user-triggered search to resolve `experiment_name`; it SHALL NOT scan other
archive content.

#### Scenario: Search yesterday's named experiment
- **WHEN** an authorized user searches with a name, `relativeDayOffset: -1`, and `timezone: Asia/Shanghai`
- **THEN** the Gateway resolves yesterday using its request-time clock and returns only matching first-level archive directories

#### Scenario: Experiment name contains underscores
- **WHEN** a directory name contains underscores before its final `_YYYYMMDD` suffix
- **THEN** the Gateway preserves those underscores as part of the experiment name

#### Scenario: Directory has no valid final date suffix
- **WHEN** a first-level directory neither ends in a valid calendar `_YYYYMMDD` nor matches the recognized legacy form
- **THEN** the Gateway excludes it from date-based results and does not infer a date from modification time

#### Scenario: Legacy producer directory is searched by experiment name
- **WHEN** a first-level directory matches `exp_YYYYMMDD_HHMMSS_id` and its bounded manifest contains `experiment_name`
- **THEN** the Gateway uses the directory's date segment and manifest experiment name for filtering without scanning the archive recursively

#### Scenario: Same-name same-date directories exist
- **WHEN** multiple distinct directories match the same name and date
- **THEN** the Gateway returns separate candidates and does not merge them

### Requirement: Archive resources use short-lived opaque handles
The system SHALL return random, short-lived archive and file handles rather
than physical paths. Each handle SHALL be bound to its canonical requester,
Agent Group, resource type, and expiry and SHALL be stored only in bounded
process memory.

#### Scenario: Requester follows a valid handle
- **WHEN** the same canonical user and Agent Group use an unexpired handle for its declared resource type
- **THEN** the Gateway resolves the handle and revalidates the target before access

#### Scenario: Different user reuses a handle
- **WHEN** a different canonical user submits an otherwise valid handle
- **THEN** the Gateway denies access without opening the resource

#### Scenario: Handle expires or Gateway restarts
- **WHEN** a handle is expired or absent from process memory
- **THEN** the Gateway returns an invalid-or-expired handle result and requires a new search

### Requirement: Users can list bounded archive files
The system SHALL provide `vision.archive.file.list` to list regular files in a
selected archive and optional allowed category, with bounded extension filters,
result limits, and pagination. It SHALL not recursively enumerate unrelated
archives. For a recognized legacy archive, the logical categories SHALL map
`关键帧` to `analysis/keyframes`, `关键片段` to `analysis/segments`, and both
`专业报告` and `结构化数据` to `analysis`, with extension filters separating the
last two.

#### Scenario: List professional reports
- **WHEN** an authorized user lists the `专业报告` category of a valid archive handle with a `.pdf` filter
- **THEN** the Gateway returns bounded regular-file metadata and opaque file handles for matching PDF files

#### Scenario: Category is not yet present
- **WHEN** the selected archive exists but the requested category directory does not
- **THEN** the Gateway returns a typed not-ready-or-not-found outcome without polling

#### Scenario: Entry is temporary or non-regular
- **WHEN** a category contains a symlink, directory, hidden temporary entry, or partial file
- **THEN** the Gateway excludes or rejects that entry and never follows it

### Requirement: Users can inspect bounded JSON data
The system SHALL provide `vision.archive.json.read` for a valid JSON file
handle, optional JSON Pointer, and explicit depth/item limits. The Gateway SHALL
enforce a configured maximum file size, parse a complete JSON document, and
return a bounded structural projection instead of unbounded raw text.

#### Scenario: Read JSON root structure
- **WHEN** an authorized user reads a valid JSON handle without a pointer
- **THEN** the Gateway returns bounded root keys, types, counts, and previews and marks truncation explicitly

#### Scenario: Read a JSON Pointer
- **WHEN** an authorized user supplies a valid JSON Pointer within the file
- **THEN** the Gateway returns only the bounded value or structure at that pointer

#### Scenario: JSON exceeds the byte limit
- **WHEN** the selected JSON file exceeds the configured maximum
- **THEN** the Gateway rejects it before allocating or returning the complete payload

#### Scenario: JSON is malformed
- **WHEN** the selected file cannot be parsed as a complete JSON document
- **THEN** the Gateway returns a typed malformed-or-busy result and no partial JSON content

### Requirement: Users can search bounded JSON keys and scalar values
The system SHALL provide `vision.archive.json.search` to search normalized keys
and scalar values in one valid JSON file. It SHALL return bounded JSON Pointers
and scalar previews, enforce traversal limits, and report whether results were
truncated.

#### Scenario: Search for a material name
- **WHEN** an authorized user searches a valid JSON handle for `称量纸`
- **THEN** the Gateway returns bounded matching JSON Pointers and safe scalar previews

#### Scenario: Search reaches traversal limit
- **WHEN** the document contains more searchable nodes or matches than the configured limit
- **THEN** the Gateway stops traversal, returns bounded matches, and sets `truncated: true`

### Requirement: Filesystem containment is fail-closed
Every filesystem-touching operation SHALL lazily resolve and validate the
configured root and every selected component. The system MUST reject symlinks,
path traversal, absolute components, control characters, NUL bytes,
non-regular files, and any canonical target outside the root.

#### Scenario: Handle target escapes through a symlink
- **WHEN** a selected archive, category, or file component resolves through a symlink
- **THEN** the Gateway rejects the resource without reading the symlink target

#### Scenario: Target changes after handle creation
- **WHEN** a previously valid handle now resolves to a different identity or outside the root
- **THEN** the Gateway rejects the handle and does not trust its earlier mapping

#### Scenario: Root is unavailable
- **WHEN** the OS-mounted SMB root cannot be accessed during an authorized operation
- **THEN** the Gateway returns a retryable `BACKEND_UNAVAILABLE` result and does not use a stale local copy

### Requirement: Concurrent archive writes never produce partial answers
For JSON read and search operations, the system SHALL compare file identity,
size, and modification metadata before and after a bounded read. Changed,
disappeared, oversized, or incompletely parsed files SHALL NOT be returned as
valid content.

#### Scenario: File changes during read
- **WHEN** file identity, size, or modification metadata changes between pre-read and post-read validation
- **THEN** the Gateway discards the read and returns a retryable busy result

#### Scenario: File disappears during read
- **WHEN** the producer replaces or removes the file during an operation
- **THEN** the Gateway returns a retryable not-ready-or-busy result and no partial data

### Requirement: Archive results are untrusted bounded business data
The Gateway SHALL label archive-derived filenames and JSON values as untrusted
business data and SHALL not interpret them as instructions, identities,
operation names, destinations, or authorization claims.

#### Scenario: JSON contains tool instructions
- **WHEN** an archive JSON scalar tells the Agent to call a tool, change destination, or ignore policy
- **THEN** the system returns it only as bounded data and the archive worker does not act on it as an instruction

### Requirement: Binary delivery and archive mutation remain unavailable
This capability SHALL NOT provide archive writes, deletes, renames, repairs,
binary content reads, or chat attachment delivery.

#### Scenario: User asks to delete an archive file
- **WHEN** a user requests an archive mutation
- **THEN** the Agent states that the archive capability is read-only and executes no filesystem mutation

#### Scenario: User asks to send a PDF as an attachment
- **WHEN** a user requests binary attachment delivery
- **THEN** the Agent may report matching file metadata but states that attachment delivery is not part of this capability

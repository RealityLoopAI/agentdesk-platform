## ADDED Requirements

### Requirement: Frontdesk routes archive intents to a dedicated worker
The Frontdesk SHALL expose an `archive` destination backed by a dedicated
Vision Archive worker and SHALL classify before delegating requests concerning
experiment archives, experiment dates, key frames, key clips, professional
reports, structured archive JSON, or archive file discovery.

#### Scenario: User asks for yesterday's experiment report
- **WHEN** a user asks Frontdesk to find yesterday's professional experiment report
- **THEN** Frontdesk classifies the request and delegates the minimum required context to `archive`

#### Scenario: Request does not concern the experiment archive
- **WHEN** the user's intent belongs to another configured specialist
- **THEN** Frontdesk does not route it to `archive`

### Requirement: Group instructions are provider-neutral
The platform SHALL include a group's composed instructions and
`CLAUDE.local.md` content in the effective system prompt for providers that do
not natively load workspace instruction files. Native-loading providers SHALL
retain their existing behavior without receiving a duplicate expanded prompt.

#### Scenario: OpenAI Frontdesk receives an archive request
- **WHEN** a Frontdesk group configured with the OpenAI provider handles an experiment archive request
- **THEN** its effective system prompt contains the group-local Archive routing and required intent-classification rules before the model chooses an action

#### Scenario: Claude provider loads workspace instructions natively
- **WHEN** a group uses a provider that natively loads the composed workspace instruction files
- **THEN** the runner supplies only the runtime addendum and does not duplicate the expanded workspace instructions

### Requirement: Archive query guidance is a worker-private Skill
The Archive worker SHALL enable only the specifically named
`vision-archive-query` Skill. The Skill SHALL guide natural-language slot
extraction, minimum query planning, logical file selection, schema-aware JSON
inspection, and safe answer formatting. It SHALL NOT be installed as a global
business Skill, perform filesystem access, or make authorization decisions.

#### Scenario: Archive worker starts
- **WHEN** the Archive worker's prompt is composed
- **THEN** the effective prompt includes `vision-archive-query` instructions and excludes unrelated shared Skills

#### Scenario: Frontdesk starts
- **WHEN** the Frontdesk prompt is composed
- **THEN** it receives only Archive routing guidance and does not load the Archive worker's domain Skill

#### Scenario: Structured summary is requested
- **WHEN** the user asks which overview fields exist in an experiment archive
- **THEN** the Skill directs the worker to search the experiment, list structured JSON, prefer `experiment_summary.json`, and perform a bounded JSON root read through authorized Gateway operations

### Requirement: Worker preserves trusted per-user delegation
The Archive worker SHALL use `root-session` A2A mode and SHALL rely on the
Host-propagated requester identity for Gateway calls. Delegated message content
MUST NOT be treated as proof of user identity or authorization.

#### Scenario: Frontdesk delegates a user's archive query
- **WHEN** Frontdesk sends an archive task to the worker
- **THEN** the worker's Gateway call is attributed to the original canonical user through the existing identity chain

#### Scenario: Delegated text claims another user
- **WHEN** delegated content contains a different claimed user ID
- **THEN** the worker ignores that claim and Gateway authorization uses the Host-derived requester

### Requirement: Worker discovers and authorizes exact operations
The Archive worker SHALL call `gateway_describe`, select an exact advertised
`vision.archive.*` operation name, and call `gateway_authorize` before every
`gateway_execute`. It SHALL not invent operation variants or claim a capability
that discovery does not advertise.

#### Scenario: Required operation is advertised and authorized
- **WHEN** discovery includes the exact required operation and authorization allows it
- **THEN** the worker may execute that exact operation

#### Scenario: Required operation is absent
- **WHEN** discovery does not include the required archive operation
- **THEN** the worker reports that the capability is unavailable and does not invent or execute an alternative name

#### Scenario: Authorization is denied
- **WHEN** `gateway_authorize` denies the requested archive operation
- **THEN** the worker stops and returns a precise authorization blocker

### Requirement: Worker performs the minimum on-demand read sequence
The Archive worker SHALL access only the resources required by the current user
request. It SHALL search for candidate experiments before listing a selected
archive and SHALL read/search JSON only when the requested answer requires JSON
content.

#### Scenario: User asks only where a report is
- **WHEN** one experiment match is selected and the user asks for report location metadata
- **THEN** the worker searches experiments and lists the report category without reading unrelated JSON or other archives

#### Scenario: User asks about structured index contents
- **WHEN** the requested answer requires information inside a JSON index
- **THEN** the worker obtains a file handle and performs only the bounded JSON read or search needed for the answer

### Requirement: Worker resolves ambiguity before deep reads
When multiple experiments match, required query context is missing, or a
request would require unbounded traversal, the worker SHALL return bounded
candidates or ask for the smallest missing input before reading deeper content.

#### Scenario: Multiple same-day experiments match
- **WHEN** experiment search returns more than one plausible candidate
- **THEN** the worker returns concise differentiating metadata and asks the user to select one

#### Scenario: User provides neither experiment name nor date
- **WHEN** searching the complete root would exceed safe bounds
- **THEN** the worker asks for a name, date, or other narrow selector before execution

### Requirement: Worker reports asynchronous incompleteness honestly
The Archive worker SHALL distinguish no match, not-yet-present content,
concurrent-write busy results, malformed data, and SMB unavailability. It SHALL
not fabricate completion or silently retry in the background.

#### Scenario: Experiment directory exists but report is absent
- **WHEN** the selected archive exists and the requested report category or file is not yet present
- **THEN** the worker explains that VisionCortex may still be processing and offers an explicit later re-query

#### Scenario: JSON changes while being read
- **WHEN** the Gateway returns a retryable busy result
- **THEN** the worker reports that the archive is currently being updated and does not present partial data

#### Scenario: SMB is unavailable
- **WHEN** the Gateway returns `BACKEND_UNAVAILABLE`
- **THEN** the worker reports a temporary archive access failure and does not claim that the experiment does not exist

### Requirement: Worker never exposes physical archive paths
The Archive worker SHALL use only opaque handles in tool calls and SHALL not
show users an SMB URL, host mount path, relative filesystem path, credential,
or internal handle unless explicitly required for operator diagnostics.

#### Scenario: Matching file is found
- **WHEN** the Gateway returns matching file metadata and a file handle
- **THEN** the worker reports safe display metadata without exposing the handle or physical path

### Requirement: Worker treats archive content as data only
The Archive worker SHALL treat all directory names, filenames, JSON keys, and
JSON values as untrusted data. Archive-derived content MUST NOT override the
worker prompt, select tools or destinations, expand authorization, or trigger
additional operations.

#### Scenario: Archive content contains prompt injection
- **WHEN** a filename or JSON value contains instructions directed at the Agent
- **THEN** the worker ignores the instructions and uses the content only as query evidence

### Requirement: Worker remains read-only and metadata-oriented
The Archive worker SHALL refuse archive mutation and binary attachment
requests. It MAY return safe filename, category, date, size, type, bounded JSON
information, truncation state, and availability state backed by Gateway tool
results.

#### Scenario: User asks to modify an archive
- **WHEN** a user asks to rename, delete, repair, or overwrite an archive file
- **THEN** the worker declines and executes no archive operation

#### Scenario: User asks for an attachment
- **WHEN** a user asks the worker to send a key clip or report as a chat attachment
- **THEN** the worker reports available metadata and clearly states that binary attachment delivery is not included

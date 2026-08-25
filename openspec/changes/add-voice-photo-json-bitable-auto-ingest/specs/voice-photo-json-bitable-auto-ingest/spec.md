## ADDED Requirements

### Requirement: Monitoring is explicitly bound to a trusted machine-ingress deployment

The service SHALL remain disabled unless an operator supplies a local absolute
read-only root, an external writable state database, a canonical Host user, a
closed scene-to-logical-resource/field/unit mapping, and a machine ingest HMAC
key. It MUST reject SMB URLs, physical Bitable identifiers, relative paths,
state paths inside the monitored root, invalid mappings, and placeholder keys
before scanning.

#### Scenario: Complete trusted binding is configured

- **WHEN** the operator enables the service with every valid binding
- **THEN** it may establish its first JSON baseline and emit machine-ingress events

#### Scenario: Physical table identifier is configured

- **WHEN** the resource resembles a Feishu app token or table ID
- **THEN** startup fails before any file scan or Gateway call

### Requirement: First successful JSON scan establishes a no-write baseline

The monitor SHALL record every eligible JSON generation present in the first
successful complete scan and SHALL NOT create Bitable records for those
generations. Automatic ingestion SHALL begin only after the baseline
transaction commits.

#### Scenario: Existing JSON files are present at first start

- **WHEN** the initial successful scan finds existing JSON files
- **THEN** it records them as baseline history and creates zero machine events

#### Scenario: The share is unavailable during initialization

- **WHEN** the root cannot be fully enumerated
- **THEN** no partial baseline is committed and no Bitable write is attempted

### Requirement: Only stable bounded JSON files are parsed

The monitor SHALL recursively poll for non-hidden `.json` regular files,
require unchanged identity and metadata across consecutive successful scans,
enforce a configured byte limit, decode strict UTF-8 JSON, and recheck metadata
after reading. It MUST NOT follow symlinks or read containment escapes.

#### Scenario: JSON is still being written

- **WHEN** a candidate changes between observations or during its read
- **THEN** parsing is deferred and no machine event is created

#### Scenario: JSON is malformed or oversized

- **WHEN** a stable candidate cannot be parsed within the configured bounds
- **THEN** that content generation records a bounded validation failure and later files continue

### Requirement: Qualification uses the closed final-analysis schema

An accepted document SHALL contain a non-empty `场景`, a non-empty `帧结果`
array, top-level `画面状态` equal to `清晰`, `有读数` equal to `true`, a
finite decimal `最终数值`, a unit accepted by the exact configured scene route,
finite confidence values in `[0,1]`, non-empty `帧间一致性`, `采用图片`, and
`准确性判断`. The adopted
frame MUST exist in `帧结果`, be clear, contain a reading, and agree with the
final numeric value and unit. Missing, contradictory, or unclear documents
MUST NOT create a Bitable record.

#### Scenario: Complete clear result is observed

- **WHEN** all final fields are valid and the adopted frame agrees with them
- **THEN** the monitor produces one deterministic Bitable draft

#### Scenario: Final image state is not clear

- **WHEN** top-level `画面状态` is not exactly `清晰`
- **THEN** the generation is recorded as not qualified and no write is attempted

#### Scenario: Adopted frame conflicts with final value

- **WHEN** `采用图片` identifies a frame whose value or unit differs from the final summary
- **THEN** the document fails closed and no write is attempted

### Requirement: Scene routing, target fields, and constants are deterministic

The monitor SHALL select a route by exact `场景` before Agent ingress. The draft
SHALL contain only that route's configured target fields and bind its configured
logical resource. The monitor and Agent MUST NOT infer a scene, fall back to a
different table, add fields, convert an unsupported unit, or change target
names.

#### Scenario: Scene-one speed document qualifies

- **WHEN** `场景=场景一`, the final value is `650`, and the unit is `rpm`
- **THEN** the resource is `voice.photo.scene1` and fields are exactly `批次=测试版本` and `转速=650`

#### Scenario: Scene-two mass document qualifies

- **WHEN** `场景=场景二`, the final value is `4.4041`, and the unit is `g`
- **THEN** the resource is `voice.photo.scene2` and fields contain only the configured scene-two static fields plus `无水氯化铜（克）=4.4041`

#### Scenario: Scene is unknown

- **WHEN** `场景` has no exact configured route
- **THEN** processing fails before Agent ingress and no table is selected

#### Scenario: Live table schema is incompatible

- **WHEN** Field List does not expose every configured target with a compatible type
- **THEN** processing stops before Create and no subset record is written

### Requirement: Automatic Create requires a content-bound machine proof

The monitor SHALL derive a stable JSON digest and an idempotency key containing
an HMAC proof bound to the exact logical resource and exact final field object.
The Gateway SHALL accept unattended Create only when the proof is valid, the
canonical user and dedicated Agent group remain authorized, and the live field
schema validates the exact fields. A missing, copied-and-modified, malformed,
or expired-format proof MUST fail closed.

#### Scenario: Valid machine draft reaches the dedicated Worker

- **WHEN** Field List and authorization succeed and the HMAC proof matches the exact Create input
- **THEN** the Worker executes Create without requesting a confirmation card and verifies the returned Record by ID using live-schema semantics, including exact decimal equivalence for Number fields returned as strings

#### Scenario: Agent changes one field

- **WHEN** the Create fields differ from the machine-signed draft
- **THEN** Gateway rejects execution and creates no record

#### Scenario: User manually types a similar JSON envelope

- **WHEN** no valid machine proof binds the requested resource and fields
- **THEN** the unattended path is unavailable and normal confirmation policy is not bypassed

### Requirement: Event and write identity are durable and idempotent

The service SHALL persist one immutable event for each normalized relative path
and content digest before Host ingress. Retries and restarts SHALL reuse the
same request fingerprint and Gateway idempotency key. A successfully verified
event SHALL not create a second record.

#### Scenario: Host or Agent retries the same event

- **WHEN** a transient failure causes the event to be submitted again
- **THEN** the same Gateway idempotency key is reused and at most one record is committed

#### Scenario: Same path receives new JSON content

- **WHEN** a processed path later contains a different stable digest
- **THEN** it is evaluated as a new generation and may create one new record

### Requirement: Filesystem and platform boundaries remain intact

The monitor MUST leave the SMB tree unchanged, MUST NOT hold physical Bitable
identifiers or Feishu Bitable credentials, MUST NOT call the Bitable API or
Gateway `/execute` directly, and MUST enter through Host trusted ingress so the
existing user identity, HMAC signing, authorization, and audit chain remains
load-bearing.

#### Scenario: Qualified JSON is submitted

- **WHEN** a machine event is emitted
- **THEN** the monitor modifies only its external SQLite state and the Host/Gateway path owns the business write

#### Scenario: Gateway or Host is unavailable

- **WHEN** trusted ingress, authorization, Create, or verification fails
- **THEN** the event remains durably retryable or terminal by classification and no parallel write path is attempted

### Requirement: Image notification and JSON ingestion run in parallel

The updated deployment SHALL preserve post-baseline image upload and delivery
to the configured fixed Feishu P2P target while independently monitoring JSON.
Image and JSON observations, baselines, retries, and terminal states MUST use
separate durable state. A valid machine-ingest Create SHALL not create a
confirmation card.

#### Scenario: Images and one qualifying JSON coexist

- **WHEN** the folder contains image files and a new qualifying JSON file
- **THEN** each stable new image is pushed once to the configured Feishu P2P target and the JSON generation can independently produce one automatic Bitable record

#### Scenario: One parallel path is unavailable

- **WHEN** image delivery or JSON Agent/Gateway processing fails
- **THEN** the other path continues polling and its durable state is not changed by that failure

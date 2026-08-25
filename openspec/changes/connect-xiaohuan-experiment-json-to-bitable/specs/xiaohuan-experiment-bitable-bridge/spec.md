## ADDED Requirements

### Requirement: Start only with an explicit trusted deployment binding
The Bridge SHALL default to disabled and SHALL require explicit Ark-upload consent, an operator-configured canonical user, a Feishu P2P platform route, an approved logical Bitable resource and a valid field mapping before opening the audio listener.

#### Scenario: Required binding is incomplete
- **WHEN** the Bridge is enabled but any required consent, identity, route, resource or mapping value is missing or invalid
- **THEN** it fails before binding TCP, uploading audio to Ark or creating an Agent turn

#### Scenario: Group target is configured
- **WHEN** the configured Feishu destination is not a P2P route
- **THEN** the Bridge rejects the configuration

### Requirement: Receive bounded whole-utterance WAV uploads
The Bridge SHALL expose `POST /api/audio` on the operator-configured TCP bind and port, SHALL accept only a raw `audio/wav` body with explicit bounded `Content-Length`, SHALL validate PCM signed 16-bit little-endian, 16000 Hz, mono, non-empty and bounded duration before durable acceptance, and SHALL expose a content-safe `GET /healthz`.

#### Scenario: Valid whole utterance is uploaded
- **WHEN** hardware POSTs one valid bounded WAV and capacity is available
- **THEN** the Bridge atomically stores it, enqueues exactly one Ark job, returns HTTP 202 with a safe filename and duration, and remains ready for later requests

#### Scenario: Upload contract is invalid
- **WHEN** the method, path, content type, content length, body completeness or WAV format violates the contract
- **THEN** the Bridge returns a bounded non-2xx JSON error and creates no Ark or Agent work

#### Scenario: Audio queue is full
- **WHEN** a new valid non-duplicate WAV arrives while the bounded Ark queue has no capacity
- **THEN** the Bridge returns a retryable non-2xx response and does not claim the utterance was accepted

#### Scenario: Hardware retries identical bytes
- **WHEN** an already accepted WAV payload is POSTed again in the same Bridge process
- **THEN** the Bridge returns a successful duplicate response and does not create another Ark job, Agent turn or business intent

### Requirement: Reuse the bounded Xiaohuan Ark pipeline
The Bridge SHALL reuse WAV validation, the single-stage Ark multimodal extractor and `experiment-audio.v1` validation, and SHALL accept only Schema-valid results for downstream delivery.

#### Scenario: Valid utterance completes
- **WHEN** one accepted WAV returns a Schema-valid Ark result
- **THEN** the Bridge creates exactly one bounded downstream draft for that capture while HTTP listening continues

#### Scenario: One utterance fails
- **WHEN** WAV validation, Ark processing or structured-output validation fails for one utterance
- **THEN** the Bridge emits a content-free typed error, creates no Agent turn for that utterance and remains eligible to process later utterances

### Requirement: Produce a target-locked partial field draft
The Bridge SHALL map only supported `experiment-audio.v1` source paths to unique operator-configured target field names using bounded deterministic encoding or explicit selectors, SHALL preserve the normalized field mapping in the envelope, and SHALL omit unresolved values rather than inventing them or discarding otherwise usable transcript evidence.

#### Scenario: Mapping succeeds
- **WHEN** a valid result contains configured source paths
- **THEN** the Bridge produces the same partial Bitable field draft, field mapping and source-bound fingerprint for the same result, resource and mapping

#### Scenario: Mapping is unsafe
- **WHEN** a mapping contains an unknown source path, duplicate target field, empty target name or produces an over-limit value
- **THEN** the Bridge rejects the draft before an Agent turn or write request is created

#### Scenario: Optional value is null
- **WHEN** a configured optional source path resolves to `null`
- **THEN** the Bridge omits that field rather than inventing a value

#### Scenario: Action target selector has one match
- **WHEN** an action-target rule finds exactly one action whose name exactly matches the configured name and whose target is non-empty
- **THEN** the Bridge maps that target unchanged to the configured field

#### Scenario: Measurement value selector has one match
- **WHEN** a measurement-value rule finds exactly one measurement whose name and optional unit exactly match the configured selector and whose value is non-null
- **THEN** the Bridge maps that numeric or string value unchanged to the configured field

#### Scenario: Transcript marker selector has one bounded match
- **WHEN** a text-after-marker rule on transcript finds exactly one configured marker followed by one non-empty phrase ending at a supported sentence delimiter or transcript end
- **THEN** the Bridge maps only the trimmed phrase after the marker to the configured field

#### Scenario: Transcript marker selector is unsafe
- **WHEN** a text-after-marker rule is configured on another source, contains invalid markers, has zero or multiple matches, or has no bounded phrase terminator
- **THEN** configuration errors fail startup, while unresolved runtime candidates are omitted without guessing and complete-draft mapping fails closed

#### Scenario: Selector is ambiguous or missing in structured output
- **WHEN** an action or measurement selector finds zero matches, multiple matches, an empty target or a null value
- **THEN** the Bridge omits that preliminary field, preserves the mapping and source evidence for the Worker, and does not itself choose, translate, convert or infer a value

#### Scenario: Empty collection was extracted
- **WHEN** a mapped string collection is empty but the transcript may still contain the requested fact
- **THEN** the Bridge omits the empty preliminary value while preserving the mapping and transcript for bounded downstream normalization

#### Scenario: Ark omits an explicitly spoken batch
- **WHEN** transcript contains a bounded phrase such as `批次测试十号，` but structured `sampleIds` is empty and the deployment maps transcript with marker `批次`
- **THEN** the Bridge deterministically emits `测试十号` for the locked batch target without waiting for Agent re-extraction

### Requirement: Normalize only within transcript evidence and live Field List
The Worker SHALL treat Bridge fields as preliminary, SHALL obtain the live Field List before normalization, and SHALL produce final fields only for operator-configured mapping targets using explicit transcript or structured experiment evidence and the live field type and options.

#### Scenario: Common ASR homophone maps uniquely to a select option
- **WHEN** a preliminary single-select value is not an option but the transcript context and live options support exactly one plausible correction
- **THEN** the Worker uses that exact live option as the final value and shows it in the original-user confirmation card

#### Scenario: Structured extraction omitted an explicit text fact
- **WHEN** a mapped text value is absent but the transcript explicitly contains one bounded value following the corresponding field marker
- **THEN** the Worker may recover that explicit value for the configured target field

#### Scenario: Numeric or unit evidence is absent
- **WHEN** a numeric value or unit is not explicit in the transcript or structured measurements
- **THEN** the Worker does not infer, default, calculate or convert it

#### Scenario: Correction is ambiguous
- **WHEN** more than one live option is plausible, source evidence conflicts, or a bounded value cannot be located
- **THEN** the Worker stops before authorization, confirmation or execution and requests clarification instead of choosing a value

#### Scenario: Mapping target is not configured
- **WHEN** transcript or experiment content suggests a field not present in the envelope field mapping
- **THEN** the Worker does not add that field

### Requirement: Enter through Host trusted ingress
The Bridge SHALL submit each accepted draft through `ChannelSetup.onInboundEvent` to the configured Feishu P2P route with the operator-bound canonical user and SHALL NOT derive or override identity from audio, transcript, model output or device address.

#### Scenario: Structured result is delivered
- **WHEN** a valid mapped draft is ready
- **THEN** the Host routes a normal inbound turn attributed to the configured canonical user and preserves that identity through Agent delegation

#### Scenario: Inbound routing fails
- **WHEN** the Host rejects or cannot route the synthetic inbound event
- **THEN** the Bridge reports a safe per-utterance delivery failure and does not call Feishu Bitable or Gateway directly

### Requirement: Use only the sanctioned Bitable create workflow
The downstream instruction SHALL constrain the Agent to the configured logical resource and the existing `gateway_describe`, `feishu.bitable.field.list`, `gateway_authorize`, Host-mediated Create confirmation, `gateway_execute` and `feishu.bitable.record.get` workflow.

#### Scenario: Original user confirms
- **WHEN** the configured P2P user approves a Schema-valid normalized Create draft
- **THEN** the Worker executes one Gateway `record.create` with a stable source-bound idempotency key and verifies the returned Record by ID

#### Scenario: Confirmation is absent
- **WHEN** confirmation is cancelled, rejected, expired or supplied by a different user
- **THEN** no Bitable Create is executed

#### Scenario: Gateway rejects the draft
- **WHEN** the resource is unavailable, the user is not a writer, an Operation is not published or field validation fails
- **THEN** the workflow fails closed and reports the bounded reason without a parallel write attempt

### Requirement: Keep Bitable credentials and physical identifiers out of the Bridge
The Bridge MUST NOT accept or retain Feishu app credentials, tenant tokens, physical app tokens or table IDs and MUST NOT call Feishu Bitable APIs or Gateway execution endpoints directly.

#### Scenario: Bridge runs in process mode
- **WHEN** any number of utterances are processed
- **THEN** Bitable credentials remain only in the Gateway deployment and every business write remains attributable to a Host/Gateway audit chain

### Requirement: Shut down without leaking audio or pending work
The Bridge SHALL stop accepting HTTP requests on teardown, drain already accepted bounded model work, clean program-created temporary WAV files by default and stop producing new Agent turns.

#### Scenario: Host shuts down
- **WHEN** Channel teardown occurs during idle or active capture
- **THEN** the TCP listener closes, eligible accepted work is bounded and drained, temporary audio is cleaned and no later turn is emitted

### Requirement: Leave wake, endpointing and audible feedback to hardware
The Bridge SHALL NOT perform wake-word detection, VAD endpointing, photo-command routing or device TTS acknowledgement; these behaviors belong to the hardware audio state machine.

#### Scenario: An utterance is accepted or processed
- **WHEN** the Bridge receives, transcribes, confirms or writes an utterance
- **THEN** it makes no request to the device TTS endpoint and does not attempt to control hardware recording state

### Requirement: Serialize drafts across confirmation lifecycles
The Bridge SHALL allow at most one active Agent draft, SHALL distinguish Agent processing from awaiting confirmation, SHALL queue later structured results in bounded FIFO order, and SHALL release or retry the active draft only from a correlated Agent-turn or confirmation terminal event.

#### Scenario: Later utterance completes while confirmation is pending
- **WHEN** one Bridge draft is active and another utterance produces valid structured output
- **THEN** the later draft is queued and creates no Agent turn until the active confirmation resolves

#### Scenario: Active confirmation resolves
- **WHEN** a Host resolved event matches the active confirmation ID, canonical user and Feishu P2P route
- **THEN** the Bridge clears the active draft and submits exactly the next queued draft

#### Scenario: Unrelated confirmation resolves
- **WHEN** a resolved event belongs to another confirmation, user or route
- **THEN** the active draft remains blocked and no queued draft is submitted

#### Scenario: No confirmation is ever created
- **WHEN** a correlated Agent turn completes and no confirmation is delivered within the bounded settle window
- **THEN** the Bridge safely releases it and continues with the next queued draft without treating completion as approval

#### Scenario: Agent is still processing
- **WHEN** a later utterance completes before the active Agent turn emits a terminal event
- **THEN** the later draft remains queued even when no confirmation ID has been created yet

#### Scenario: Confirmation arrives around Agent completion
- **WHEN** a matching confirmation-delivered event arrives before the Agent completion settle window expires
- **THEN** the Bridge enters awaiting-confirmation and does not release the next draft until that confirmation resolves

#### Scenario: Confirmation lifetime expires
- **WHEN** an active draft has bound to a confirmation but no matching resolved event arrives within the confirmation lifetime bound
- **THEN** the Bridge safely releases it without treating the timeout as approval

#### Scenario: Draft queue reaches its bound
- **WHEN** another structured result arrives while the bounded pending draft queue is full
- **THEN** the Bridge reports a content-safe overflow error and creates no Agent turn for that result

### Requirement: Correlate every Agent turn terminal outcome
The Runner SHALL emit one Host-observable terminal action for each processed trusted inbound turn, SHALL bind it to the original inbound message through `in_reply_to`, and SHALL classify whether a provider failure is retryable without granting authorization.

#### Scenario: Turn completes without a confirmation
- **WHEN** the Agent finishes processing an inbound Bridge draft without creating a confirmation
- **THEN** Host emits a correlated `completed` terminal event and the Bridge can release that draft after its settle window

#### Scenario: Provider request fails
- **WHEN** the Agent provider exhausts its internal request retries
- **THEN** Host emits a correlated `provider-failed` terminal event with a bounded error code and retryable flag

#### Scenario: Terminal event is unrelated
- **WHEN** a turn terminal event references another source message or session
- **THEN** the active Bridge draft and queue remain unchanged

#### Scenario: Error reply is produced
- **WHEN** Runner writes a provider error action, user-visible error, clear acknowledgement or terminal action
- **THEN** every output carries the current trusted `in_reply_to` routing anchor

### Requirement: Retry transient Agent failures without duplicating business intent
The Bridge SHALL retry only classified transient provider failures with bounded attempts and backoff, SHALL keep the source fingerprint stable, and SHALL use a distinct Host inbound message ID for each attempt.

#### Scenario: Transient failure recovers
- **WHEN** an active attempt fails with a retryable provider code and a later bounded attempt completes
- **THEN** the Bridge preserves one logical request fingerprint and proceeds with at most one confirmation lifecycle

#### Scenario: Retry is exhausted
- **WHEN** all configured Bridge retry attempts fail
- **THEN** the Bridge reports a content-safe terminal failure, releases the active draft and processes the next queued draft

#### Scenario: Failure is not retryable
- **WHEN** the terminal code denotes unauthorized, client error, invalid response or another non-transient failure
- **THEN** the Bridge does not retry and safely advances to the next queued draft

### Requirement: Bound the complete model request context
The OpenAI-compatible provider SHALL evaluate context pressure using transcript, system instructions and serialized tool definitions, SHALL compact before sending an over-budget request, and SHALL keep the outgoing request within the configured full-request character budget or fail closed.

#### Scenario: Tools make the full request exceed budget
- **WHEN** transcript alone is below the old compaction threshold but transcript plus system instructions and tools exceeds the full-request budget
- **THEN** the provider compacts or trims transcript before issuing the upstream request

#### Scenario: Compaction is insufficient
- **WHEN** summary compaction succeeds but the complete request remains over budget
- **THEN** the provider hard-trims transcript using only the budget remaining after fixed system and tool overhead

#### Scenario: Fixed request overhead exceeds budget
- **WHEN** system instructions and tool definitions alone consume the configured budget
- **THEN** the provider fails with a bounded local context-budget error and does not send an oversized upstream request

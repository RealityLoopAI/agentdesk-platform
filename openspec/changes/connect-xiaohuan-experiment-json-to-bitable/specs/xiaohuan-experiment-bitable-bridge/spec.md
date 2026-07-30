## ADDED Requirements

### Requirement: Start only with an explicit trusted deployment binding
The Bridge SHALL default to disabled and SHALL require explicit continuous-upload consent, an operator-configured canonical user, a Feishu P2P platform route, an approved logical Bitable resource and a valid field mapping before opening the audio listener.

#### Scenario: Required binding is incomplete
- **WHEN** the Bridge is enabled but any required consent, identity, route, resource or mapping value is missing or invalid
- **THEN** it fails before binding UDP, uploading audio or creating an Agent turn

#### Scenario: Group target is configured
- **WHEN** the configured Feishu destination is not a P2P route
- **THEN** the Bridge rejects the configuration

### Requirement: Reuse the bounded Xiaohuan audio pipeline
The Bridge SHALL reuse the continuous RTP/VAD/WAV/Ark pipeline and SHALL accept only validated `experiment-audio.v1` results for downstream delivery.

#### Scenario: Valid utterance completes
- **WHEN** VAD completes one valid utterance and Ark returns a Schema-valid result
- **THEN** the Bridge creates exactly one bounded downstream draft for that capture while audio listening continues

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

#### Scenario: Selector is ambiguous or missing in structured output
- **WHEN** an action or measurement selector finds zero matches, multiple matches, an empty target or a null value
- **THEN** the Bridge omits that preliminary field, preserves the mapping and source evidence for the Worker, and does not itself choose, translate, convert or infer a value

#### Scenario: Empty collection was extracted
- **WHEN** a mapped string collection is empty but the transcript may still contain the requested fact
- **THEN** the Bridge omits the empty preliminary value while preserving the mapping and transcript for bounded downstream normalization

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
The Bridge SHALL stop FFmpeg on teardown, drain already accepted bounded model work, clean program-created temporary WAV files by default and stop producing new Agent turns.

#### Scenario: Host shuts down
- **WHEN** Channel teardown occurs during idle or active capture
- **THEN** the audio child process terminates, eligible accepted work is bounded and drained, temporary audio is cleaned and no later turn is emitted

### Requirement: Acknowledge a locally completed utterance through optional device TTS
The Bridge SHALL optionally acknowledge an utterance after its complete WAV has been written and validated locally and before Ark processing completes, through the operator-configured Xiaohuan TTS HTTP endpoint using a run-and-capture-bound stable request ID, and SHALL treat the acknowledgement as auxiliary rather than transcription, authorization or write state.

#### Scenario: Complete WAV is locally ready
- **WHEN** VAD completes one utterance and its WAV passes local validation
- **THEN** the Bridge asynchronously submits `text="收到"` with `request_id="xiaohuan-received-<receiptKey>"` before waiting for Ark transcription or structured output

#### Scenario: WAV callback is repeated
- **WHEN** the same capture callback is observed more than once in one Bridge process
- **THEN** every attempt uses the same hardware request ID so the device can deduplicate it

#### Scenario: Hardware acknowledgement fails
- **WHEN** the TTS endpoint times out, rejects the request, returns a non-202 status, a mismatched request ID or an invalid response
- **THEN** the Bridge records a content-safe typed error without changing confirmation status, retrying the card, calling Gateway, or writing Bitable

#### Scenario: TTS acknowledgement is disabled
- **WHEN** the Bridge runs without explicit TTS acknowledgement enablement and a valid operator endpoint
- **THEN** audio ingestion and the existing confirmation workflow behave exactly as before and no TTS HTTP request is made

### Requirement: Serialize drafts across confirmation lifecycles
The Bridge SHALL allow at most one active Agent draft awaiting confirmation resolution, SHALL queue later structured results in bounded FIFO order, and SHALL release the next draft only after the active Host confirmation is approved, rejected, expired or failed.

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
- **WHEN** an active draft has not bound to and resolved through a confirmation within the confirmation lifetime bound
- **THEN** the Bridge safely releases it and continues with the next queued draft without treating the timeout as approval

#### Scenario: Draft queue reaches its bound
- **WHEN** another structured result arrives while the bounded pending draft queue is full
- **THEN** the Bridge reports a content-safe overflow error and creates no Agent turn for that result

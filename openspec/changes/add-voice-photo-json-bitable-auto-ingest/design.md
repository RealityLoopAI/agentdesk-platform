## Context

`examples/voice-photos-feishu-monitor/` is currently a standalone operator
service that polls an OS-mounted SMB folder, validates new images, and sends
them directly through the Feishu chat image API. The new producer output is a
final JSON analysis. A qualifying result must create a record in the existing
test Bitable automatically.

Business writes cannot move into the standalone monitor: the Backend Gateway
is the only sanctioned business-data path, and the Host-established identity,
container-to-Host signing proxy, authorization, and audit chain are
load-bearing. The existing Xiaohuan Bitable bridge demonstrates trusted Host
ingress, but its human confirmation requirement intentionally prevents
unattended writes.

## Goals / Non-Goals

**Goals:**

- Detect only post-baseline stable JSON generations in the existing read-only
  `voice_photos` mount.
- Validate the supplied final-analysis format deterministically, without an LLM.
- Select the target table and exact fields from a closed scene-route map before
  Agent ingress.
- Create and read back one Bitable record automatically through Host and
  Gateway, without a confirmation card.
- Make the unattended exception unforgeable by ordinary chat text and fail
  closed if any field, resource, identity, schema, or proof changes.
- Preserve the existing image notification path and its durable restart,
  outage, retry, bounded-resource, and observability behavior while adding an
  independently durable JSON path.

**Non-Goals:**

- Direct Bitable or Gateway execution from the filesystem process.
- General unattended Bitable writes, updates, deletes, batch operations,
  unknown scenes, or arbitrary resources.
- OCR, model-based JSON repair, fuzzy scene/field matching, or unit conversion.
  Existing image upload and notification remain in scope and unchanged.
- Processing JSON that existed before the new monitor database reached ready.

## Decisions

### 1. Add an ingress-only Host channel beside the image sender

The JSON path becomes an ingress-only ChannelAdapter. Its `setup` starts a
serialized JSON polling lifecycle; qualified results enter
`ChannelSetup.onInboundEvent` using an operator-configured canonical user and a
private machine channel. A topology reconciler wires that channel directly to
the dedicated Bitable worker.

This preserves the Host identity chain and keeps the monitor away from Gateway
credentials. A custom machine channel avoids adding synthetic JSON turns and
success replies to the user's ordinary Feishu conversation.

The original image monitor remains a second Host-managed adapter. It retains
its image scanner, SQLite state, fixed Feishu P2P target, retry limits, and
baseline. The two services share only the read-only root and common polling
defaults; neither consumes or mutates the other's state.

Alternative: call Feishu Bitable or Gateway directly. Rejected because an
external process would either hold physical credentials or assert a human
identity outside the Host trust chain.

### 2. Keep the polling/state mechanics but create a versioned JSON mode

The scanner accepts only `.json`, retains containment/symlink protections and
stable pre/post metadata checks, and uses a lower configurable JSON byte limit.
The SQLite database records a mode/version marker and uses path plus SHA-256
digest as the immutable event generation.

The deployment uses a new JSON state path. Reusing an image-monitor database
with another mode fails startup rather than interpreting the old baseline as a
JSON baseline.

### 3. Validate a closed final-analysis schema before Agent ingress

A deterministic parser rejects unknown structural types, invalid UTF-8,
non-finite numbers, confidence values outside `[0,1]`, empty required text,
unclear/no-reading summaries, and an adopted frame that is absent or
contradicts the final result. Numeric strings use a closed decimal grammar;
scientific notation, localized separators, and implicit coercion are rejected.

Unqualified but structurally valid results are recorded as skipped for that
digest. Malformed files record a bounded failure. If the producer replaces the
file, the new digest is evaluated independently.

### 4. Route by exact scene and construct exact fields before the model boundary

The adapter selects one closed operator-configured route. The confirmed
deployment maps:

- `场景一` to `voice.photo.scene1`, numeric `转速`, unit `rpm`;
- `场景二` to `voice.photo.scene2`, numeric `无水氯化铜（克）`, unit `g`/`克`;
- `环境` to `voice.photo.environment`, textual `温度`, unit `℃`/`°C`/`C`.

Every route owns its logical resource, measurement field, accepted units,
value type, and static fields. Unknown scenes fail closed rather than falling
back. The dedicated Worker must obtain live Field List and require all routed
fields with compatible types; it may not drop, rename, add, or normalize them.

### 5. Bind the unattended exception to the exact Create input

The adapter derives an idempotency key:

`voice-photo-json-v1:<digest>:<hmac>`

The HMAC covers a canonical object containing the version, digest, logical
resource, and exact fields. The machine-ingest key exists only in the Host
adapter configuration and the Gateway resource policy; it is not mounted into
the Agent container.

The reference Bitable Gateway extends its operator resource configuration with
an optional machine-ingest policy. For the dedicated resource it verifies the
key format and HMAC before accepting a policy-only Create. Normal Create,
Update, Delete, confirmation, writer, agent-group, schema, and idempotency
checks remain unchanged. Replaying an observed proof can only replay the exact
same idempotent input.

Alternative: rely on the Worker prompt to recognize the envelope. Rejected
because ordinary chat text can imitate JSON and a model can change fields.

### 6. Use a dedicated Worker instruction for exact automatic execution

The machine channel is wired directly to the existing Bitable Worker group.
Its group-specific prompt recognizes only the versioned machine envelope and
requires:

`describe -> field.list -> authorize -> execute -> record.get`

It skips `gateway_request_confirmation` only for this envelope and its
machine-proof idempotency key. Gateway verification is the deterministic
enforcement boundary; prompt compliance alone grants nothing. Read-back
verification uses the live schema: Feishu Number fields may round-trip as
canonical decimal strings and compare by exact finite decimal value, while
non-Number fields remain strict.

### 7. Preserve durable retries at the machine-event boundary

SQLite transitions become:

`observed -> ready -> submitted -> verified`

Transient Host/Agent failures requeue with capped backoff. The Gateway stable
idempotency key protects crash/retry after commit. Terminal validation,
authorization, schema, and proof failures do not block later events. Agent turn
terminal events correlate completion back to the source message; verification
success is reported by a bounded machine result envelope and marks the event
verified.

## Risks / Trade-offs

- [Agent reports success without creating/verifying] → Mark success only from a
  closed machine result carrying the expected fingerprint and Record ID; retain
  Gateway idempotency/audit as final evidence.
- [Machine HMAC key leaks] → Keep it out of container config, prompts, logs, and
  tracked files; rotate the key and stop the adapter on suspected exposure.
- [Copied valid envelope is replayed] → The proof binds exact fields/resource
  and the Gateway idempotency store returns the first committed result.
- [Table Schema changes] → Require live Field List and exact target presence;
  fail before Create rather than writing a partial record.
- [Old state suppresses or replays JSON] → Require a versioned mode marker and
  a separate JSON state database path.
- [LLM or provider is unavailable] → Retain the event and retry within bounds;
  never add a direct fallback write.
- [First baseline contains a desired JSON] → It is intentionally ignored; an
  operator must test with a new post-ready generation.

## Migration Plan

1. Add JSON parser/scanner/state tests and the ingress-only adapter without
   changing the current image monitor implementation.
2. Add the dedicated topology/prompt and machine-ingest Gateway policy behind
   explicit disabled-by-default configuration.
3. Configure a new external SQLite path, canonical user, closed scene routes,
   their logical resources and exact fields, and a freshly generated shared
   machine HMAC key.
4. Start the Host with both adapters, wait for both baseline-ready events, and
   verify existing images/JSON create no messages or records.
5. Add one new image and one uniquely named qualifying JSON. Verify the image
   reaches the fixed Feishu private chat, the JSON produces one Create plus
   Record Get, and no confirmation card appears.
6. Roll back JSON ingestion by disabling only the JSON adapter and machine
   policy. Retain both state databases; image notification continues.

## Open Questions

None. The confirmed deployment mode is unattended Create for the dedicated
scene resources; all other Bitable writes retain their existing policies.

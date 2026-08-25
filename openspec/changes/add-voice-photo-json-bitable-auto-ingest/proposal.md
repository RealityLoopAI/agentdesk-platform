## Why

The existing `voice_photos` monitor sends newly completed images to a fixed
Feishu private chat, but the producer now emits a final JSON analysis beside
those images. Operators need qualifying, complete JSON results to create
idempotent records in the approved test Bitable automatically in addition to
the existing image notification, without a per-record confirmation card.

## What Changes

- Add stable, bounded `.json` ingestion alongside the existing image monitor
  under the same read-only mounted folder.
- Preserve the durable first-run baseline: all JSON files present before the
  monitor reports ready are ignored, and only later content generations are
  eligible.
- Validate the closed analysis shape and accept a result only when its final
  summary says the image is `清晰`, a reading exists, and all required final
  fields and the adopted frame are internally consistent.
- Select a closed operator-configured route from the exact JSON `场景`, then
  build a deterministic target-locked Bitable draft for that route. Unknown
  scenes and incompatible units fail closed before Agent ingress.
- Route accepted machine events through a dedicated trusted Host ingress and
  Backend Gateway policy to an operator-approved logical test resource.
  Successful events create and verify one record automatically, without a
  user-confirmation card.
- Keep physical Bitable identifiers and credentials in the Gateway, keep the
  SMB root read-only, and use the JSON content digest as the stable business
  idempotency source.
- Preserve the existing post-baseline image upload/send behavior, durable image
  state, retry policy, and fixed RealityLoop private-chat destination.
- Run image notification and JSON ingestion as independent Host-managed
  services with separate state databases and failure isolation.
- Add failure isolation, retry/restart behavior, schema-drift checks, operator
  documentation, focused tests, and an ADR for unattended machine ingestion.

## Capabilities

### New Capabilities

- `voice-photo-json-bitable-auto-ingest`: Durable JSON polling, qualification,
  trusted machine ingress, and automatic idempotent creation in a fixed logical
  Bitable scene resource.

### Modified Capabilities

None.

## Impact

- Updates the optional implementation under
  `examples/voice-photos-feishu-monitor/` and its deployment configuration.
- Adds an operator-specific Host channel/worker path for trusted JSON events;
  the generic channel and Backend Gateway public contracts remain unchanged.
- Reuses `feishu.bitable.field.list`, `feishu.bitable.record.create`, and
  `feishu.bitable.record.get` through the existing Gateway.
- Requires a fixed canonical user, fixed P2P route, logical resource alias,
  closed scene/resource/field mapping, and operator policies permitting
  unattended Create only for those dedicated scene resources.
- Does not write AgentDesk central/session databases from the monitor, does not
  expose SMB credentials, and does not write to the NAS.

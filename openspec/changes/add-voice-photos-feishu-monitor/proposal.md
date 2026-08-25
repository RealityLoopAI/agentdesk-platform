## Why

Images written asynchronously below the operator-mounted `voice_photos` SMB
directory are currently invisible until someone inspects the share manually.
The RealityLoop operator needs a reliable, unattended notification that sends
each newly completed image to one explicitly configured Feishu bot private
conversation without waking an Agent or running an LLM turn.

## What Changes

- Add an opt-in, operator-owned `voice_photos` monitor that recursively polls a
  configured host filesystem root corresponding to the read-only SMB share.
- Establish a durable first-run baseline and ignore every image present before
  the monitor reports ready; only subsequently discovered images are eligible
  for notification.
- Require a candidate image to remain unchanged across consecutive polls before
  reading it, so partially written producer output is never intentionally sent.
- Persist discovery, readiness, delivery, retry, and terminal-failure state in
  a monitor-owned SQLite database so restarts and temporary SMB outages do not
  replay historical images.
- Deliver each completed image to one explicitly configured, verified Feishu
  private-message target using the existing RealityLoop bot credentials,
  stable idempotency identifiers, bounded retries, and rate limiting.
- Reuse or extract the existing Feishu image-upload/send primitives rather than
  routing notifications through Agent sessions, skills, or container outboxes.
- Add operator documentation, metrics/logging, deterministic filesystem and
  Feishu API tests, and an approved real-SMB/private-chat smoke-test procedure.
- Keep the SMB root read-only and keep SMB credentials, the fixed Feishu target,
  and RealityLoop-specific configuration out of the generic platform defaults.

## Capabilities

### New Capabilities

- `voice-photo-feishu-notification`: Durable recursive polling, first-run
  baseline behavior, completed-image detection, and reliable delivery of new
  voice-photo images to a configured Feishu private conversation.

### Modified Capabilities

None.

## Impact

- Adds an optional operator service and tests under
  `examples/voice-photos-feishu-monitor/`.
- May extract a small provider-specific outbound image client from
  `src/channels/feishu.ts` so the existing adapter and the optional monitor use
  the same Feishu token, upload, target-normalization, timeout, and message-send
  behavior without changing the `ChannelAdapter` contract.
- Adds a monitor-owned SQLite schema; it does not write central AgentDesk
  tables or any Session `outbound.db`.
- Requires the operator to mount
  `smb://192.168.66.149/video_database/voice_photos` read-only on the host and
  configure its local mount path plus a `feishu:p2p:ou_*` target through
  environment variables.
- Introduces no Agent skill, Agent wake-up, Backend Gateway operation,
  VisionCortex dependency, container mount, SMB client library, or NAS write.

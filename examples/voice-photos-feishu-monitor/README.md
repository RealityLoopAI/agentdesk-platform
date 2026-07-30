# Voice Photos → Feishu Monitor

This optional operator service recursively polls an OS-mounted
`voice_photos` SMB directory and sends each completed image that appears after
the first durable baseline to one configured RealityLoop bot private
conversation.

It is intentionally separate from Agent execution:

- no inbound chat or synthetic Agent turn;
- no LLM, skill, Backend Gateway, Conversation Lane subscription, or Session
  `messages_out` write;
- no SMB credential in Node configuration;
- no write, delete, rename, lock, or acknowledgement in the monitored tree.

## 1. Mount the SMB share read-only

The service accepts a local absolute path, not an `smb://` URL. Keep SMB
credentials in the operating-system credential facility.

macOS example (the command prompts or uses Keychain; do not put a password in
shell history):

```bash
sudo mkdir -p /Volumes/video_database
mount_smbfs -o ro //SMB_USER@192.168.66.149/video_database /Volumes/video_database
```

Linux example using a root-readable credentials file:

```bash
sudo mkdir -p /mnt/video_database
sudo mount -t cifs //192.168.66.149/video_database /mnt/video_database \
  -o ro,credentials=/root/.smb-video-database,vers=3.0
```

Confirm that the local monitor root is readable and not writable by the
service account. The expected root is:

```text
/Volumes/video_database/voice_photos
```

or the corresponding Linux path.

## 2. Configure

Copy `.env.example` to an operator-owned secret file outside version control.
Required values are:

- `VOICE_PHOTOS_ROOT`: local absolute mounted directory.
- `VOICE_PHOTOS_STATE_DB`: writable local SQLite path outside the SMB root.
- `VOICE_PHOTOS_FEISHU_TARGET`: exactly one `feishu:p2p:ou_*` address.
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`: the existing RealityLoop bot app.

The monitor rejects SMB URLs, relative paths, state files inside the monitored
root, group targets, malformed Open IDs, missing credentials, and unsafe
numeric limits before scanning or contacting Feishu.

Recommended production defaults:

```env
VOICE_PHOTOS_POLL_INTERVAL_MS=5000
VOICE_PHOTOS_STABILITY_SCANS=2
VOICE_PHOTOS_MAX_IMAGE_BYTES=20971520
VOICE_PHOTOS_MAX_CANDIDATES_PER_SCAN=100000
VOICE_PHOTOS_DELIVERY_CONCURRENCY=1
VOICE_PHOTOS_MAX_SENDS_PER_MINUTE=30
```

Protect the state directory because it contains filenames, event IDs, delivery
status, and Feishu message IDs:

```bash
install -d -m 0700 /absolute/writable/path/voice-photo-monitor
```

## 3. Start and establish the baseline

Load the secret environment with the operator's process manager, then run:

```bash
pnpm voice-photos:monitor
```

On the first successful complete scan, every existing supported image is
stored as historical baseline state and **none is sent**. Notification
semantics start only after this structured log appears:

```json
{ "level": "info", "event": "voice_photo_monitor_ready", "baselineCount": 123 }
```

An image visible during that initial scan and included in the committed
snapshot is historical. If the share is unavailable or the bounded scan fails,
the baseline does not partially commit and the service stays unready.

Keep the SQLite database across restarts. Removing it is an explicit reset and
causes a new no-send baseline. A normal restart reuses the old baseline,
delivery states, and stable Feishu request UUIDs.

## Detection and delivery behavior

- Polls recursively and serially; correctness does not depend on `fs.watch`.
- Supports `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, and `.bmp`.
- Ignores hidden, temporary, symlinked, non-regular, and unsupported entries.
- Requires unchanged identity, size, modification time, and change time across
  at least two successful scans.
- Rechecks metadata before and after a bounded read and validates image magic
  bytes.
- Sends each image as a separate Feishu image message.
- Stores path/content event identity before sending and reuses one Feishu
  request UUID across retries.
- Applies persistent retry scheduling, single-owner leases, concurrency and
  per-minute send limits.
- Treats an SMB outage as unavailable state; it does not reset the baseline,
  infer deletions, or replay historical images after reconnect.

A file created and removed entirely between two polls cannot be detected. The
producer must retain completed files.

## Health and diagnosis

Important structured events:

- `voice_photo_monitor_ready`
- `voice_photo_scan_complete`
- `voice_photo_scan_unavailable`
- `voice_photo_validation_failed`
- `voice_photo_delivery_retry`
- `voice_photo_delivered`
- `voice_photo_delivery_terminal`

Logs omit credentials, tokens, image bytes, the concrete configured Open ID,
and unbounded provider response bodies. Queue depth in
`voice_photo_scan_complete` should normally return to zero.

Common failures:

- `SMB_UNAVAILABLE`: verify the OS mount and permissions; do not delete state.
- `SCAN_LIMIT_EXCEEDED`: inspect root size and deliberately raise the candidate
  bound if the tree is trusted.
- `INVALID_IMAGE_SIGNATURE`: producer created an unsupported or malformed file.
- `IMAGE_TOO_LARGE`: raise the byte limit only after checking Feishu and memory
  constraints.
- `FEISHU_*_TIMEOUT` / throttling: retained and retried with bounded backoff.
- ownership error: another process is using the same state database.

## Safe smoke test

1. Start the service with a fresh local state database and the real read-only
   mount.
2. Wait for `voice_photo_monitor_ready`; verify the historical tree caused zero
   `voice_photo_delivered` events and no private-chat images.
3. Ask the producer or an approved fixture writer—not the monitor process—to
   create one uniquely named valid image after readiness. Keep the monitor's
   mount read-only.
4. Wait for two polls and verify exactly one image in the configured private
   conversation plus one `voice_photo_delivered` event.
5. Restart with the same state database and verify the image is not replayed.

Do not edit or delete producer-owned historical files for this test.

## Shutdown and rollback

`SIGINT` and `SIGTERM` stop new scans, abort the poll wait, release the
single-owner lease, and close SQLite. The process manager should allow at least
`VOICE_PHOTOS_SHUTDOWN_DEADLINE_MS`.

Rollback is to stop and disable this optional service. Retain the SQLite
database so a later re-enable does not replay history. AgentDesk host routing,
containers, Gateways, and conversation databases require no rollback.

# Voice-photo JSON → Feishu Bitable

This operator-specific example runs two independent pollers over the read-only
mounted form of `smb://192.168.66.149/video_database/voice_photos`:

- the original image monitor continues pushing stable post-baseline images to
  the configured RealityLoop Feishu private chat;
- the JSON monitor validates stable post-baseline analysis files and
  automatically writes qualifying results to Bitable.

Each path keeps its own SQLite baseline, retries, and completion state. A
failure in one path does not stop the other.

## Qualification and mapping

A file qualifies only when the top-level result is `画面状态=清晰`,
`有读数=true`, required fields and confidences are valid, and `采用图片`
references a clear frame whose numeric value and unit match the final result.
Its exact scene must exist in `VOICE_PHOTOS_SCENE_ROUTES_JSON`, and its unit
must be accepted by that route.

| JSON scene | Logical resource          | Target fields                                                                      |
| ---------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `场景一`   | `voice.photo.scene1`      | `批次=测试版本`, `转速=<最终数值>`; unit `rpm`                                     |
| `场景二`   | `voice.photo.scene2`      | `批次=测试版本`, `设备仪器=链路测试`, `无水氯化铜（克）=<最终数值>`; unit `g`/`克` |
| `环境`     | `voice.photo.environment` | `批次=测试版本`, `温度="<最终数值> <单位>"`                                        |

The current scene-two table exposes `链路测试` as its compatible
`设备仪器` single-select option. If operators add an exact `测试版本` option,
they may change only that route's static value after verifying the live schema.
Unknown scenes never fall back to another table.

Qualified JSON data is written automatically; no Feishu confirmation card is
created. The Host constructs fields and a content/resource/fields-bound HMAC.
The Gateway verifies it. The JSON path has no physical Bitable IDs or direct
Gateway/Bitable client. The image path retains the existing Feishu credentials
only for upload and delivery to its fixed P2P target.

## Deployment

1. Mount the SMB directory read-only and load `.env.example` from an
   operator-owned secret environment.
2. Create the dedicated machine route and group-specific Worker instructions:

   ```bash
   pnpm voice-photos:configure -- \
     --user-id <existing-canonical-user-id> \
     --platform-id voice-photo-json:realityloop
   ```

   The reconciler also adds that canonical user as a member of only this
   dedicated Worker group and copies the Provider/Backend Gateway connection
   from the existing `agentdesk-bitable-worker`. Override
   `--gateway-template-folder` only when the deployment uses another approved
   Gateway-enabled Worker template.

3. Create one dedicated logical resource alias for every scene table in
   `FEISHU_BITABLE_RESOURCES_JSON`. Keep the normal writer policy, allow Field
   List, Record Create and Record Get, then add this policy to every alias:

   ```json
   {
     "machineIngestRequired": true,
     "machineIngestHmacKey": "<same secret as VOICE_PHOTOS_MACHINE_INGEST_HMAC_KEY>"
   }
   ```

4. Keep `VOICE_PHOTOS_IMAGE_MONITOR_ENABLED=true`, set
   `VOICE_PHOTOS_JSON_MONITOR_ENABLED=true`, configure the closed
   `VOICE_PHOTOS_SCENE_ROUTES_JSON` mapping, and provide two different state
   paths:

   - `VOICE_PHOTOS_STATE_DB` for images;
   - `VOICE_PHOTOS_JSON_STATE_DB` for JSON ingestion.

   Then run:

   ```bash
   pnpm voice-photos:monitor
   ```

Wait for both `voice_photo_monitor_ready` and
`voice_photo_json_baseline_complete`; neither baseline emits output. Then add a
new image and a new valid JSON. Verify one image reaches the fixed RealityLoop
private chat, `voice_photo_json_submitted` appears, the Gateway audit contains
the Create/Get, a real Record ID exists, and no confirmation card appears.
Each JSON digest gets an isolated thread/session, so an earlier Worker response
cannot become context for a later file.

## Rotation and rollback

For key rotation, stop the Host, update both machine-key locations, then
restart. Old proofs fail closed. To disable only JSON ingestion, set
`VOICE_PHOTOS_JSON_MONITOR_ENABLED=false`; image notification remains enabled.
The NAS is never mutated. Retaining both SQLite files preserves independent
deduplication; replacing either DB deliberately establishes a fresh baseline
for only that path.

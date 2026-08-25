# Verification

Date: 2026-07-30

## Automated evidence

| Check | Result | Evidence |
|---|---|---|
| Example TypeScript | Pass | `pnpm exec tsc -p examples/xiaohuan-doubao-audio/tsconfig.json --noEmit` |
| All audio feature tests | Pass | 3 files, 71 tests |
| Platform TypeScript | Pass | `pnpm typecheck` |
| Security and capability guards | Pass | 2 files, 16 tests |
| OpenSpec strict validation | Pass | `openspec validate add-xiaohuan-vad-listening-service --strict` |
| Patch whitespace | Pass | `git diff --check` |

Tests cover PCM dBFS, arbitrary chunk framing, pre-roll, consecutive start
frames, trailing silence, short impulse discard, maximum duration, signal
flush, WAV encoding, bounded peak normalization, configuration, continuous
no-shell FFmpeg arguments, first-audio timeout, unexpected exit, intentional
FFmpeg code 255, temporary cleanup, capture-only isolation, slow model
processing while capture continues, strict serialization, per-utterance failure
isolation and queue overflow.

## Offline real-audio calibration

The previously operator-confirmed Xiaohuan sentence was decoded to raw PCM and
replayed through the default VAD without external upload. At the calibrated
`-43 dBFS` threshold it produced exactly one utterance:

- completion reason: trailing silence;
- total bounded duration: 8600 ms;
- above-threshold voiced duration: 6280 ms.

This confirms pre-roll and trailing silence preserved the known complete
sentence as one boundary.

## Live capture-only service

The service was started before the operator spoke and reported
`xiaohuan_vad_ready`. It kept one FFmpeg RTP/Opus connection open and
automatically produced two WAV files before stopping at
`--max-utterances 2`:

- utterance 1: 2460 ms total, 660 ms voiced;
- utterance 2: 3080 ms total, 1440 ms voiced.

No model credentials were loaded and neither utterance was uploaded. The first
live attempt at `-40 dBFS` exposed low-volume fragmentation and an intentional
FFmpeg SIGINT code-255 classification issue. The stop classification was fixed,
the threshold was recalibrated to `-43 dBFS`, and a regression test was added.

The live samples also showed low raw peaks, so the service now applies bounded
peak normalization before writing/processing: target `-3 dBFS`, maximum gain
30 dB. The source utterance remains bounded by VAD before normalization.

## Live authorized process-mode service

After the operator confirmed the capture-only boundaries, they explicitly
authorized one bounded process-mode run with `--max-utterances 2`. The service
reported `xiaohuan_vad_ready`, detected two utterances, normalized and processed
them serially, then stopped automatically:

- utterance 1: 10300 ms total, 4100 ms voiced, 18.6 dB normalization gain,
  Ark latency 12108 ms, request ID
  `021785392244352ed9c07a18069cfb59ad66daf7e7bd921b039af`;
- utterance 2: 3520 ms total, 1420 ms voiced, 21.9 dB normalization gain,
  Ark latency 13157 ms, request ID
  `021785392256187ed9c07a18069cfb59ad66daf7e7bd921432733`.

Both provider calls returned a transcript and valid `experiment-audio.v1`
JSON. The captured speech was ordinary live conversation rather than the
suggested experiment statements, so both structured experiment objects
correctly contained no extracted facts. The final service summary was:
2 accepted, 2 succeeded, 0 failed and 0 discarded.

No audio, credential, transcript, Base64 payload, prompt or raw provider
response is stored in this verification document.

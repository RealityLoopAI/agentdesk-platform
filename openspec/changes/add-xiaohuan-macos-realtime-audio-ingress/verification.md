# Verification

Date: 2026-07-30

## Automated evidence

| Check | Result | Evidence |
|---|---|---|
| Example TypeScript | Pass | `pnpm exec tsc -p examples/xiaohuan-doubao-audio/tsconfig.json --noEmit` |
| File and realtime feature tests | Pass | 2 files, 48 tests |
| Platform TypeScript | Pass | `pnpm typecheck` |
| Security and capability guards | Pass | 2 files, 16 tests |
| OpenSpec strict validation | Pass | `openspec validate add-xiaohuan-macos-realtime-audio-ingress --strict` |
| Patch whitespace | Pass | `git diff --check` |

The realtime tests use a process-compatible FFmpeg test double and real PCM WAV
validation. They cover argument and SDP rejection, the fixed protocol
whitelist, no-shell spawn, finalized and final segments, capture-only behavior,
explicit upload acknowledgement, serial processing, empty audio, no segment,
first-segment timeout, queue overflow, abnormal FFmpeg exit, signal forwarding,
temporary cleanup and bounded safe logs.

## Local macOS environment

- macOS 26.3, build 25D125.
- Active local address from `ifconfig`: `192.168.66.113`.
- Bundled SDP: audio UDP 50020, RTP payload 96, Opus 48 kHz.
- FFmpeg 8.1 supports file, UDP and RTP.
- macOS Application Firewall reports disabled.
- No process occupied UDP 50020 before the probe.

## Hardware probe

Two capture-only probes were performed without Ark configuration or external
upload:

1. Direct FFmpeg with the hardware-provided macOS SDP started successfully but
   received zero media frames before demux timeout. It produced only a 110-byte
   empty WAV header; that file was not accepted as audio.
2. The implemented realtime CLI listened with a 3-second first-segment timeout,
   then returned typed `realtime/NO_AUDIO_RECEIVED`. It emitted no stdout
   segment and cleaned its program-created temporary directory.

The probes demonstrate correct local startup and fail-closed handling, but do
not prove that the hardware is currently sending to this Mac. No audio,
credential, transcript, Base64 payload, prompt or raw provider response is
stored here.

## Real FFmpeg loopback integration

To separate receiver software behavior from the external hardware state, a
second FFmpeg process sent a generated non-speech Opus RTP stream to
`127.0.0.1:50021` using payload 96 and the same 48 kHz SDP mapping.

The realtime CLI received the packets through its real SDP/UDP/RTP/Opus path
and produced one valid segment:

- 64118 bytes;
- 2000 ms;
- PCM signed 16-bit little-endian;
- 16 kHz, mono;
- 64000 bytes of audio data.

This proves the implemented macOS receiver, FFmpeg arguments, segment muxer,
completed-file detection and WAV validation work end to end. It does not count
as Xiaohuan hardware evidence because the source was a local generated signal.

## Remaining real hardware evidence

The hardware sender was switched to `192.168.66.113:50020`, replacing the old
Windows destination `192.168.66.32:50020`. Multiple capture-only runs then
received real Xiaohuan RTP segments. The latest two were approximately 15
seconds, 16 kHz, mono PCM:

- the first was 479470 bytes with a `-35.1 dB` peak;
- the second was 478830 bytes with a `-30.7 dB` peak and multiple locally
  detected activity intervals.

This proves the hardware target, macOS UDP ingress, RTP/Opus decode and PCM
segmentation path.

The first segment was explicitly authorized for external upload. Ark accepted
the request but returned an empty transcript, including after local loudness
normalization. A content-free validator diagnostic identified
`empty_transcript`; no raw response or transcript was logged.

A final explicitly authorized hardware run captured 19980 ms and 639470 bytes
of PCM audio. Its raw peak was `-13.0 dB`; local loudness normalization produced
a `-3.0 dB` peak. Ark returned a locally valid `experiment-audio.v1` in 10337
ms with safe request ID
`0217853901519125bab3eccb0e59942edbe17ea88d60bc6b10766`.

The non-empty transcript and structured output contained the final
white-precipitate observation, but omitted the earlier sample, temperature,
action and duration facts. Timing analysis showed a long gap after the spoken
wake phrase. The likely explanation is that saying the device wake phrase
triggered local device behavior that interrupted or suppressed USB microphone
RTP capture. This is an inference from the audio activity pattern; the next
quality test should omit the wake phrase and speak only the experiment sentence.

A final synchronized test corrected the operator timing: the receiver was
started first, `xiaohuan_realtime_started` was observed, and only then was the
operator told to speak without a wake phrase. The 19980 ms hardware segment had
a `-27.6 dB` mean and `-6.1 dB` peak, and the operator confirmed the retained
audio before explicitly authorizing upload.

Ark returned a valid `experiment-audio.v1` in 21515 ms with safe request ID
`021785390763469edfe17761d7699bd2e54408390fbabd1bbd81f`. Human comparison
confirmed the transcript matched the complete spoken sentence. The structured
result correctly captured the sample number, 27-degree temperature, stirring
action, eight-minute duration and blue-precipitate observation. No complete
transcript or raw response is stored in this verification artifact.

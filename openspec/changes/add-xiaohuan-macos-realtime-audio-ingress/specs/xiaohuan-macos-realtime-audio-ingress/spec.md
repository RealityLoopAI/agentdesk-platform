## ADDED Requirements

### Requirement: Validate macOS realtime ingress configuration
The receiver SHALL validate the SDP, FFmpeg executable, segment duration, queue bound, segment bound and output location before listening, and SHALL reject an SDP that does not declare RTP audio payload 96 as Opus at 48 kHz.

#### Scenario: Valid Xiaohuan SDP
- **WHEN** the operator supplies a bounded regular SDP file declaring `m=audio 50020 RTP/AVP 96` and `a=rtpmap:96 opus/48000`
- **THEN** the receiver accepts the configuration and may start FFmpeg

#### Scenario: Invalid or missing SDP
- **WHEN** the SDP is missing, oversized, not a regular file or lacks the expected media mapping
- **THEN** the receiver fails before opening a UDP listener or creating an external request

### Requirement: Receive RTP Opus into bounded PCM WAV segments
The receiver SHALL start FFmpeg without a shell, restrict input protocols to file, UDP and RTP, and decode completed segments as 16 kHz mono 16-bit PCM WAV files whose duration does not exceed the configured WAV limit.

#### Scenario: Media packets arrive
- **WHEN** valid Xiaohuan RTP/Opus packets arrive at the address and port declared by the SDP
- **THEN** the receiver emits sequential completed PCM WAV segments accepted by the existing WAV validator

#### Scenario: No media packets arrive
- **WHEN** no valid audio segment completes before the first-segment timeout
- **THEN** the receiver stops FFmpeg and reports `NO_AUDIO_RECEIVED` without treating an empty WAV header as success

### Requirement: Process only finalized segments
The receiver SHALL not submit a segment while FFmpeg can still be writing it, and SHALL validate every finalized segment using the existing bounded WAV loader before publishing or processing it.

#### Scenario: Next segment opens
- **WHEN** FFmpeg opens segment N+1
- **THEN** segment N becomes eligible for validation and processing

#### Scenario: FFmpeg exits with a final segment
- **WHEN** FFmpeg exits cleanly after writing a non-empty final segment
- **THEN** the receiver validates and processes that final segment once

### Requirement: Default to local capture only
The receiver SHALL default to capture-only mode and SHALL require both an explicit process mode and explicit external-upload acknowledgement before sending any segment to Ark.

#### Scenario: Default invocation
- **WHEN** the operator starts realtime ingress without upload flags
- **THEN** audio remains local and no Ark configuration or network request is used

#### Scenario: Process without acknowledgement
- **WHEN** the operator requests process mode without acknowledging external upload
- **THEN** the receiver fails before listening or uploading

#### Scenario: Explicit processing
- **WHEN** the operator supplies process mode and external-upload acknowledgement
- **THEN** each finalized valid segment is serially passed to the existing single-stage WAV pipeline

### Requirement: Bound realtime resource use
The receiver SHALL serialize model processing, bound queued finalized segments, bound the number of segments per run, and stop with a typed error rather than silently dropping audio or growing without limit.

#### Scenario: Segment limit reached
- **WHEN** the configured number of completed segments has been captured
- **THEN** the receiver gracefully stops FFmpeg and completes outstanding allowed work

#### Scenario: Processing queue overflows
- **WHEN** finalized segments accumulate beyond the configured queue bound
- **THEN** the receiver stops capture and reports `QUEUE_OVERFLOW` without silently discarding a segment

### Requirement: Handle process lifecycle and privacy safely
The receiver SHALL terminate its FFmpeg child on SIGINT, SIGTERM, timeout or error; SHALL clean program-created temporary segments by default; and SHALL keep logs free of audio bytes, transcripts, prompts, credentials and raw provider responses.

#### Scenario: Operator interruption
- **WHEN** the operator sends SIGINT during capture
- **THEN** the receiver requests graceful FFmpeg termination, applies a bounded kill timeout and performs configured cleanup

#### Scenario: Temporary capture completes
- **WHEN** a run using the program-created temporary directory ends
- **THEN** the receiver deletes that directory unless segment retention was explicitly requested

### Requirement: Remain isolated from the platform core
The realtime ingress SHALL remain an operator-specific example and SHALL NOT write platform databases or directly invoke Backend Gateway, Feishu or Bitable operations.

#### Scenario: Capture or process run
- **WHEN** realtime ingress captures or processes audio
- **THEN** its only business output is local WAV segments and/or stdout `experiment-audio.v1` JSON Lines

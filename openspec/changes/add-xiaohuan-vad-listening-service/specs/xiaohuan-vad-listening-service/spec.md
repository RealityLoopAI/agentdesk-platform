## ADDED Requirements

### Requirement: Maintain a continuous Xiaohuan PCM stream
The service SHALL keep one supervised FFmpeg process receiving the configured SDP RTP/Opus stream and SHALL consume 16 kHz mono signed 16-bit PCM without fixed-duration restart gaps.

#### Scenario: Service becomes ready
- **WHEN** FFmpeg starts and the first PCM bytes arrive
- **THEN** the service reports a ready event and remains listening until signal or service-level failure

#### Scenario: No PCM arrives
- **WHEN** no PCM arrives before the configured first-audio timeout
- **THEN** the service terminates FFmpeg and reports `NO_AUDIO_RECEIVED`

### Requirement: Detect utterances with bounded energy VAD
The service SHALL compute dBFS on fixed PCM frames and SHALL use configurable speech threshold, consecutive start frames, pre-roll, trailing silence, minimum speech and maximum utterance duration to form bounded utterances.

#### Scenario: Valid sentence
- **WHEN** consecutive frames exceed the speech threshold and are followed by the configured trailing silence
- **THEN** the service emits one utterance containing pre-roll, speech and bounded trailing audio

#### Scenario: Short noise burst
- **WHEN** an above-threshold region does not meet the minimum speech duration
- **THEN** the service discards it without model processing

#### Scenario: Continuous sound
- **WHEN** speech state reaches the maximum utterance duration without trailing silence
- **THEN** the service force-completes a bounded utterance and returns to idle detection

### Requirement: Continue listening while utterances are processed
The service SHALL enqueue completed utterances without waiting for model processing and SHALL process the queue serially.

#### Scenario: Model is slower than capture
- **WHEN** a second utterance completes while the first is being processed
- **THEN** the second utterance remains in the bounded queue while PCM listening continues

#### Scenario: Queue bound is exceeded
- **WHEN** a completed utterance would exceed the configured queue bound
- **THEN** the service fails with `QUEUE_OVERFLOW` and SHALL NOT silently discard speech

### Requirement: Preserve explicit upload consent
The service SHALL default to local capture and SHALL require both process mode and external-upload acknowledgement before sending any detected utterance to Ark.

#### Scenario: Capture-only service
- **WHEN** the service starts without process flags
- **THEN** it does not load Ark credentials or issue external requests

#### Scenario: Authorized process service
- **WHEN** both process and external-upload acknowledgement are present
- **THEN** each valid completed utterance is submitted once to the existing WAV transcript plus JSON pipeline

### Requirement: Isolate per-utterance failures
The service SHALL log a content-free typed error for an individual utterance failure and SHALL continue listening and processing subsequent utterances unless a service-level resource or FFmpeg failure occurs.

#### Scenario: Ark rejects one utterance
- **WHEN** one queued utterance fails model processing
- **THEN** the error is reported without transcript or raw response and the next utterance remains eligible for processing

### Requirement: Shut down safely
The service SHALL stop FFmpeg on SIGINT or SIGTERM, SHALL finalize an in-progress utterance only if it meets the minimum duration, SHALL drain already accepted work, and SHALL clean program-created temporary audio by default.

#### Scenario: Signal during speech
- **WHEN** a shutdown signal arrives after minimum speech duration
- **THEN** the current bounded utterance is finalized once before queue drain and cleanup

#### Scenario: Signal while idle
- **WHEN** a shutdown signal arrives without active speech
- **THEN** the service stops without creating an empty WAV

### Requirement: Remain operator-specific
The service SHALL NOT write platform databases or directly invoke Backend Gateway, Feishu or Bitable operations.

#### Scenario: Long-running operation
- **WHEN** the VAD service captures or processes any number of utterances
- **THEN** outputs remain local WAV metadata and/or stdout `experiment-audio.v1` JSON Lines

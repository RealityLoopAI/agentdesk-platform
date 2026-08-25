# Verification

Date: 2026-07-30

## Outcome

The runnable example now performs one Ark Responses API call from a bounded PCM
WAV and returns a locally validated `experiment-audio.v1` value containing both
the Chinese transcript and structured experiment facts. The former Speech ASR
and second text-model clients are no longer part of the runtime.

The supplied local credential was used without printing or committing it. A
full live call succeeded with a generated, non-sensitive Chinese spoken WAV.
No approved Xiaohuan-captured WAV is currently available, so the two
device-specific smoke tasks remain open.

## Automated evidence

| Check | Result | Evidence |
|---|---|---|
| Example TypeScript | Pass | `pnpm exec tsc -p examples/xiaohuan-doubao-audio/tsconfig.json --noEmit` |
| Focused feature tests | Pass | `pnpm exec vitest run scripts/xiaohuan-doubao-audio.test.ts`: 1 file, 29 tests |
| Platform typecheck | Pass | `pnpm typecheck` |
| Security and capability guards | Pass | `scan-secrets.test.ts` and `example-capability-honesty.test.ts`: 2 files, 16 tests |
| Reference Gateway invariants | Pass | `pnpm test:reference-gateway`: 31 tests; rerun outside the managed listen sandbox after an expected `EPERM` |
| OpenSpec strict validation | Pass | `pnpm exec openspec validate add-xiaohuan-doubao-wav-experiment-extraction --strict` |
| Patch whitespace | Pass | `git diff --check` |

Focused tests cover:

- Ark-only, fail-closed configuration, including missing and placeholder Key or
  model values and HTTPS enforcement;
- bounded PCM WAV parsing and rejection of empty-data, corrupt, oversized and
  over-duration files;
- the single Responses request shape, exact WAV data URI placement, selected
  model, complete JSON Schema prompt and exactly-one-call behavior;
- Chinese transcript plus experiment JSON, fenced JSON parsing, capture ID and
  non-empty transcript checks;
- 401/403, 429, 5xx, request rejection, timeout, network, empty output,
  malformed JSON and invalid structure classification;
- safe logs and errors that exclude credentials, Authorization, Base64, prompt,
  transcript and raw provider responses;
- absence of persistence and absence of DB, Gateway, Feishu or Bitable
  dependencies in the example.

## Live Ark capability evidence

All live inputs were generated and non-sensitive. Credential values, Base64
audio, complete transcripts, prompts and raw provider responses are omitted.

1. A generated silent PCM WAV sent to
   `doubao-seed-2-0-lite-260428` as
   `{ "type": "input_audio", "audio_url": "data:audio/wav;base64,..." }`
   returned HTTP 200 in 6454 ms. Safe request ID:
   `0217853840425571a075693bd93985ba47542ecd43c1bf6224886`.
2. The full CLI was run against a generated Chinese spoken WAV:
   `/tmp/xiaohuan-nonsensitive.wav`.
   The file was PCM signed 16-bit little-endian, 16 kHz, mono, 211586 bytes and
   6610 ms.
3. The single multimodal call completed in 24873 ms and returned a valid
   `experiment-audio.v1`. Safe request ID:
   `021785384589462275a44fd862e8b57dcd33414ced1969641ce2d`.
4. Human comparison confirmed that the Chinese transcript preserved the
   sentence's sample, temperature, duration and observation. The structured
   result contained the expected sample identifier, one rest action, two
   measurements and one color-change observation.

The first attempt at generating the spoken fixture produced a legal WAV header
with zero audio data. That exposed an input-validation gap; the parser now
rejects zero-data WAV files as `EMPTY_WAV`, with a regression test.

## Repository-wide test context

A broad Vitest run excluding the repository's known `scripts/q.test.ts` sandbox
case was attempted after implementation. It was not green because concurrent,
unrelated Gateway-confirmation work in the dirty worktree currently causes
circular-initialization and conversation-thread guard failures; local-listener
tests also hit the managed sandbox's `EPERM`. Those files were not modified for
this change. The relevant reference-Gateway suite passed in full when rerun
with local-listen permission.

## Remaining real-device evidence

No `.wav` or `.wave` file was found under `/Users/realityloop/Downloads` within
three directory levels on 2026-07-30. Consequently this verification does not
claim a Xiaohuan-device success.

To close tasks 6.2 and 6.3, provide an approved non-sensitive single-sentence
Xiaohuan PCM WAV. Record its location, sample format and duration without
committing the audio, then run:

```bash
node --env-file=examples/xiaohuan-doubao-audio/.env \
  --import tsx \
  examples/xiaohuan-doubao-audio/cli.ts \
  /absolute/path/to/xiaohuan-capture.wav \
  --capture-id xiaohuan-live-001
```

The resulting JSON should be reviewed against the spoken sentence. Only model,
latency, safe request ID and a fact-level comparison should be added here.

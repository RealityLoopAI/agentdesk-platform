## Why

The Vision Archive Worker has produced answers that conflict with the current NAS tool results because old conversational claims and schema examples can be reused as if they were current evidence. We need an isolated, reversible GLM trial that starts the worker from clean context while keeping the existing API key and OpenAI-compatible relay unchanged.

## What Changes

- Add an optional per-agent-group provider model override so one worker can select `glm-5.2` without changing the global provider credentials, base URL, or other groups.
- Configure only the Vision Archive Worker pilot to use `glm-5.2`.
- Remove example experiment field names and values from the private `vision-archive-query` Skill, and require field/file claims to come from successful tool results in the current request.
- Retire the existing Archive Worker session so the next delegated request starts with fresh model context; preserve the archived session for diagnosis instead of rewriting its container-owned history database.
- Exercise a real natural-language archive query through the existing Feishu → Frontdesk → Archive Worker → Gateway → NAS path and compare the response against gateway evidence.
- This trial does not introduce continuous archive monitoring and does not claim to be a complete deterministic evidence barrier.

## Capabilities

### New Capabilities

- `per-group-provider-model`: Select a non-secret model identifier per agent group while inheriting the configured provider endpoint and credentials.
- `vision-archive-grounded-trial`: Run the Vision Archive Worker with clean context and a schema-neutral, current-request-evidence-only private Skill.

### Modified Capabilities

None.

## Impact

- Host container configuration and container launch environment composition.
- Vision Archive pilot template, deployed group configuration, and private Skill instructions.
- Configuration reference, architecture decision log, and unit/integration tests.
- Runtime operation: the current Archive Worker session is archived and its container is stopped before the GLM-backed verification request.
- No backend gateway contract, identity trust chain, SMB archive layout, or global `.env` credential changes.

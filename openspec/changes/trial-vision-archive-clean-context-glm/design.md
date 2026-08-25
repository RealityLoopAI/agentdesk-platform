## Context

The OpenAI-compatible provider currently obtains `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` from the host's global environment. Changing `OPENAI_MODEL` therefore changes every OpenAI-backed group. The Vision Archive Worker also has a persistent root-session context containing prior unsupported claims, while its private Skill includes illustrative field names that can bias a later answer.

The business data path remains request-driven and gateway-only under ADR-0070. The three-database single-writer invariant forbids the host from editing the Worker's `outbound.db` to erase conversation state.

## Goals / Non-Goals

**Goals:**

- Override only the Archive Worker's model with `glm-5.2`.
- Continue inheriting the existing OpenAI-compatible base URL, API key, timeout, transport, and vault behavior.
- Remove schema examples from the archive Skill and make current-request tool evidence the only allowed source for file metadata and JSON fields.
- Start the trial from a genuinely fresh Worker session without destroying the old diagnostic record.
- Verify the resulting natural-language path against gateway/NAS evidence.

**Non-Goals:**

- Changing the global model for Frontdesk or other workers.
- Adding a new provider implementation or dependency.
- Editing the backend gateway contract or bypassing it with direct SMB access.
- Providing a complete deterministic response-evidence validator in this trial.
- Monitoring the archive folder continuously.

## Decisions

### Add a dedicated `providerModel` field to per-group container configuration

`container.json` gains an optional, non-secret `providerModel` string. At container launch the host copies the provider contribution and replaces only its provider-specific model variable. For `openai` and `codex`, that variable is `OPENAI_MODEL`.

This field is separate from the generic `env` map. Provider/system environment is deliberately not overridable by `env`; weakening that rule would let arbitrary per-group settings replace credential or proxy controls. A typed model selector preserves that boundary.

Alternative considered: change global `OPENAI_MODEL`. Rejected because it also changes Frontdesk and unrelated workers.

Alternative considered: permit `env.OPENAI_MODEL`. Rejected because it creates ambiguous precedence and weakens the documented provider-environment boundary.

### Fail closed on unsupported providers and malformed model identifiers

The model override is applied only when the selected provider declares a model environment key. Invalid or empty identifiers are normalized away when configuration is read; an override on an unsupported provider is ignored with a warning rather than being forwarded as an arbitrary environment variable.

### Keep credentials and relay configuration global

The override is applied after the OpenAI provider contribution is built. No base URL or API key is copied into group configuration, and vault mode continues to withhold the API key exactly as before.

### Reconcile the pilot template into the deployed group

The source of truth remains `examples/vision-archive-pilot/agent-group/`. The topology reconciler copies the template model setting and private Skill into `groups/agentdesk-vision-archive-worker/` while preserving deployment-owned signing material.

### Archive rather than mutate the contaminated Worker session

The running Worker container is stopped through the host lifecycle API, then the supported session archive operation creates a tarball, marks the central session row archived, and removes the live session directory. The next root-session delegation therefore allocates a new session. This preserves the old context for diagnosis and respects the outbound database's container-only writer.

Alternative considered: delete rows from `outbound.db` or overwrite its continuation state. Rejected because it violates the three-database single-writer invariant and destroys evidence.

### Make Skill instructions schema-neutral and turn-local

The Skill may describe how to list and read candidate files, but it contains no example result field names or example field values. The Worker must distinguish search/list/read results, cite only successful calls associated with the current user request, and state that data was not read when an expected call did not succeed.

## Risks / Trade-offs

- [Risk] GLM may not implement the same tool-calling behavior as the previous model. → Run a real archive query and retain an immediate rollback by removing `providerModel`.
- [Risk] Prompt rules alone still cannot mathematically prevent fabricated synthesis. → Treat this as an isolated trial and compare the final answer with gateway audit/results; propose a deterministic evidence envelope separately if needed.
- [Risk] Archiving the active Worker session could race with an in-flight turn. → Stop the container first, verify it is stopped, then archive.
- [Risk] The relay's advertised model set can change. → Confirm `glm-5.2` availability immediately before the live test.

## Migration Plan

1. Add and test the optional configuration field and launch-time overlay.
2. Update the configuration reference and ADR index.
3. Update the Vision Archive template configuration and private Skill; reconcile the deployed group.
4. Build/restart affected runtime components.
5. Stop and archive only the current Archive Worker session.
6. Send a controlled natural-language query and compare the response with gateway evidence.
7. Roll back by removing `providerModel`, reconciling, and stopping the new Worker container; the global provider configuration remains untouched.

## Open Questions

- If GLM still returns unsupported facts, should the follow-up change introduce a host-validated evidence envelope that rejects any final file metadata not present in the current request's tool results?

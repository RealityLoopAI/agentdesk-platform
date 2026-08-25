## ADDED Requirements

### Requirement: Agent group can select its provider model
The system SHALL accept an optional non-secret `providerModel` identifier in an agent group's container configuration and SHALL apply it only to that group's provider container.

#### Scenario: OpenAI-compatible group overrides the global model
- **WHEN** an OpenAI-compatible group declares a valid `providerModel`
- **THEN** its container receives that identifier as `OPENAI_MODEL`
- **AND** other agent groups continue to receive their own configured or global model

#### Scenario: Group does not declare an override
- **WHEN** an agent group omits `providerModel`
- **THEN** provider model selection remains unchanged from the global provider contribution

### Requirement: Model override does not replace provider connectivity or credentials
The system MUST preserve the existing provider base URL, API key handling, timeout, transport, and vault behavior when applying a per-group model override.

#### Scenario: Direct-credential OpenAI-compatible group
- **WHEN** a direct-credential group selects a provider model
- **THEN** the container receives the globally configured base URL and API key unchanged
- **AND** only the model value is replaced

#### Scenario: Vault-routed OpenAI-compatible group
- **WHEN** a vault-routed group selects a provider model
- **THEN** the API key remains withheld from the container
- **AND** the group model override is still applied

### Requirement: Model identifiers are bounded and provider-aware
The system MUST discard malformed model identifiers and MUST NOT forward a model override as an arbitrary environment variable for a provider without a declared model variable.

#### Scenario: Malformed model identifier
- **WHEN** `providerModel` is empty, over the length limit, or contains disallowed control characters
- **THEN** the configuration reader discards the override

#### Scenario: Provider has no model override mapping
- **WHEN** a valid `providerModel` is configured for an unsupported provider
- **THEN** container launch does not inject an unrecognized model environment variable

## 1. Per-group provider model

- [x] 1.1 Add failing configuration normalization tests for valid, empty, overlong, and control-character `providerModel` values.
- [x] 1.2 Add failing container launch tests proving an OpenAI-compatible group overrides only `OPENAI_MODEL`, preserves other provider environment, and does not inject an override for unsupported providers.
- [x] 1.3 Implement the typed `providerModel` configuration and provider-aware launch overlay.

## 2. Documentation and decision record

- [x] 2.1 Document `providerModel`, its precedence, supported providers, and credential inheritance in the configuration reference.
- [x] 2.2 Add ADR-0080 for the typed per-group model override and update the ADR index.

## 3. Vision Archive pilot

- [x] 3.1 Configure the pilot's Archive Worker template to use `glm-5.2` while leaving provider endpoint and credentials global.
- [x] 3.2 Remove example result fields and values from the private Skill and add current-request evidence rules.
- [x] 3.3 Add or update pilot tests that assert the reconciled Worker configuration and schema-neutral Skill.
- [x] 3.4 Run the topology reconciler and verify the deployed group retains its deployment-owned signing configuration.

## 4. Fresh-context rollout

- [x] 4.1 Stop the current Archive Worker container and archive its session through the supported lifecycle operation.
- [x] 4.2 Verify the old session is archived and the next root-session delegation creates a different Worker session.

## 5. Verification

- [x] 5.1 Run focused tests, full typecheck, and the full test suite.
- [x] 5.2 Confirm `glm-5.2` remains available from the unchanged relay and credentials.
- [x] 5.3 Send a real natural-language archive query and compare every returned file fact with same-request gateway evidence.

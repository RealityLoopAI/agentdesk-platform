## 1. JSON Configuration and Qualification

- [x] 1.1 Add disabled-by-default JSON trusted-Host configuration alongside the existing image-delivery configuration, including logical resource, exact target fields, static test values, JSON bounds, and machine HMAC key validation.
- [x] 1.2 Implement the closed voice-photo analysis parser and deterministic qualification rules, including adopted-frame consistency and strict decimal/confidence validation.
- [x] 1.3 Implement canonical field construction and stable content/resource/fields-bound machine idempotency proof generation.
- [x] 1.4 Add focused configuration, parser, qualification, field mapping, and proof-vector tests.

## 2. Stable JSON Polling and Durable State

- [x] 2.1 Refactor the recursive scanner for `.json` candidates, bounded strict reads, pre/post metadata checks, containment, symlink rejection, and SHA-256 digesting.
- [x] 2.2 Version the monitor state database for JSON Bitable mode and persist baseline, observation, qualification outcome, submission attempts, retry state, and verified Record IDs.
- [x] 2.3 Update the service state machine to ignore first-baseline JSON, submit each qualifying generation once, retry transient Host ingress failures, and never inspect or upload images.
- [x] 2.4 Add scanner/state/service and parser tests for baseline, malformed/incomplete/unclear data, replacement generations, retry state, and no-image behavior.

## 3. Trusted Machine Ingress and Worker

- [x] 3.1 Convert the optional monitor entrypoint into an ingress-only ChannelAdapter that binds a configured canonical user and submits a closed machine envelope through `ChannelSetup.onInboundEvent`.
- [x] 3.2 Add a topology reconciler and dedicated machine messaging group/Worker route without exposing the automatic path through ordinary Feishu text routing.
- [x] 3.3 Add group-specific instructions requiring Describe, exact Field List, Authorize, Create without confirmation, and Record Get only for a valid versioned machine envelope.
- [x] 3.4 Isolate every digest in its own machine-channel thread/session and enforce closed, source-correlated Worker result parsing without a direct Gateway/Bitable client.

## 4. Gateway Machine-Proof Enforcement

- [x] 4.1 Extend the reference Bitable resource policy with an optional redacted machine-ingest HMAC key and strict parser without exposing it through discovery.
- [x] 4.2 Verify the machine idempotency proof against the exact Create resource and fields before unattended execution while preserving all existing writer, agent-group, Schema, identity, audit, and idempotency checks.
- [x] 4.3 Add Gateway tests for valid automatic Create, missing/modified proof, wrong fields/digest, ordinary Create compatibility, and replay idempotency.
- [x] 4.4 Update Gateway configuration examples and contract documentation for the narrowly scoped test-resource machine policy.

## 5. Operations, Architecture, and Verification

- [x] 5.1 Replace the monitor README and environment example with JSON baseline, validation, trusted Host startup, test-field mapping, key rotation, smoke test, and rollback instructions.
- [x] 5.2 Add an ADR recording the dedicated machine-ingress channel, content-bound unattended Create proof, and rejection of direct monitor writes; update the ADR index.
- [x] 5.3 Run focused monitor, Gateway, typecheck, formatting, OpenSpec strict validation, and relevant security invariant tests.
- [x] 5.4 Inspect the final diff for NAS writes, physical Bitable identifiers, leaked keys, ordinary-chat auto-write bypass, confirmation regressions, direct Gateway calls, unbounded JSON, and unrelated edits.

## 6. Preserve Parallel Image Notification

- [x] 6.1 Restore the original image monitor implementation and its focused tests without changing its baseline, validation, retry, or fixed-P2P semantics.
- [x] 6.2 Add a Host-managed image adapter and register it alongside the JSON adapter with independent enablement and lifecycle.
- [x] 6.3 Update environment and operator documentation for two independent state databases and parallel smoke tests.
- [x] 6.4 Run image, JSON, Gateway, typecheck, formatting, and strict OpenSpec regression checks.

## 7. Route JSON to the Correct Scene Table

- [x] 7.1 Discover the live scene table schemas and configure one logical Gateway resource per supported scene without exposing physical IDs.
- [x] 7.2 Replace the fixed gram-table mapping with a strict scene/resource/field/unit route map and bind the selected route into the machine proof.
- [x] 7.2a Make topology reconciliation idempotently grant the configured trusted user access to the dedicated machine Worker group.
- [x] 7.3 Reprocess the rejected `场景一 / 650 rpm` generation and verify a real `场景一` record through Gateway audit plus Record Get.
- [x] 7.4 Update operator docs and ADR, then run focused tests, typecheck, formatting, and strict OpenSpec validation.

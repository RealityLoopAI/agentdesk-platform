## 1. Host History Projection

- [x] 1.1 Add an optional `ask-question` read-only presentation type to the Host and Web history DTOs while preserving the existing human-readable `text` fallback.
- [x] 1.2 Implement a total, bounded, allowlist-only parser for standard `ask_question` outbound content that rejects malformed and unsupported structured payloads without failing history loading.
- [x] 1.3 Correlate exact Session-scoped pending-question rows and Host-written `question_response` system rows into `awaiting-external-response`, `answered`, `cancelled`, or `closed` presentation state without exposing raw response content or user identifiers.
- [x] 1.4 Add Host history tests for valid cards, selected-option display, cancelled/closed state, legacy text fallback, malformed payloads, pagination, and Lane access denial.

## 2. Cross-Channel Refresh

- [x] 2.1 Publish an idempotent `conversation.message.available` Lane event after a question response is persisted, gated on an active user-owned Lane whose root is the resolved Session.
- [x] 2.2 Add tests proving Feishu resolution refreshes only the owning user's Web Lane and that missing, archived, mismatched, or non-root Lanes emit no event.

## 3. Web Read-Only Card

- [x] 3.1 Extend Web API types to accept the optional read-only question presentation without weakening existing message validation.
- [x] 3.2 Add an accessible `ReadOnlyQuestionCard` component using semantic non-control option markup, narrow-screen wrapping, safe text rendering, and explicit external-channel or terminal status copy.
- [x] 3.3 Integrate the component into `MessageTimeline`, retaining Markdown rendering for normal messages and the text fallback for unknown or invalid presentations.
- [x] 3.4 Add component and conversation-page tests proving the card contains no answer controls, displays the selected option after external resolution, does not render raw JSON, and remains usable with keyboard and assistive technology.

## 4. End-to-End Verification and Documentation

- [x] 4.1 Extend unified Feishu/Web messaging coverage so a delivered Feishu `ask_question` appears as a Web read-only card and its later Feishu response updates the same card without duplication.
- [x] 4.2 Update Web/Feishu operations and API documentation with the optional presentation contract, read-only boundary, fallback behavior, and external-response refresh semantics.
- [x] 4.3 Run formatting, Host typecheck/tests, Web typecheck/tests, unified messaging tests, and OpenSpec validation.
- [x] 4.4 Verify the existing `msg-1785468763491-nw5p8s` row renders as an answered read-only card with “链路测试” selected and no regression to Feishu delivery.

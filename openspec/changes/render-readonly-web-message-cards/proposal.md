## Why

Feishu renders the platform's standard `ask_question` payload as an interactive card, while Web history currently exposes the same outbound row as raw JSON because its message contract only carries text. The Web surface should present that already-authorized, persisted message as a readable card without creating a second confirmation or response path.

## What Changes

- Add an optional, allowlisted read-only card presentation to Web history messages for valid `ask_question` payloads.
- Render the card title, question, options, and derived lifecycle state in the Web conversation timeline.
- Derive answered or cancelled state from Host-written `question_response` rows and pending state from the existing central pending-question record.
- Reuse the existing Lane message event path so a delivered question appears in an open Web conversation, and publish a refresh event when another channel resolves it.
- Preserve a human-readable text fallback for older Web clients and malformed or unsupported structured payloads.
- Do not add Web buttons, answer/confirmation endpoints, or any new path for resolving pending questions.
- Do not render arbitrary Agent-authored card JSON; all non-allowlisted structured content continues through the safe text/Markdown path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-channel`: Web history and the message timeline gain a safe, read-only representation of standard `ask_question` messages, including cross-channel resolution status.

## Impact

- Host Web history DTO construction in `src/web/conversations.ts`.
- Lane event publication when `src/modules/interactive/index.ts` resolves a question.
- Web API types and the conversation timeline under `web/src/`.
- Web history, event-stream, component, and unified-messaging tests.
- No database migration, new dependency, Gateway contract change, or Feishu delivery change is required.

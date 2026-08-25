## Context

The authoritative conversation history is assembled from a Lane root Session's `inbound.db` and `outbound.db`. A container-side `ask_user_question` call writes a `chat-sdk` outbound row whose JSON content contains `type`, `questionId`, `title`, `question`, and normalized `options`. Delivery persists a central `pending_questions` row, then the Feishu Adapter converts that payload into an interactive Feishu card.

Web receives the same Lane delivery event and reloads history, but `WebHistoryMessage` currently exposes only `text`. Its JSON-to-text helper recognizes `displayText` and `text`; an `ask_question` has neither, so the raw machine payload is returned and rendered as Markdown. When Feishu answers the question, Host writes a trusted `question_response` system row to the same Session and deletes the central pending row, but Web does not currently correlate that response with the outbound question.

The Web card is presentation-only. The identity trust chain, pending-question resolver, Feishu callback path, and container protocol remain authoritative and unchanged.

## Goals / Non-Goals

**Goals:**

- Render a valid standard `ask_question` payload as a readable, accessible card in Web history.
- Keep the existing `text` field as a human-readable backward-compatible fallback.
- Show options as non-interactive rows or chips, never as controls.
- Derive `awaiting-external-response`, `answered`, `cancelled`, or `closed` display state from Host-owned records without adding a schema.
- Refresh an open Web conversation when Feishu or another Host-registered response path resolves the question.
- Reject malformed or oversized card payloads at the Web presentation boundary and preserve safe rendering.

**Non-Goals:**

- Answering, approving, rejecting, or cancelling an `ask_question` from Web.
- Adding a Web generic-question mutation endpoint.
- Changing Feishu card construction or callback validation.
- Treating arbitrary `type: "card"` or other Agent-authored JSON as trusted UI.
- Replacing the existing Gateway confirmation panel, which has a separate Host-owned contract and interaction flow.
- Encoding Bitable, voice, image, or other business-specific fields in platform-core components.

## Decisions

### 1. Extend history with an optional discriminated read-only presentation

`WebHistoryMessage` will retain `text` and add an optional presentation:

```ts
type WebMessagePresentation = {
  type: 'ask-question';
  mode: 'read-only';
  title: string;
  question: string;
  options: Array<{
    label: string;
    selected: boolean;
  }>;
  state: 'awaiting-external-response' | 'answered' | 'cancelled' | 'closed';
  selectedLabel: string | null;
  responseChannel: string | null;
};
```

The field is optional, so an older Web client continues to render `text`. For a valid card, `text` becomes a concise human-readable question rather than the raw JSON.

Alternative considered: return the original outbound `content` object and let React interpret it. This is rejected because it exposes an open-ended Agent-controlled UI protocol and moves trust-boundary parsing into the browser.

### 2. Parse only the allowlisted `ask_question` schema on the Host

The history assembler will use a strict parser that requires:

- `type === "ask_question"`;
- bounded non-empty `questionId`, `title`, and `question`;
- a bounded, non-empty options array;
- each option to have bounded string `label`, `selectedLabel`, and `value` fields after normalization.

Unknown fields are ignored. Invalid payloads do not receive a card presentation. The fallback remains escaped/sanitized text or Markdown, and the parser never returns HTML.

Alternative considered: reuse the permissive delivery-time normalizer directly. This is rejected because history can contain legacy or malformed container-authored rows, and Web needs a total, fail-safe parser that cannot throw while loading a whole page.

### 3. Correlate lifecycle state without a database migration

History assembly will read only the minimum Host-owned data needed:

- exact `question_response` system rows from the Lane root Session's `inbound.db`, parsed by `questionId`;
- central `pending_questions` rows scoped to that exact Session and outbound message.

For each valid outbound question:

- a trusted response with `cancelled: true` produces `cancelled`;
- a trusted response whose selected value matches a persisted option produces `answered` and highlights the matching option's `selectedLabel`;
- no response plus an exact central pending row produces `awaiting-external-response`;
- no response and no pending row produces `closed`.

The Web DTO never exposes the response's `userId`, raw system content, option values, or central identifiers beyond the message ID already present in history. If a response value does not match the card's options, Web shows `closed` without highlighting a value.

Alternative considered: add status and selected-option columns to `pending_questions`. This is unnecessary for a read-only projection and would change a runtime data contract solely for presentation.

### 4. Reuse existing Lane events for appearance and resolution refresh

Successful Lane delivery already appends `conversation.message.available` with the outbound message ID. That remains the event that makes the read-only card appear after Feishu delivery.

`resolvePendingQuestion` will append another `conversation.message.available` event after persisting the `question_response`, using the response message ID as the event resource. It will do so only when the Session is the valid root of an active, user-owned Lane. The browser already invalidates the Lane history query for this event type, so no new SSE protocol or client event branch is required.

Alternative considered: introduce `conversation.question.available/resolved` events. This is rejected for the initial scope because the existing durable message-availability event already expresses the necessary cache invalidation and avoids another public event type.

### 5. Render semantic, non-interactive UI

The timeline will render a dedicated `ReadOnlyQuestionCard` when `presentation.type === "ask-question"`. Options will use semantic list markup, not disabled buttons, so the UI does not imply that clicking is possible. The card will include a status label such as:

- “请在飞书端完成选择” for an unresolved Feishu-targeted question;
- “Web 端仅供查看” for an unresolved Web-targeted question;
- “已选择：链路测试” for an answered question;
- “已取消” or “已关闭” for terminal states.

All text continues through safe React text rendering or the existing sanitized Markdown component. The component will preserve keyboard navigation, contrast, narrow-screen wrapping, and reduced-motion behavior.

## Risks / Trade-offs

- **[Legacy payloads do not satisfy the strict schema]** → Render a human-readable text fallback and never fail the history page.
- **[The pending table is intentionally ephemeral]** → Treat absence without a trusted response as `closed`, not as proof of a particular expiry reason.
- **[A response arrives while the browser is disconnected]** → Durable SSE replay or the next history request reconstructs state from the databases.
- **[Question and response pages are loaded separately]** → Lifecycle correlation runs before pagination, then pagination is applied to the resulting message list, preserving deterministic display.
- **[Large Agent-authored fields could inflate history responses]** → Bound strings, option count, and option lengths in the presentation parser; keep the existing history-page limit.
- **[Users may expect to click option-like UI]** → Use non-control list/chip semantics and explicit “仅供查看/请在飞书端选择” copy.

## Migration Plan

1. Add Host parser, lifecycle correlation, DTO fields, and unit tests.
2. Add resolution-triggered Lane refresh events and event tests.
3. Add the Web read-only card component, API types, accessibility tests, and page integration.
4. Run Host, Web, and unified Feishu/Web messaging tests.
5. Deploy Host and Web together. The optional field keeps rolling deployment backward compatible.
6. Verify the existing `msg-1785468763491-nw5p8s` history row renders as an answered card with “链路测试” selected.

Rollback requires reverting the optional DTO field and component branch. No data rollback is necessary because this change performs no migration or new persistent writes beyond the existing Web event log.

## Open Questions

None for the initial `ask_question`-only, read-only scope.

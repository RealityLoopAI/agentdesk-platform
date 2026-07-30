import { registerDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import { emitAgentTurnResolved, type AgentTurnResolutionStatus } from './events.js';

const TERMINAL_STATUSES = new Set<AgentTurnResolutionStatus>([
  'completed',
  'provider-failed',
  'cancelled',
  'timed-out',
]);

async function handleAgentTurnResolved(
  content: Record<string, unknown>,
  session: Session,
  _inDb: unknown,
  context?: { messageOutId: string; inReplyTo: string | null },
): Promise<void> {
  const status = content.status;
  const sourceMessageId = context?.inReplyTo;
  if (
    typeof status !== 'string' ||
    !TERMINAL_STATUSES.has(status as AgentTurnResolutionStatus) ||
    !sourceMessageId
  ) {
    return;
  }

  await emitAgentTurnResolved({
    sessionId: session.id,
    sourceMessageId,
    status: status as AgentTurnResolutionStatus,
    code: typeof content.code === 'string' ? content.code : undefined,
    retryable: content.retryable === true,
  });
}

registerDeliveryAction('agent_turn_resolved', handleAgentTurnResolved);

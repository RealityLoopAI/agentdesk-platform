export type AgentTurnResolutionStatus = 'completed' | 'provider-failed' | 'cancelled' | 'timed-out';

export interface AgentTurnResolvedEvent {
  sessionId: string;
  sourceMessageId: string;
  status: AgentTurnResolutionStatus;
  code?: string;
  retryable: boolean;
}

export type AgentTurnResolvedListener = (event: AgentTurnResolvedEvent) => void | Promise<void>;

const listeners = new Set<AgentTurnResolvedListener>();

/**
 * Observe an Agent turn terminal state. This event is correlation-only: it
 * cannot approve a Gateway operation or mutate the trusted request identity.
 */
export function onAgentTurnResolved(listener: AgentTurnResolvedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function emitAgentTurnResolved(event: AgentTurnResolvedEvent): Promise<void> {
  await Promise.allSettled([...listeners].map((listener) => listener(event)));
}

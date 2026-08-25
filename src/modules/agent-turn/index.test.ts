import { describe, expect, it, vi } from 'vitest';

import type { DeliveryActionHandler } from '../../delivery.js';

const actions = new Map<string, DeliveryActionHandler>();
vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    actions.set(action, handler);
  },
}));

const { onAgentTurnResolved } = await import('./events.js');
await import('./index.js');

describe('agent_turn_resolved delivery action', () => {
  it('emits a correlated read-only terminal event', async () => {
    const observed = vi.fn();
    const unsubscribe = onAgentTurnResolved(observed);
    const handler = actions.get('agent_turn_resolved');
    expect(handler).toBeDefined();

    await handler!(
      {
        action: 'agent_turn_resolved',
        status: 'provider-failed',
        code: 'gateway_5xx',
        retryable: true,
      },
      { id: 'session-1' } as never,
      {} as never,
      { messageOutId: 'out-1', inReplyTo: 'in-1' },
    );

    expect(observed).toHaveBeenCalledWith({
      sessionId: 'session-1',
      sourceMessageId: 'in-1',
      status: 'provider-failed',
      code: 'gateway_5xx',
      retryable: true,
    });
    unsubscribe();
  });

  it('ignores missing correlation and unknown statuses', async () => {
    const observed = vi.fn();
    const unsubscribe = onAgentTurnResolved(observed);
    const handler = actions.get('agent_turn_resolved')!;

    await handler(
      { action: 'agent_turn_resolved', status: 'completed' },
      { id: 'session-1' } as never,
      {} as never,
      { messageOutId: 'out-1', inReplyTo: null },
    );
    await handler(
      { action: 'agent_turn_resolved', status: 'invented' },
      { id: 'session-1' } as never,
      {} as never,
      { messageOutId: 'out-2', inReplyTo: 'in-2' },
    );

    expect(observed).not.toHaveBeenCalled();
    unsubscribe();
  });
});

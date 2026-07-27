import { describe, expect, it } from 'vitest';

import type { InboundEvent } from './adapter.js';
import { assertChannelAdapterContract } from './channel-contract.js';
import { createWebAdapter, submitAuthenticatedWebInbound } from './web.js';

describe('Web channel adapter', () => {
  it('satisfies the channel contract and forwards Host-authenticated envelopes', async () => {
    const adapter = createWebAdapter();
    expect(() => assertChannelAdapterContract(adapter)).not.toThrow();
    const received: InboundEvent[] = [];
    await adapter.setup({
      onInbound: () => {},
      onInboundEvent: async (event) => {
        received.push(event);
      },
      onMetadata: () => {},
      onAction: () => {},
    });

    await submitAuthenticatedWebInbound({
      platformId: 'web:lane-1',
      threadId: null,
      authenticatedUserId: 'alice',
      conversationLaneId: 'lane-1',
      message: {
        id: 'web-message',
        kind: 'chat',
        content: JSON.stringify({ text: 'hello' }),
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(received).toEqual([
      expect.objectContaining({
        channelType: 'web',
        platformId: 'web:lane-1',
        authenticatedUserId: 'alice',
        conversationLaneId: 'lane-1',
      }),
    ]);

    await adapter.teardown();
    await expect(
      submitAuthenticatedWebInbound({
        platformId: 'web:lane-1',
        threadId: null,
        authenticatedUserId: 'alice',
        conversationLaneId: 'lane-1',
        message: {
          id: 'after-close',
          kind: 'chat',
          content: '{}',
          timestamp: '2026-01-01T00:00:01.000Z',
        },
      }),
    ).rejects.toThrow('not connected');
  });
});

/**
 * First-class Web channel adapter.
 *
 * The HTTP server authenticates the browser and resolves an owned Lane before
 * calling submitAuthenticatedWebInbound(). This adapter is the only bridge
 * from that authenticated HTTP boundary into the common Channel Router.
 */
import { createHash } from 'node:crypto';

import { readWebConfig } from '../web/config.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

let hostSetup: ChannelSetup | null = null;
let connected = false;

export async function submitAuthenticatedWebInbound(
  event: Omit<InboundEvent, 'channelType'> & { authenticatedUserId: string; conversationLaneId: string },
): Promise<void> {
  if (!hostSetup || !connected) throw new Error('web channel adapter is not connected');
  await hostSetup.onInboundEvent({ ...event, channelType: 'web' });
}

export function createWebAdapter(): ChannelAdapter {
  return {
    name: 'web',
    channelType: 'web',
    supportsThreads: false,

    async setup(setup: ChannelSetup): Promise<void> {
      hostSetup = setup;
      connected = true;
    },

    async teardown(): Promise<void> {
      connected = false;
      hostSetup = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId, _threadId, message): Promise<string> {
      // Delivery is completed by the durable Web event bridge. Until that
      // bridge is attached, history remains available from outbound.db.
      // The stable id keeps the adapter contract deterministic and contains no
      // message content.
      return `web-delivery-${createHash('sha256')
        .update(`${platformId}\0${JSON.stringify(message.content)}`)
        .digest('hex')
        .slice(0, 24)}`;
    },
  };
}

registerChannelAdapter('web', {
  factory: () => (readWebConfig() ? createWebAdapter() : null),
});

/**
 * First-class Web channel adapter.
 *
 * The HTTP server authenticates the browser and resolves an owned Lane before
 * calling submitAuthenticatedWebInbound(). This adapter is the only bridge
 * from that authenticated HTTP boundary into the common Channel Router.
 */
import { getDb } from '../db/connection.js';
import { appendWebEvent } from '../db/web-events.js';
import { chainAttrs, runInDetachedRoot } from '../observability/openinference.js';
import { withSpan } from '../observability/with-span.js';
import { readWebConfig } from '../web/config.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

let hostSetup: ChannelSetup | null = null;
let connected = false;

export async function submitAuthenticatedWebInbound(
  event: Omit<InboundEvent, 'channelType'> & { authenticatedUserId: string; conversationLaneId: string },
): Promise<void> {
  const setup = hostSetup;
  if (!setup || !connected) throw new Error('web channel adapter is not connected');
  await runInDetachedRoot(() =>
    withSpan(
      'channel.web.receive',
      chainAttrs({
        'channel.type': 'web',
        'message.kind': event.message.kind,
        'user.id': event.authenticatedUserId,
      }),
      async () => setup.onInboundEvent({ ...event, channelType: 'web' }),
    ),
  );
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
      if (!message.source) throw new Error('web delivery requires a persisted outbound source');
      const lane = getDb()
        .prepare(
          `SELECT l.id, l.owner_user_id
           FROM conversation_bindings b
           JOIN conversation_lanes l ON l.id = b.lane_id
           WHERE b.channel_type = 'web'
             AND b.platform_id = ?
             AND b.revoked_at IS NULL
             AND b.delivery_mode = 'source-reply'
             AND l.status = 'active'
             AND l.root_session_id = ?
           LIMIT 1`,
        )
        .get(platformId, message.source.sessionId) as { id: string; owner_user_id: string } | undefined;
      if (!lane) throw new Error('web delivery binding is unavailable');
      const { event } = appendWebEvent({
        userId: lane.owner_user_id,
        laneId: lane.id,
        eventType: 'conversation.message.available',
        resourceId: message.source.messageId,
      });
      return event.event_id;
    },
  };
}

registerChannelAdapter('web', {
  factory: () => (readWebConfig() ? createWebAdapter() : null),
});

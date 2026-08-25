import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { InboundEvent } from './adapter.js';
import { assertChannelAdapterContract } from './channel-contract.js';
import { createWebAdapter, submitAuthenticatedWebInbound } from './web.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

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

  it('turns only an attested persisted outbound row into a durable Lane event', async () => {
    const now = '2026-07-27T10:00:00.000Z';
    getDb().exec(`
      INSERT INTO users (id, kind, display_name, created_at)
        VALUES ('alice', 'feishu', 'Alice', '${now}');
      INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
        VALUES ('ag-1', 'Agent', 'agent', NULL, '${now}', NULL);
      INSERT INTO sessions
        (id, agent_group_id, messaging_group_id, thread_id, owner_user_id, root_session_id,
         conversation_lane_id, agent_provider, status, container_status, last_active, archived_at, created_at)
        VALUES
        ('session-1', 'ag-1', NULL, NULL, 'alice', 'session-1',
         NULL, NULL, 'active', 'stopped', '${now}', NULL, '${now}');
      INSERT INTO conversation_lanes
        (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
        VALUES ('lane-1', 'ag-1', 'alice', 'session-1', 'active', '${now}', NULL);
      UPDATE sessions SET conversation_lane_id = 'lane-1' WHERE id = 'session-1';
      INSERT INTO conversation_bindings
        (id, lane_id, channel_type, messaging_group_id, platform_id, thread_id,
         external_identity_id, delivery_mode, verified_at, revoked_at)
        VALUES
        ('binding-1', 'lane-1', 'web', NULL, 'web:lane-1', NULL,
         NULL, 'source-reply', '${now}', NULL);
    `);

    const adapter = createWebAdapter();
    const eventId = await adapter.deliver('web:lane-1', null, {
      kind: 'chat',
      content: { text: 'reply content is not copied to the event table' },
      source: { messageId: 'out-1', sessionId: 'session-1' },
    });
    expect(eventId).toMatch(/^web-event-/);
    expect(getDb().prepare('SELECT * FROM web_events').all()).toEqual([
      expect.objectContaining({
        event_id: eventId,
        user_id: 'alice',
        lane_id: 'lane-1',
        event_type: 'conversation.message.available',
        resource_id: 'out-1',
      }),
    ]);

    await expect(
      adapter.deliver('web:lane-1', null, {
        kind: 'chat',
        content: { text: 'forged session' },
        source: { messageId: 'out-2', sessionId: 'session-forged' },
      }),
    ).rejects.toThrow('binding is unavailable');
  });
});

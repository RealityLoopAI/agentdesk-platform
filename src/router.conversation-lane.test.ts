import Database from 'better-sqlite3';
import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/agentdesk-test-conversation-lane-router' };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { createConversationBinding, createConversationLane } from './db/conversation-lanes.js';
import { runMigrations } from './db/migrations/index.js';
import { createUserIdentity } from './db/user-identities.js';
import { inboundDbPath } from './session-manager.js';
import { routeInbound, setSenderResolver } from './router.js';

const TEST_DATA_DIR = '/tmp/agentdesk-test-conversation-lane-router';

beforeAll(() => {
  // Test seam for the two Host-established identities. The Web API will
  // supply the authenticated principal from its server-side session, never
  // from browser JSON.
  setSenderResolver((event) => {
    if (event.conversationLaneId) return 'alice';
    if (event.senderIdentity?.externalSubject === 'ou_alice') return 'alice';
    if (event.senderIdentity?.externalSubject === 'ou_bob') return 'bob';
    return null;
  });
});

beforeEach(() => {
  process.env.CROSS_CHANNEL_LANES_ENABLED = 'true';
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at) VALUES
      ('alice', 'person', 'Alice', '2026-01-01T00:00:00.000Z'),
      ('bob', 'person', 'Bob', '2026-01-01T00:00:00.000Z');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES
      ('mg-feishu', 'feishu', 'feishu:oc_room', 'Feishu', 1, 'public', '2026-01-01T00:00:00.000Z'),
      ('mg-web-alice', 'web', 'web:lane-alice', 'Web', 0, 'public', '2026-01-01T00:00:00.000Z');
    INSERT INTO messaging_group_agents
      (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
       sender_scope, ignored_message_policy, session_mode, priority, created_at)
      VALUES
      ('mga-feishu', 'mg-feishu', 'ag-1', 'pattern', '.', 'all', 'drop',
       'per-user', 0, '2026-01-01T00:00:00.000Z'),
      ('mga-web', 'mg-web-alice', 'ag-1', 'pattern', '.', 'all', 'drop',
       'per-user', 0, '2026-01-01T00:00:00.000Z');
  `);
});

afterEach(() => {
  delete process.env.CROSS_CHANNEL_LANES_ENABLED;
  closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.INGRESS_DURABILITY;
});

function event(args: {
  id: string;
  channelType: 'feishu' | 'web';
  platformId: string;
  externalSubject?: string;
  conversationLaneId?: string;
}) {
  return {
    channelType: args.channelType,
    platformId: args.platformId,
    threadId: null,
    conversationLaneId: args.conversationLaneId,
    message: {
      id: args.id,
      kind: 'chat' as const,
      content: JSON.stringify({ text: args.id }),
      timestamp: '2026-01-01T00:00:00.000Z',
      isGroup: args.channelType === 'feishu',
    },
    senderIdentity: args.externalSubject
      ? {
          provider: 'feishu',
          providerScope: 'app-a',
          identifierType: 'open_id',
          externalSubject: args.externalSubject,
        }
      : undefined,
  };
}

describe('Router cross-channel Conversation Lane', () => {
  it('automatically creates one deterministic Lane/Binding on the first verified Feishu message', async () => {
    createUserIdentity({
      userId: 'alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });

    await Promise.all([
      routeInbound(
        event({
          id: 'feishu-concurrent-a',
          channelType: 'feishu',
          platformId: 'feishu:oc_room',
          externalSubject: 'ou_alice',
        }),
      ),
      routeInbound(
        event({
          id: 'feishu-concurrent-b',
          channelType: 'feishu',
          platformId: 'feishu:oc_room',
          externalSubject: 'ou_alice',
        }),
      ),
    ]);

    const sessions = getDb()
      .prepare('SELECT id, owner_user_id, conversation_lane_id FROM sessions')
      .all() as Array<{ id: string; owner_user_id: string; conversation_lane_id: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.owner_user_id).toBe('alice');
    expect(sessions[0]?.conversation_lane_id).toMatch(/^lane-feishu-/);
    expect(
      getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get(),
    ).toBe(1);
    expect(
      getDb().prepare('SELECT COUNT(*) FROM conversation_bindings WHERE revoked_at IS NULL').pluck().get(),
    ).toBe(1);

    const inbound = new Database(inboundDbPath('ag-1', sessions[0]!.id), { readonly: true });
    expect(inbound.prepare('SELECT COUNT(*) FROM messages_in').pluck().get()).toBe(2);
    inbound.close();
  });

  it('reuses Alice Lane across Feishu and Web while isolating Bob in the same group', async () => {
    const aliceIdentity = createUserIdentity({
      userId: 'alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    const bobIdentity = createUserIdentity({
      userId: 'bob',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_bob',
    });
    const aliceLane = createConversationLane({
      id: 'lane-alice',
      agentGroupId: 'ag-1',
      ownerUserId: 'alice',
    });
    const bobLane = createConversationLane({
      id: 'lane-bob',
      agentGroupId: 'ag-1',
      ownerUserId: 'bob',
    });
    createConversationBinding({
      laneId: aliceLane.id,
      channelType: 'feishu',
      messagingGroupId: 'mg-feishu',
      platformId: 'feishu:oc_room',
      externalIdentityId: aliceIdentity.id,
      deliveryMode: 'source-reply',
    });
    createConversationBinding({
      laneId: bobLane.id,
      channelType: 'feishu',
      messagingGroupId: 'mg-feishu',
      platformId: 'feishu:oc_room',
      externalIdentityId: bobIdentity.id,
      deliveryMode: 'source-reply',
    });
    createConversationBinding({
      laneId: aliceLane.id,
      channelType: 'web',
      messagingGroupId: 'mg-web-alice',
      platformId: 'web:lane-alice',
      deliveryMode: 'source-reply',
    });

    await routeInbound(
      event({
        id: 'feishu-alice',
        channelType: 'feishu',
        platformId: 'feishu:oc_room',
        externalSubject: 'ou_alice',
      }),
    );
    await routeInbound(
      event({
        id: 'feishu-bob',
        channelType: 'feishu',
        platformId: 'feishu:oc_room',
        externalSubject: 'ou_bob',
      }),
    );
    await routeInbound(
      event({
        id: 'web-alice',
        channelType: 'web',
        platformId: 'web:lane-alice',
        conversationLaneId: aliceLane.id,
      }),
    );

    const sessions = getDb()
      .prepare(
        `SELECT id, owner_user_id, conversation_lane_id
         FROM sessions ORDER BY owner_user_id`,
      )
      .all() as Array<{
      id: string;
      owner_user_id: string;
      conversation_lane_id: string;
    }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((row) => row.owner_user_id)).toEqual(['alice', 'bob']);
    expect(sessions.map((row) => row.conversation_lane_id)).toEqual([aliceLane.id, bobLane.id]);

    const aliceSession = sessions[0]!;
    const inbound = new Database(inboundDbPath('ag-1', aliceSession.id), {
      readonly: true,
    });
    const rows = inbound
      .prepare(
        `SELECT channel_type, platform_id, thread_id, origin_user_id
         FROM messages_in ORDER BY seq`,
      )
      .all();
    inbound.close();
    expect(rows).toEqual([
      {
        channel_type: 'feishu',
        platform_id: 'feishu:oc_room',
        thread_id: null,
        origin_user_id: 'alice',
      },
      {
        channel_type: 'web',
        platform_id: 'web:lane-alice',
        thread_id: null,
        origin_user_id: 'alice',
      },
    ]);
  });

  it('keeps Feishu on its legacy session key while cross-channel auto-association is disabled', async () => {
    const aliceIdentity = createUserIdentity({
      userId: 'alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    const aliceLane = createConversationLane({
      id: 'lane-alice',
      agentGroupId: 'ag-1',
      ownerUserId: 'alice',
    });
    createConversationBinding({
      laneId: aliceLane.id,
      channelType: 'feishu',
      messagingGroupId: 'mg-feishu',
      platformId: 'feishu:oc_room',
      externalIdentityId: aliceIdentity.id,
      deliveryMode: 'source-reply',
    });

    process.env.CROSS_CHANNEL_LANES_ENABLED = 'false';
    await routeInbound(
      event({
        id: 'feishu-alice-flag-off',
        channelType: 'feishu',
        platformId: 'feishu:oc_room',
        externalSubject: 'ou_alice',
      }),
    );

    const session = getDb().prepare('SELECT owner_user_id, conversation_lane_id FROM sessions').get() as {
      owner_user_id: string;
      conversation_lane_id: string | null;
    };
    expect(session).toEqual({ owner_user_id: 'alice', conversation_lane_id: null });
    expect(getDb().prepare('SELECT root_session_id FROM conversation_lanes WHERE id = ?').get(aliceLane.id)).toEqual({
      root_session_id: null,
    });
  });

  it('keeps an authenticated Web Lane usable while native auto-association is disabled', async () => {
    const aliceLane = createConversationLane({
      id: 'lane-alice',
      agentGroupId: 'ag-1',
      ownerUserId: 'alice',
    });

    process.env.CROSS_CHANNEL_LANES_ENABLED = 'false';
    await routeInbound(
      event({
        id: 'web-alice-flag-off',
        channelType: 'web',
        platformId: 'web:lane-alice',
        conversationLaneId: aliceLane.id,
      }),
    );

    expect(getDb().prepare('SELECT owner_user_id, conversation_lane_id FROM sessions').get()).toEqual({
      owner_user_id: 'alice',
      conversation_lane_id: aliceLane.id,
    });
  });
});

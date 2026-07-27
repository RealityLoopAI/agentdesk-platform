import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { createConversationLane } from './conversation-lanes.js';
import {
  DeliverySubscriptionError,
  disableFeishuDeliverySubscription,
  enableFeishuDeliverySubscription,
  getFeishuDeliverySubscriptionState,
  reserveCrossChannelDelivery,
  validateCrossChannelDeliveryTarget,
} from './delivery-subscriptions.js';
import { runMigrations } from './migrations/index.js';
import { createSession } from './sessions.js';
import { createUserIdentity } from './user-identities.js';
import type { Session } from '../types.js';

const NOW = '2026-07-27T00:00:00.000Z';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at) VALUES
      ('alice', 'feishu', 'Alice', '${NOW}'),
      ('bob', 'feishu', 'Bob', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '${NOW}', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES ('mg-web', 'web', 'web:lane-alice', 'Web', 0, 'strict', '${NOW}');
  `);
});

afterEach(() => closeDb());

function rootSession(laneId: string): Session {
  return {
    id: 'session-alice',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-web',
    thread_id: null,
    owner_user_id: 'alice',
    root_session_id: 'session-alice',
    conversation_thread_id: null,
    conversation_lane_id: laneId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    archived_at: null,
    spawn_depth: 0,
    created_at: NOW,
  };
}

describe('Feishu DM delivery subscriptions', () => {
  it('is default-off, derives the private destination from the verified identity, and audits changes', () => {
    const lane = createConversationLane({ id: 'lane-alice', agentGroupId: 'ag-1', ownerUserId: 'alice' });
    expect(
      getFeishuDeliverySubscriptionState({
        userId: 'alice',
        laneId: lane.id,
        providerScope: 'app-a',
      }),
    ).toEqual({ enabled: false, available: false, subscriptionId: null });

    const identity = createUserIdentity({
      userId: 'alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    const enabled = enableFeishuDeliverySubscription({
      userId: 'alice',
      laneId: lane.id,
      providerScope: 'app-a',
      enabledAt: NOW,
    });
    expect(enabled).toMatchObject({
      lane_id: lane.id,
      platform_id: 'feishu:p2p:ou_alice',
      external_identity_id: identity.id,
      delivery_kind: 'agent-reply-mirror',
    });
    expect(
      getFeishuDeliverySubscriptionState({
        userId: 'alice',
        laneId: lane.id,
        providerScope: 'app-a',
      }),
    ).toMatchObject({ enabled: true, available: true, subscriptionId: enabled.id });

    expect(disableFeishuDeliverySubscription({ userId: 'alice', laneId: lane.id })).toBe(true);
    expect(
      getDb()
        .prepare(
          `SELECT event_type FROM enterprise_audit
           WHERE event_type LIKE 'delivery_subscription_%'
           ORDER BY occurred_at, rowid`,
        )
        .all(),
    ).toEqual([{ event_type: 'delivery_subscription_enabled' }, { event_type: 'delivery_subscription_disabled' }]);
  });

  it('rejects cross-user lanes and never accepts a browser-supplied destination', () => {
    const lane = createConversationLane({ id: 'lane-alice', agentGroupId: 'ag-1', ownerUserId: 'alice' });
    createUserIdentity({
      userId: 'bob',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_bob',
    });
    expect(() =>
      enableFeishuDeliverySubscription({
        userId: 'bob',
        laneId: lane.id,
        providerScope: 'app-a',
      }),
    ).toThrowError(expect.objectContaining<Partial<DeliverySubscriptionError>>({ reason: 'lane_unavailable' }));
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM delivery_subscriptions').get()).toEqual({ count: 0 });
  });

  it('assigns stable origin/delivery ids and invalidates pending sends after revocation', () => {
    const lane = createConversationLane({ id: 'lane-alice', agentGroupId: 'ag-1', ownerUserId: 'alice' });
    createUserIdentity({
      userId: 'alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    createSession(rootSession(lane.id));
    getDb().prepare('UPDATE conversation_lanes SET root_session_id = ? WHERE id = ?').run('session-alice', lane.id);
    const subscription = enableFeishuDeliverySubscription({
      userId: 'alice',
      laneId: lane.id,
      providerScope: 'app-a',
    });
    const first = reserveCrossChannelDelivery({
      subscription,
      laneId: lane.id,
      sessionId: 'session-alice',
      messageOutId: 'out-1',
    });
    const duplicate = reserveCrossChannelDelivery({
      subscription,
      laneId: lane.id,
      sessionId: 'session-alice',
      messageOutId: 'out-1',
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.origin_id).toBe(first.origin_id);
    expect(first.id).toMatch(/^xcd-[A-Za-z0-9_-]{43}$/);
    expect(first.origin_id).toMatch(/^xco-[A-Za-z0-9_-]{43}$/);
    expect(validateCrossChannelDeliveryTarget(first)?.id).toBe(subscription.id);

    disableFeishuDeliverySubscription({ userId: 'alice', laneId: lane.id });
    expect(validateCrossChannelDeliveryTarget(first)).toBeUndefined();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM cross_channel_deliveries').get()).toEqual({ count: 1 });
  });
});

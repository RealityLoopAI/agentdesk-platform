import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import {
  ConversationBindingConflictError,
  ConversationLaneConflictError,
  createConversationBinding,
  createConversationLane,
  findActiveConversationBinding,
  getConversationLane,
  linkLegacyFeishuSession,
  linkSessionToConversationLane,
  revokeConversationBinding,
} from './conversation-lanes.js';
import { runMigrations } from './migrations/index.js';
import { createSession } from './sessions.js';
import { createUserIdentity } from './user-identities.js';
import { conversationBindingFailuresTotal } from '../metrics.js';
import type { Session } from '../types.js';

const NOW = '2026-01-01T00:00:00.000Z';

function seed(): void {
  const db = getDb();
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at) VALUES
      ('alice', 'feishu', 'Alice', '${NOW}'),
      ('bob', 'feishu', 'Bob', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '${NOW}', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES ('mg-feishu', 'feishu', 'feishu:oc_room', 'Room', 1, 'public', '${NOW}');
  `);
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-alice',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-feishu',
    thread_id: null,
    owner_user_id: 'alice',
    root_session_id: 'session-alice',
    conversation_thread_id: 'observability-only-value',
    conversation_lane_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    archived_at: null,
    spawn_depth: 0,
    created_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seed();
});

afterEach(() => {
  closeDb();
});

describe('conversation lane ownership and bindings', () => {
  it('keeps Alice and Bob isolated even when both bind the same Feishu group', () => {
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
    const aliceLane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    const bobLane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'bob' });
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

    expect(
      findActiveConversationBinding({
        channelType: 'feishu',
        platformId: 'feishu:oc_room',
        externalIdentityId: aliceIdentity.id,
        ownerUserId: 'alice',
        agentGroupId: 'ag-1',
      })?.lane.id,
    ).toBe(aliceLane.id);
    expect(
      findActiveConversationBinding({
        channelType: 'feishu',
        platformId: 'feishu:oc_room',
        externalIdentityId: bobIdentity.id,
        ownerUserId: 'bob',
        agentGroupId: 'ag-1',
      })?.lane.id,
    ).toBe(bobLane.id);
  });

  it('rejects shared histories and every owner/group mismatch when linking a root session', () => {
    const lane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    createSession(session());
    expect(() =>
      linkSessionToConversationLane({
        laneId: lane.id,
        sessionId: 'session-alice',
        sourceSessionMode: 'shared',
      }),
    ).toThrowError(expect.objectContaining({ reason: 'shared_session_mode' }));

    createSession(session({ id: 'session-bob', root_session_id: 'session-bob', owner_user_id: 'bob' }));
    expect(() =>
      linkSessionToConversationLane({
        laneId: lane.id,
        sessionId: 'session-bob',
        sourceSessionMode: 'per-user',
      }),
    ).toThrowError(expect.objectContaining({ reason: 'owner_mismatch' }));

    const linked = linkSessionToConversationLane({
      laneId: lane.id,
      sessionId: 'session-alice',
      sourceSessionMode: 'per-user',
    });
    expect(linked.root_session_id).toBe('session-alice');
    expect(getConversationLane(lane.id)?.root_session_id).toBe('session-alice');
  });

  it('uses NULL-safe active uniqueness, but allows a verified address after revocation', async () => {
    const lane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    const otherLane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    const binding = createConversationBinding({
      laneId: lane.id,
      channelType: 'web',
      platformId: 'web:alice',
      deliveryMode: 'source-reply',
    });
    const conflictBefore =
      (await conversationBindingFailuresTotal.get()).values.find(
        (value) => value.labels.reason === 'active_address_conflict',
      )?.value ?? 0;
    expect(() =>
      createConversationBinding({
        laneId: otherLane.id,
        channelType: 'web',
        platformId: 'web:alice',
        deliveryMode: 'source-reply',
      }),
    ).toThrow(ConversationBindingConflictError);
    expect(
      (await conversationBindingFailuresTotal.get()).values.find(
        (value) => value.labels.reason === 'active_address_conflict',
      )?.value,
    ).toBe(conflictBefore + 1);
    expect(
      revokeConversationBinding({
        bindingId: binding.id,
        actor: 'alice',
        reason: 'move to another conversation',
      }),
    ).toBe(true);
    expect(() =>
      createConversationBinding({
        laneId: otherLane.id,
        channelType: 'web',
        platformId: 'web:alice',
        deliveryMode: 'source-reply',
      }),
    ).not.toThrow();

    const auditRows = getDb()
      .prepare(
        `SELECT event_type, details FROM enterprise_audit
         WHERE event_type LIKE 'conversation_lane_%' OR event_type LIKE 'conversation_binding_%'
         ORDER BY rowid`,
      )
      .all() as Array<{ event_type: string; details: string }>;
    expect(auditRows.map((row) => row.event_type)).toEqual([
      'conversation_lane_created',
      'conversation_lane_created',
      'conversation_binding_created',
      'conversation_binding_revoked',
      'conversation_binding_created',
    ]);
    expect(JSON.stringify(auditRows)).not.toContain('web:alice');
  });

  it('links one exact verified legacy Feishu user session deterministically without merging users', () => {
    const identity = createUserIdentity({
      userId: 'alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    createSession(session({ thread_id: 'om_thread' }));
    const first = linkLegacyFeishuSession({
      sessionId: 'session-alice',
      sourceSessionMode: 'per-user-per-thread',
      externalIdentityId: identity.id,
      actor: 'operator',
    });
    const second = linkLegacyFeishuSession({
      sessionId: 'session-alice',
      sourceSessionMode: 'per-user-per-thread',
      externalIdentityId: identity.id,
      actor: 'operator',
    });
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^lane-legacy-/);

    const bobIdentity = createUserIdentity({
      userId: 'bob',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_bob',
    });
    createSession(session({ id: 'session-unlinked', root_session_id: 'session-unlinked' }));
    expect(() =>
      linkLegacyFeishuSession({
        sessionId: 'session-unlinked',
        sourceSessionMode: 'per-user',
        externalIdentityId: bobIdentity.id,
        actor: 'operator',
      }),
    ).toThrow(ConversationLaneConflictError);
  });
});

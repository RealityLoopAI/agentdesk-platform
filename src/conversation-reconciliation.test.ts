import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConversationLaneConflictError,
  createConversationBinding,
  createConversationLane,
} from './db/conversation-lanes.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createSession } from './db/sessions.js';
import { createUserIdentity } from './db/user-identities.js';
import {
  ensureFeishuConversationLaneForInbound,
  reconcileFeishuConversationLanes,
} from './conversation-reconciliation.js';
import type { Session } from './types.js';

const NOW = '2026-01-01T00:00:00.000Z';

function session(id: string, messagingGroupId: string, agentGroupId: string = 'ag-1'): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    owner_user_id: 'alice',
    root_session_id: id,
    conversation_thread_id: null,
    conversation_lane_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: NOW,
    archived_at: null,
    spawn_depth: 0,
    created_at: NOW,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('alice', 'person', 'Alice', '${NOW}'), ('bob', 'person', 'Bob', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES
        ('ag-1', 'Agent 1', 'agent-1', NULL, '${NOW}', NULL),
        ('ag-2', 'Agent 2', 'agent-2', NULL, '${NOW}', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES
        ('mg-1', 'feishu', 'feishu:oc_one', 'One', 1, 'public', '${NOW}'),
        ('mg-2', 'feishu', 'feishu:oc_two', 'Two', 1, 'public', '${NOW}'),
        ('mg-shared', 'feishu', 'feishu:oc_shared', 'Shared', 1, 'public', '${NOW}');
    INSERT INTO messaging_group_agents
      (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
       sender_scope, ignored_message_policy, session_mode, priority, created_at)
      VALUES
        ('mga-1', 'mg-1', 'ag-1', 'pattern', '.', 'all', 'drop', 'per-user', 0, '${NOW}'),
        ('mga-2', 'mg-2', 'ag-2', 'pattern', '.', 'all', 'drop', 'per-user', 0, '${NOW}'),
        ('mga-shared', 'mg-shared', 'ag-1', 'pattern', '.', 'all', 'drop', 'shared', 0, '${NOW}');
  `);
});

afterEach(() => {
  closeDb();
});

function aliceIdentity() {
  return createUserIdentity({
    userId: 'alice',
    provider: 'feishu',
    providerScope: 'app-a',
    identifierType: 'open_id',
    externalSubject: 'ou_alice',
  });
}

describe('Feishu conversation reconciliation', () => {
  it('backfills multiple legacy sessions in bounded pages and is idempotent', () => {
    const identity = aliceIdentity();
    createSession(session('session-1', 'mg-1'));
    createSession(session('session-2', 'mg-2', 'ag-2'));

    const first = reconcileFeishuConversationLanes({
      userId: 'alice',
      externalIdentityId: identity.id,
      actor: 'alice',
      trigger: 'web',
      limit: 1,
    });
    expect(first).toMatchObject({ scanned: 1, linked: 1, hasMore: true, nextCursor: 'session-1' });

    const second = reconcileFeishuConversationLanes({
      userId: 'alice',
      externalIdentityId: identity.id,
      actor: 'alice',
      trigger: 'web',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({ scanned: 1, linked: 1, hasMore: false, nextCursor: 'session-2' });
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(2);
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_bindings').pluck().get()).toBe(2);

    const repeat = reconcileFeishuConversationLanes({
      userId: 'alice',
      externalIdentityId: identity.id,
      actor: 'alice',
      trigger: 'web',
      limit: 10,
    });
    expect(repeat).toMatchObject({ scanned: 2, existing: 2, linked: 0, conflicts: 0 });
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(2);
  });

  it('supports dry-run and skips unauthorized or shared-mode candidates without mutation', () => {
    const identity = aliceIdentity();
    createSession(session('session-1', 'mg-1'));
    createSession(session('session-2', 'mg-2', 'ag-2'));
    createSession(session('session-shared', 'mg-shared'));

    const result = reconcileFeishuConversationLanes({
      userId: 'alice',
      externalIdentityId: identity.id,
      actor: 'operator',
      trigger: 'operator',
      dryRun: true,
      limit: 10,
      authorizeAgentGroup: (agentGroupId) => agentGroupId === 'ag-1',
    });
    expect(result).toMatchObject({
      scanned: 3,
      dryRunEligible: 1,
      skippedUnauthorized: 1,
      skippedMode: 1,
      linked: 0,
    });
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(0);

    const audit = getDb()
      .prepare("SELECT details FROM enterprise_audit WHERE event_type = 'conversation_reconciliation_completed'")
      .get() as { details: string };
    expect(audit.details).not.toContain('ou_alice');
    expect(audit.details).not.toContain('feishu:oc_');
  });

  it('fails closed for an identity-owner mismatch and for an address conflict', () => {
    const identity = aliceIdentity();
    const bobIdentity = createUserIdentity({
      userId: 'bob',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_bob',
    });
    createSession(session('session-1', 'mg-1'));

    expect(() =>
      reconcileFeishuConversationLanes({
        userId: 'alice',
        externalIdentityId: bobIdentity.id,
        actor: 'alice',
        trigger: 'web',
      }),
    ).toThrow(ConversationLaneConflictError);

    const occupied = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    createConversationBinding({
      laneId: occupied.id,
      channelType: 'feishu',
      messagingGroupId: 'mg-1',
      platformId: 'feishu:oc_one',
      externalIdentityId: identity.id,
      deliveryMode: 'source-reply',
    });
    const result = reconcileFeishuConversationLanes({
      userId: 'alice',
      externalIdentityId: identity.id,
      actor: 'alice',
      trigger: 'web',
    });
    expect(result).toMatchObject({ scanned: 1, linked: 0, conflicts: 1 });
    expect(getDb().prepare('SELECT conversation_lane_id FROM sessions WHERE id = ?').pluck().get('session-1')).toBeNull();
  });

  it('links an exact existing legacy session during inbound association without reading message history', () => {
    const identity = aliceIdentity();
    createSession(session('session-legacy', 'mg-1'));

    const laneId = ensureFeishuConversationLaneForInbound({
      agentGroupId: 'ag-1',
      ownerUserId: 'alice',
      messagingGroupId: 'mg-1',
      platformId: 'feishu:oc_one',
      threadId: null,
      sourceSessionMode: 'per-user',
      externalIdentityId: identity.id,
    });
    const repeatedLaneId = ensureFeishuConversationLaneForInbound({
      agentGroupId: 'ag-1',
      ownerUserId: 'alice',
      messagingGroupId: 'mg-1',
      platformId: 'feishu:oc_one',
      threadId: null,
      sourceSessionMode: 'per-user',
      externalIdentityId: identity.id,
    });
    expect(laneId).toMatch(/^lane-legacy-/);
    expect(repeatedLaneId).toBe(laneId);
    expect(
      getDb().prepare('SELECT conversation_lane_id FROM sessions WHERE id = ?').pluck().get('session-legacy'),
    ).toBe(laneId);
  });
});

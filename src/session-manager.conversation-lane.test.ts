import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/agentdesk-test-conversation-lane-session-manager' };
});

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { ConversationLaneConflictError, createConversationLane } from './db/conversation-lanes.js';
import { runMigrations } from './db/migrations/index.js';
import { resolveSession } from './session-manager.js';

const TEST_DATA_DIR = '/tmp/agentdesk-test-conversation-lane-session-manager';

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at) VALUES
      ('alice', 'feishu', 'Alice', '2026-01-01T00:00:00.000Z'),
      ('bob', 'feishu', 'Bob', '2026-01-01T00:00:00.000Z');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES
      ('mg-feishu', 'feishu', 'feishu:oc_room', 'Feishu', 1, 'public', '2026-01-01T00:00:00.000Z'),
      ('mg-web', 'web', 'web:alice', 'Web', 0, 'strict', '2026-01-01T00:00:00.000Z');
  `);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('cross-channel session resolution', () => {
  it('reuses one lane root across Feishu and Web without consulting conversation_thread_id', () => {
    const lane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    const feishu = resolveSession(
      'ag-1',
      'mg-feishu',
      'om_thread',
      'per-user-per-thread',
      'alice',
      null,
      null,
      lane.id,
    );
    expect(feishu.created).toBe(true);
    expect(feishu.session.conversation_lane_id).toBe(lane.id);

    // This correlation field is deliberately corrupted to prove it is not a
    // structural lookup input (ADR-0039/0055).
    getDb()
      .prepare('UPDATE sessions SET conversation_thread_id = ? WHERE id = ?')
      .run('duplicate-observability-value', feishu.session.id);

    const web = resolveSession('ag-1', 'mg-web', null, 'per-user', 'alice', null, null, lane.id);
    expect(web.created).toBe(false);
    expect(web.session.id).toBe(feishu.session.id);
    expect(web.session.messaging_group_id).toBe('mg-feishu');
  });

  it('atomically attaches an existing unlinked user session when the verified Lane has no root', () => {
    const legacy = resolveSession('ag-1', 'mg-feishu', null, 'per-user', 'alice');
    const lane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });

    const linked = resolveSession('ag-1', 'mg-feishu', null, 'per-user', 'alice', null, null, lane.id);

    expect(linked.created).toBe(false);
    expect(linked.session.id).toBe(legacy.session.id);
    expect(linked.session.conversation_lane_id).toBe(lane.id);
    expect(getDb().prepare('SELECT root_session_id FROM conversation_lanes WHERE id = ?').pluck().get(lane.id)).toBe(
      legacy.session.id,
    );
  });

  it('fails closed for another user or any shared session mode', () => {
    const lane = createConversationLane({ agentGroupId: 'ag-1', ownerUserId: 'alice' });
    expect(() => resolveSession('ag-1', 'mg-web', null, 'per-user', 'bob', null, null, lane.id)).toThrowError(
      expect.objectContaining({ reason: 'owner_mismatch' }),
    );
    expect(() => resolveSession('ag-1', 'mg-feishu', null, 'shared', null, null, null, lane.id)).toThrow(
      ConversationLaneConflictError,
    );
  });
});

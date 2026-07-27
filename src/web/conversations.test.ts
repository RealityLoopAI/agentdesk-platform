import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/agentdesk-test-web-conversations' };
});

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { listConversationBindings } from '../db/conversation-lanes.js';
import { runMigrations } from '../db/migrations/index.js';
import { openOutboundDbRw, resolveSession, writeSessionMessage } from '../session-manager.js';
import {
  createWebConversation,
  getWebConversationHistory,
  listWebConversations,
  WebConversationError,
} from './conversations.js';

const TEST_DATA_DIR = '/tmp/agentdesk-test-web-conversations';

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at) VALUES
      ('alice', 'feishu', 'Alice', '2026-01-01T00:00:00.000Z'),
      ('bob', 'feishu', 'Bob', '2026-01-01T00:00:00.000Z');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Research Agent', 'research', NULL, '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
      VALUES ('alice', 'ag-1', NULL, '2026-01-01T00:00:00.000Z');
  `);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('Web conversation service', () => {
  it('creates a user-owned Web binding and hides inaccessible Lanes from the list', () => {
    const lane = createWebConversation('alice', 'ag-1');
    expect(lane.agentGroup).toEqual({ id: 'ag-1', name: 'Research Agent' });
    const binding = listConversationBindings(lane.id)[0]!;
    expect(binding).toMatchObject({
      channel_type: 'web',
      platform_id: `web:${lane.id}`,
      delivery_mode: 'source-reply',
    });

    expect(listWebConversations('alice').conversations.map((item) => item.id)).toEqual([lane.id]);
    getDb().prepare('DELETE FROM agent_group_members WHERE user_id = ?').run('alice');
    expect(listWebConversations('alice').conversations).toEqual([]);
  });

  it('assembles deterministic pages from the authoritative DB pair without exposing another user row', () => {
    const lane = createWebConversation('alice', 'ag-1');
    const binding = listConversationBindings(lane.id)[0]!;
    const resolved = resolveSession('ag-1', binding.messaging_group_id, null, 'per-user', 'alice', null, null, lane.id);
    writeSessionMessage('ag-1', resolved.session.id, {
      id: 'in-1',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:01.000Z',
      platformId: binding.platform_id,
      channelType: 'web',
      content: JSON.stringify({ text: 'first' }),
      originUserId: 'alice',
    });
    const outbound = openOutboundDbRw('ag-1', resolved.session.id);
    outbound
      .prepare(
        `INSERT INTO messages_out
           (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content, in_reply_to)
         VALUES (?, ?, ?, 'chat', NULL, NULL, NULL, ?, ?)`,
      )
      .run('out-1', 3, '2026-01-01T00:00:02.000Z', JSON.stringify({ text: 'answer' }), 'in-1');
    outbound.close();
    writeSessionMessage('ag-1', resolved.session.id, {
      id: 'in-2',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:03.000Z',
      platformId: binding.platform_id,
      channelType: 'web',
      content: JSON.stringify({ text: 'second' }),
      originUserId: 'alice',
    });
    // Defense-in-depth fixture: even if a foreign row somehow lands in the
    // root DB, the Web history view excludes it.
    writeSessionMessage('ag-1', resolved.session.id, {
      id: 'in-bob',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:04.000Z',
      platformId: binding.platform_id,
      channelType: 'web',
      content: JSON.stringify({ text: 'private Bob text' }),
      originUserId: 'bob',
    });

    const latest = getWebConversationHistory({ userId: 'alice', laneId: lane.id, limit: 2 });
    expect(latest.messages.map((message) => message.id)).toEqual(['out-1', 'in-2']);
    expect(latest.messages.map((message) => message.text)).not.toContain('private Bob text');
    expect(latest.messages[0]!.channel).toEqual({
      type: 'web',
      platformId: binding.platform_id,
      threadId: null,
    });
    expect(latest.nextCursor).toBeTruthy();

    const older = getWebConversationHistory({
      userId: 'alice',
      laneId: lane.id,
      limit: 2,
      cursor: latest.nextCursor,
    });
    expect(older.messages.map((message) => message.id)).toEqual(['in-1']);
    expect(older.nextCursor).toBeNull();
    expect(() => getWebConversationHistory({ userId: 'alice', laneId: lane.id, cursor: 'not-a-cursor' })).toThrowError(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });

  it('uses the same generic error for missing and foreign conversation ids', () => {
    const lane = createWebConversation('alice', 'ag-1');
    for (const laneId of [lane.id, 'lane-does-not-exist']) {
      expect(() => getWebConversationHistory({ userId: 'bob', laneId })).toThrowError(
        expect.objectContaining<Partial<WebConversationError>>({
          status: 403,
          code: 'conversation_unavailable',
        }),
      );
    }
  });
});

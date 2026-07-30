import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/agentdesk-test-web-conversations' };
});

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { listConversationBindings } from '../db/conversation-lanes.js';
import { createPendingGatewayConfirmation } from '../db/gateway-confirmations.js';
import { runMigrations } from '../db/migrations/index.js';
import { openOutboundDbRw, resolveSession, writeSessionMessage } from '../session-manager.js';
import {
  createWebConversation,
  getWebConversationHistory,
  listWebGatewayConfirmations,
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
  it('exposes only the owner-bound confirmation display and hides the opaque Gateway request', () => {
    const lane = createWebConversation('alice', 'ag-1');
    const binding = listConversationBindings(lane.id)[0]!;
    const resolved = resolveSession('ag-1', binding.messaging_group_id, null, 'per-user', 'alice', null, null, lane.id);
    createPendingGatewayConfirmation({
      confirmationId: 'confirm-1',
      sessionId: resolved.session.id,
      messageOutId: 'confirm-1',
      kind: 'update',
      requesterUserId: 'alice',
      agentGroupId: 'ag-1',
      conversationLaneId: lane.id,
      channelType: 'web',
      platformId: binding.platform_id,
      threadId: null,
      confirmationRequest: 'opaque-secret-request',
      displayJson: JSON.stringify({
        recordId: 'rec-1',
        diff: [{ field: '状态', before: '待办', after: '完成', highImpact: false }],
      }),
      title: '确认修改',
      optionsJson: '[]',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const visible = listWebGatewayConfirmations({ userId: 'alice', laneId: lane.id });
    expect(visible.confirmations).toEqual([
      expect.objectContaining({
        id: 'confirm-1',
        kind: 'update',
        display: expect.objectContaining({ recordId: 'rec-1' }),
      }),
    ]);
    expect(JSON.stringify(visible)).not.toContain('opaque-secret-request');
    expect(() => listWebGatewayConfirmations({ userId: 'bob', laneId: lane.id })).toThrowError(
      expect.objectContaining({ code: 'conversation_unavailable' }),
    );
  });

  it('creates a user-owned Web binding and hides inaccessible Lanes from the list', () => {
    const lane = createWebConversation('alice', 'ag-1');
    expect(lane.agentGroup).toEqual({ id: 'ag-1', name: 'Research Agent' });
    const binding = listConversationBindings(lane.id)[0]!;
    expect(binding).toMatchObject({
      channel_type: 'web',
      platform_id: `web:${lane.id}`,
      delivery_mode: 'source-reply',
    });
    expect(lane).toMatchObject({
      sourceChannel: 'web',
      lastActiveAt: null,
    });

    expect(listWebConversations('alice').conversations.map((item) => item.id)).toEqual([lane.id]);
    getDb().prepare('DELETE FROM agent_group_members WHERE user_id = ?').run('alice');
    expect(listWebConversations('alice').conversations).toEqual([]);
  });

  it('returns the original Feishu channel and root Session activity as non-sensitive list metadata', () => {
    const now = '2026-01-01T02:03:04.000Z';
    getDb().exec(`
      INSERT INTO messaging_groups
        (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES ('mg-feishu', 'feishu', 'feishu:oc_private', 'Private', 0, 'strict', '${now}');
      INSERT INTO conversation_lanes
        (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
      VALUES ('lane-feishu', 'ag-1', 'alice', NULL, 'active', '${now}', NULL);
      INSERT INTO sessions
        (id, agent_group_id, messaging_group_id, thread_id, owner_user_id, root_session_id,
         conversation_thread_id, conversation_lane_id, agent_provider, status, container_status,
         last_active, archived_at, spawn_depth, created_at)
      VALUES
        ('session-feishu', 'ag-1', 'mg-feishu', NULL, 'alice', 'session-feishu',
         NULL, 'lane-feishu', NULL, 'active', 'stopped', '${now}', NULL, 0, '${now}');
      UPDATE conversation_lanes SET root_session_id = 'session-feishu' WHERE id = 'lane-feishu';
      INSERT INTO conversation_bindings
        (id, lane_id, channel_type, messaging_group_id, platform_id, thread_id,
         external_identity_id, delivery_mode, verified_at, revoked_at)
      VALUES
        ('binding-feishu', 'lane-feishu', 'feishu', 'mg-feishu', 'feishu:oc_private',
         NULL, NULL, 'source-reply', '${now}', NULL);
    `);

    expect(listWebConversations('alice').conversations).toEqual([
      expect.objectContaining({
        id: 'lane-feishu',
        sourceChannel: 'feishu',
        lastActiveAt: now,
        agentGroup: { id: 'ag-1', name: 'Research Agent' },
      }),
    ]);
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
      // SQLite CURRENT_TIMESTAMP uses this UTC shape without `T` or `Z`.
      .run('out-1', 3, '2026-01-01 00:00:02', JSON.stringify({ text: 'answer' }), 'in-1');
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
    expect(latest.messages[0]!.timestamp).toBe('2026-01-01T00:00:02.000Z');
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

  it('keeps A2A Worker results internal instead of rendering them as user-authored messages', () => {
    const lane = createWebConversation('alice', 'ag-1');
    const binding = listConversationBindings(lane.id)[0]!;
    const resolved = resolveSession('ag-1', binding.messaging_group_id, null, 'per-user', 'alice', null, null, lane.id);
    writeSessionMessage('ag-1', resolved.session.id, {
      id: 'in-user',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:01.000Z',
      platformId: binding.platform_id,
      channelType: 'web',
      content: JSON.stringify({ text: 'read the approved record' }),
      originUserId: 'alice',
    });
    writeSessionMessage('ag-1', resolved.session.id, {
      id: 'in-worker-result',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:02.000Z',
      platformId: 'ag-bitable-worker',
      channelType: 'agent',
      content: JSON.stringify({ text: '**internal Worker result**' }),
      sourceSessionId: 'session-bitable-worker',
      // The trusted origin must survive A2A for Gateway authorization, but it
      // must not make the Worker the author of a user-facing message.
      originUserId: 'alice',
    });
    const outbound = openOutboundDbRw('ag-1', resolved.session.id);
    outbound
      .prepare(
        `INSERT INTO messages_out
           (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content, in_reply_to)
         VALUES (?, ?, ?, 'chat', ?, 'web', NULL, ?, ?)`,
      )
      .run(
        'out-user-facing',
        3,
        '2026-01-01 00:00:03',
        binding.platform_id,
        JSON.stringify({ text: '**public Agent reply**' }),
        'in-user',
      );
    outbound.close();

    expect(getWebConversationHistory({ userId: 'alice', laneId: lane.id }).messages).toEqual([
      expect.objectContaining({
        id: 'in-user',
        direction: 'user',
        text: 'read the approved record',
        channel: expect.objectContaining({ type: 'web' }),
      }),
      expect.objectContaining({
        id: 'out-user-facing',
        direction: 'agent',
        text: '**public Agent reply**',
        channel: expect.objectContaining({ type: 'web' }),
      }),
    ]);
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

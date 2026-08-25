import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { wakeContainer } = vi.hoisted(() => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/agentdesk-test-interactive-web-events' };
});
vi.mock('../../container-runner.js', () => ({
  wakeContainer,
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getSession } from '../../db/sessions.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import type { PendingQuestion, Session } from '../../types.js';
import { resolvePendingQuestion } from './index.js';

const TEST_DATA_DIR = '/tmp/agentdesk-test-interactive-web-events';

function seedValidLane(): Session {
  getDb().exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('alice', 'feishu', 'Alice', '2026-01-01T00:00:00.000Z');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO conversation_lanes
      (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
      VALUES ('lane-1', 'ag-1', 'alice', NULL, 'active', '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO sessions
      (id, agent_group_id, messaging_group_id, thread_id, owner_user_id, root_session_id,
       conversation_thread_id, conversation_lane_id, agent_provider, status, container_status,
       last_active, archived_at, spawn_depth, created_at)
      VALUES
      ('session-1', 'ag-1', NULL, NULL, 'alice', 'session-1',
       NULL, 'lane-1', NULL, 'active', 'stopped', NULL, NULL, 0, '2026-01-01T00:00:00.000Z');
    UPDATE conversation_lanes SET root_session_id = 'session-1' WHERE id = 'lane-1';
  `);
  initSessionFolder('ag-1', 'session-1');
  return getSession('session-1')!;
}

function pendingQuestion(id = 'question-1'): PendingQuestion {
  return {
    question_id: id,
    session_id: 'session-1',
    message_out_id: id,
    platform_id: 'feishu:p2p:ou_alice',
    channel_type: 'feishu',
    thread_id: null,
    title: '请选择',
    options: [{ label: 'A', selectedLabel: 'A', value: 'A' }],
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  wakeContainer.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('interactive question Web refresh', () => {
  it('publishes an owning-Lane refresh only after the trusted response is persisted', async () => {
    const session = seedValidLane();

    await resolvePendingQuestion(session, pendingQuestion(), 'A', 'ou_alice');

    const event = getDb().prepare('SELECT user_id, lane_id, event_type, resource_id FROM web_events').get() as Record<
      string,
      string
    >;
    expect(event).toMatchObject({
      user_id: 'alice',
      lane_id: 'lane-1',
      event_type: 'conversation.message.available',
    });
    expect(event.resource_id).toMatch(/^qr-question-1-/);
    const inbound = openInboundDb('ag-1', 'session-1');
    const response = inbound.prepare('SELECT id, content FROM messages_in WHERE id = ?').get(event.resource_id) as {
      id: string;
      content: string;
    };
    inbound.close();
    expect(JSON.parse(response.content)).toMatchObject({
      type: 'question_response',
      questionId: 'question-1',
      selectedOption: 'A',
      userId: 'ou_alice',
    });
    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }));
  });

  it.each([
    ['missing Lane', (session: Session) => ({ ...session, conversation_lane_id: 'lane-missing' })],
    [
      'archived Lane',
      (session: Session) => {
        getDb().prepare("UPDATE conversation_lanes SET status = 'archived' WHERE id = 'lane-1'").run();
        return session;
      },
    ],
    [
      'mismatched owner',
      (session: Session) => {
        getDb()
          .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES ('bob', 'feishu', 'Bob', ?)")
          .run('2026-01-01T00:00:00.000Z');
        return { ...session, owner_user_id: 'bob' };
      },
    ],
    [
      'non-root Lane',
      (session: Session) => {
        getDb().prepare("UPDATE conversation_lanes SET root_session_id = NULL WHERE id = 'lane-1'").run();
        return session;
      },
    ],
  ])('does not publish for a %s', async (_label, mutate) => {
    const session = mutate(seedValidLane());

    await resolvePendingQuestion(session, pendingQuestion('question-invalid'), 'A', 'ou_alice');

    expect(getDb().prepare('SELECT COUNT(*) FROM web_events').pluck().get()).toBe(0);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });
});

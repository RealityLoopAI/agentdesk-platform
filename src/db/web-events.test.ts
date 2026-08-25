import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  appendWebEvent,
  clearWebEventSubscribersForTests,
  decodeWebEventCursor,
  encodeWebEventCursor,
  listWebEventsAfter,
  subscribeWebEvents,
} from './web-events.js';

const NOW = '2026-07-27T10:00:00.000Z';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('alice', 'feishu', 'Alice', '${NOW}'), ('bob', 'feishu', 'Bob', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '${NOW}', NULL);
    INSERT INTO conversation_lanes
      (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
      VALUES
      ('lane-a', 'ag-1', 'alice', NULL, 'active', '${NOW}', NULL),
      ('lane-b', 'ag-1', 'bob', NULL, 'active', '${NOW}', NULL);
  `);
});

afterEach(() => {
  clearWebEventSubscribersForTests();
  closeDb();
});

describe('durable Web events', () => {
  it('orders and replays only one canonical user’s events after an opaque cursor', () => {
    const first = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-a',
      eventType: 'conversation.message.accepted',
      resourceId: 'message-1',
      createdAt: NOW,
    }).event;
    appendWebEvent({
      userId: 'bob',
      laneId: 'lane-b',
      eventType: 'conversation.message.accepted',
      resourceId: 'message-bob',
      createdAt: NOW,
    });
    const third = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-a',
      eventType: 'conversation.message.available',
      resourceId: 'message-2',
      createdAt: NOW,
    }).event;

    const cursor = encodeWebEventCursor(first.sequence);
    expect(decodeWebEventCursor(cursor)).toEqual({ version: 1, sequence: first.sequence });
    expect(listWebEventsAfter('alice', decodeWebEventCursor(cursor).sequence)).toEqual([third]);
  });

  it('deduplicates the same resource event and publishes only after the durable insert', () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribeWebEvents('alice', subscriber);
    const first = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-a',
      eventType: 'conversation.message.available',
      resourceId: 'message-1',
    });
    const duplicate = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-a',
      eventType: 'conversation.message.available',
      resourceId: 'message-1',
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.event.event_id).toBe(first.event.event_id);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM web_events WHERE event_id = ?').get(first.event.event_id),
    ).toEqual({ count: 1 });
    unsubscribe();
  });

  it('rejects malformed cursors instead of silently replaying from an attacker-selected shape', () => {
    expect(() => decodeWebEventCursor('not-base64-json')).toThrow('invalid_event_cursor');
    expect(() =>
      decodeWebEventCursor(Buffer.from(JSON.stringify({ version: 1, sequence: -1 })).toString('base64url')),
    ).toThrow('invalid_event_cursor');
  });
});

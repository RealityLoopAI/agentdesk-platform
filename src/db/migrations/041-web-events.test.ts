import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('migration 041 web events', () => {
  it('creates a reference-only event log without transcript content', () => {
    const columns = getDb().prepare('PRAGMA table_info(web_events)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['sequence', 'event_id', 'user_id', 'lane_id', 'event_type', 'resource_id']),
    );
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['content', 'text', 'message_json', 'token', 'organization_id']),
    );
  });
});

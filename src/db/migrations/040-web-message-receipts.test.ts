import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('migration 040 web message receipts', () => {
  it('creates an idempotency-only ledger with no message content column', () => {
    const columns = getDb().prepare('PRAGMA table_info(web_message_receipts)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['user_id', 'lane_id', 'client_message_id', 'server_message_id', 'status']),
    );
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['content', 'text', 'message_json', 'token']),
    );
  });
});

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration039 } from './039-conversation-lanes.js';

function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
    CREATE TABLE messaging_groups (id TEXT PRIMARY KEY);
    CREATE TABLE user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      owner_user_id TEXT,
      root_session_id TEXT,
      status TEXT NOT NULL
    );
  `);
  return db;
}

describe('migration 039 conversation lanes (ADR-0062)', () => {
  it('adds the structural session key and NULL-safe active binding indexes', () => {
    const db = preMigrationDb();
    migration039.up(db);
    db.exec(`
      INSERT INTO users VALUES ('u-1');
      INSERT INTO agent_groups VALUES ('ag-1');
      INSERT INTO conversation_lanes
        (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
      VALUES ('lane-1', 'ag-1', 'u-1', NULL, 'active', '2026-01-01T00:00:00.000Z', NULL);
    `);
    const insert = db.prepare(
      `INSERT INTO conversation_bindings
         (id, lane_id, channel_type, messaging_group_id, platform_id, thread_id,
          external_identity_id, delivery_mode, verified_at, revoked_at)
       VALUES (?, 'lane-1', 'web', NULL, 'web:lane-1', NULL, NULL,
               'source-reply', '2026-01-01T00:00:00.000Z', ?)`,
    );
    insert.run('binding-1', null);
    expect(() => insert.run('binding-duplicate', null)).toThrow(/UNIQUE/);
    expect(() => insert.run('binding-revoked-history', '2026-01-02T00:00:00.000Z')).not.toThrow();

    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('conversation_lane_id');
  });

  it('is idempotent', () => {
    const db = preMigrationDb();
    migration039.up(db);
    expect(() => migration039.up(db)).not.toThrow();
  });
});

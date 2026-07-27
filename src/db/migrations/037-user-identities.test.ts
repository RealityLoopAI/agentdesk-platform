import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration037 } from './037-user-identities.js';

function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('migration 037 federated user identities (ADR-0061)', () => {
  it('creates scoped unique identities with a canonical-user foreign key', () => {
    const db = preMigrationDb();
    migration037.up(db);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u-1', 'feishu', null, '2026-01-01T00:00:00.000Z');

    const insert = db.prepare(
      `INSERT INTO user_identities VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const values = [
      'uid-1',
      'u-1',
      'feishu',
      'app-a',
      'open_id',
      'ou_alice',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ] as const;
    insert.run(...values);

    expect(() => insert.run('uid-2', ...values.slice(1))).toThrow(/UNIQUE/);
    expect(() =>
      insert.run(
        'uid-orphan',
        'missing-user',
        'feishu',
        'app-a',
        'open_id',
        'ou_orphan',
        values[6],
        values[7],
        values[8],
      ),
    ).toThrow(/FOREIGN KEY/);

    // The same external string in a different provider scope is distinct.
    expect(() =>
      insert.run('uid-3', 'u-1', 'feishu', 'app-b', 'open_id', 'ou_alice', values[6], values[7], values[8]),
    ).not.toThrow();
  });

  it('is idempotent', () => {
    const db = preMigrationDb();
    migration037.up(db);
    expect(() => migration037.up(db)).not.toThrow();
  });
});

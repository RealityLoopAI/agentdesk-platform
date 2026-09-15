import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

const EXPECTED_MERGED_TAIL = [
  'multi-tenant-organizations',
  'agent-group-role',
  // These names already exist in deployed local databases. File/version
  // renumbering must never change them or the migration would run twice.
  'federated-user-identities',
  'web-auth-sessions',
  'cross-channel-conversation-lanes',
  'web-message-receipts',
  'web-events',
  'cross-channel-delivery-subscriptions',
  'gateway-audit-logical-resource',
  'gateway-confirmations',
  'gateway-confirmation-delete-kind',
] as const;

describe('merged migration plan integrity', () => {
  it('preserves deployed migration names and inserts agent-group-role before local extensions', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    const names = (db.prepare('SELECT name FROM schema_version ORDER BY version').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(names.slice(-EXPECTED_MERGED_TAIL.length)).toEqual(EXPECTED_MERGED_TAIL);
    expect(new Set(names).size).toBe(names.length);
    db.close();
  });

  it('is idempotent when the complete plan is run repeatedly', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    runMigrations(db);
    const before = db.prepare('SELECT version, name, applied FROM schema_version ORDER BY version').all();
    runMigrations(db);
    const after = db.prepare('SELECT version, name, applied FROM schema_version ORDER BY version').all();

    expect(after).toEqual(before);
    db.close();
  });
});

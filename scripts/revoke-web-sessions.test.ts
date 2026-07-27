import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createWebAuthSession } from '../src/db/web-auth.js';
import { parseRevokeWebSessionArgs, revokeWebSessions } from './revoke-web-sessions.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  closeDb();
  for (const target of cleanupPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('revoke Web sessions CLI', () => {
  it('is dry-run by default and requires audited actor/reason fields', () => {
    expect(
      parseRevokeWebSessionArgs(['--all', '--actor', 'operator-1', '--reason', 'rollback'], '/tmp/test-central.db'),
    ).toEqual({
      scope: { type: 'all' },
      actor: 'operator-1',
      reason: 'rollback',
      execute: false,
      dbPath: '/tmp/test-central.db',
    });
  });

  it('supports an explicit single canonical user and execute mode', () => {
    expect(
      parseRevokeWebSessionArgs(
        [
          '--user',
          'canonical-user-alice',
          '--actor',
          'operator-1',
          '--reason',
          'offboarding',
          '--execute',
          '--db',
          '/tmp/explicit.db',
        ],
        '/tmp/default.db',
      ),
    ).toMatchObject({
      scope: { type: 'user', userId: 'canonical-user-alice' },
      execute: true,
      dbPath: '/tmp/explicit.db',
    });
  });

  it('rejects missing or ambiguous destructive scope', () => {
    expect(() => parseRevokeWebSessionArgs(['--actor', 'operator-1', '--reason', 'rollback'])).toThrow(
      /exactly one scope/,
    );
    expect(() =>
      parseRevokeWebSessionArgs([
        '--all',
        '--user',
        'canonical-user-alice',
        '--actor',
        'operator-1',
        '--reason',
        'rollback',
      ]),
    ).toThrow(/exactly one scope/);
    expect(() => parseRevokeWebSessionArgs(['--all', '--reason', 'rollback'])).toThrow(/--actor/);
  });

  it('rehearses dry-run then audited revocation of every active Web session', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-revoke-web-'));
    cleanupPaths.push(directory);
    const dbPath = path.join(directory, 'central.db');
    const secret = 'rollback-test-secret-at-least-32-bytes-long';
    const db = initDb(dbPath);
    runMigrations(db);
    db.exec(`
      INSERT INTO users (id, kind, display_name, created_at) VALUES
        ('alice', 'person', 'Alice', '2026-01-01T00:00:00.000Z'),
        ('bob', 'person', 'Bob', '2026-01-01T00:00:00.000Z');
    `);
    for (const userId of ['alice', 'bob']) {
      createWebAuthSession({
        userId,
        secret,
        policy: { idleTtlMs: 60_000, absoluteTtlMs: 3_600_000 },
        now: new Date('2026-01-01T00:00:00.000Z'),
      });
    }
    closeDb();

    const options = {
      scope: { type: 'all' as const },
      actor: 'rollback-operator',
      reason: 'unified-messaging-rollback',
      execute: false,
      dbPath,
    };
    expect(revokeWebSessions(options)).toEqual({
      candidateUsers: ['alice', 'bob'],
      revokedSessions: 0,
      executed: false,
    });

    expect(revokeWebSessions({ ...options, execute: true })).toEqual({
      candidateUsers: ['alice', 'bob'],
      revokedSessions: 2,
      executed: true,
    });

    const readOnly = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(readOnly.prepare('SELECT COUNT(*) FROM web_auth_sessions WHERE revoked_at IS NULL').pluck().get()).toBe(0);
    expect(
      readOnly.prepare("SELECT COUNT(*) FROM enterprise_audit WHERE event_type = 'web_sessions_revoked'").pluck().get(),
    ).toBe(2);
    readOnly.close();
  });
});

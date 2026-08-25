import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createSession } from '../src/db/sessions.js';
import { createUserIdentity } from '../src/db/user-identities.js';
import type { Session } from '../src/types.js';
import {
  parseReconcileFeishuConversationArgs,
  reconcileFeishuConversations,
} from './reconcile-feishu-conversations.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function seedDb(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-reconcile-feishu-'));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  const now = '2026-01-01T00:00:00.000Z';
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('alice', 'feishu', 'Alice', '${now}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '${now}', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES ('mg-1', 'feishu', 'feishu:oc_room', 'Room', 1, 'public', '${now}');
    INSERT INTO messaging_group_agents
      (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
       sender_scope, ignored_message_policy, session_mode, priority, created_at)
      VALUES ('mga-1', 'mg-1', 'ag-1', 'pattern', '.', 'all', 'drop', 'per-user', 0, '${now}');
  `);
  createUserIdentity({
    userId: 'alice',
    provider: 'feishu',
    providerScope: 'cli-app',
    identifierType: 'open_id',
    externalSubject: 'ou_alice',
  });
  createSession({
    id: 'legacy-session',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    owner_user_id: 'alice',
    root_session_id: 'legacy-session',
    conversation_thread_id: null,
    conversation_lane_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now,
    archived_at: null,
    spawn_depth: 0,
    created_at: now,
  } satisfies Session);
  closeDb();
  return dbPath;
}

describe('reconcile-feishu-conversations operator command', () => {
  it('is dry-run by default and requires canonical user, scope and actor', () => {
    expect(() => parseReconcileFeishuConversationArgs([])).toThrow('--user is required');
    expect(() => parseReconcileFeishuConversationArgs(['--user', 'alice', '--provider-scope', 'cli-app'])).toThrow(
      '--actor is required',
    );
    expect(
      parseReconcileFeishuConversationArgs(
        ['--user', 'alice', '--provider-scope', 'cli-app', '--actor', 'operator', '--limit', '25'],
        '/tmp/test-v2.db',
      ),
    ).toMatchObject({
      userId: 'alice',
      providerScope: 'cli-app',
      actor: 'operator',
      limit: 25,
      execute: false,
      dbPath: '/tmp/test-v2.db',
    });
  });

  it('reports candidates without mutation, then executes an audited deterministic backfill', () => {
    const dbPath = seedDb();
    const base = {
      userId: 'alice',
      providerScope: 'cli-app',
      agentGroupId: 'ag-1',
      actor: 'operator',
      cursor: null,
      limit: 100,
      dbPath,
    };
    const dryRun = reconcileFeishuConversations({ ...base, execute: false });
    expect(dryRun).toMatchObject({ executed: false, scanned: 1, dryRunEligible: 1, linked: 0 });

    const executed = reconcileFeishuConversations({ ...base, execute: true });
    expect(executed).toMatchObject({ executed: true, scanned: 1, linked: 1, conflicts: 0 });

    initDb(dbPath);
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(1);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) FROM enterprise_audit WHERE event_type = 'conversation_reconciliation_completed'")
        .pluck()
        .get(),
    ).toBe(2);
    closeDb();
  });
});

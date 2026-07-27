import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations, runMigrationsThroughForCompatibilityTest } from './index.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('unified messaging migration compatibility', () => {
  it('upgrades a populated pre-Web database without rewriting legacy Feishu identity or Session keys', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-unified-migration-'));
    cleanupPaths.push(directory);
    const dbPath = path.join(directory, 'central.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    // migration 034 is the last schema before organizations, federated
    // identities, Web auth, Conversation Lanes and unified delivery.
    runMigrationsThroughForCompatibilityTest(db, 'rbac-operability-roles');
    db.exec(`
      INSERT INTO users (id, kind, display_name, created_at)
        VALUES ('feishu:legacy-ou-alice', 'person', '旧飞书用户', '2026-01-01T00:00:00.000Z');
      INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
        VALUES ('legacy-agent', '旧 Agent', 'legacy-agent', NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO messaging_groups
        (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
        VALUES
        ('legacy-feishu-chat', 'feishu', 'feishu:oc_legacy', '旧飞书群', 1, 'public',
         '2026-01-01T00:00:00.000Z');
      INSERT INTO messaging_group_agents
        (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
         sender_scope, ignored_message_policy, session_mode, priority, created_at)
        VALUES
        ('legacy-wiring', 'legacy-feishu-chat', 'legacy-agent', 'pattern', '.',
         'all', 'drop', 'per-user', 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
        VALUES ('feishu:legacy-ou-alice', 'legacy-agent', NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
        VALUES ('feishu:legacy-ou-alice', 'owner', NULL, NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions
        (id, agent_group_id, messaging_group_id, thread_id, agent_provider,
         status, container_status, last_active, created_at, owner_user_id,
         root_session_id, spawn_depth, conversation_thread_id, archived_at)
        VALUES
        ('legacy-feishu-session', 'legacy-agent', 'legacy-feishu-chat', NULL, NULL,
         'active', 'stopped', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
         'feishu:legacy-ou-alice', 'legacy-feishu-session', 0, NULL, NULL);
    `);

    runMigrations(db);

    expect(db.prepare('SELECT id FROM users').pluck().all()).toContain('feishu:legacy-ou-alice');
    expect(
      db
        .prepare(
          `SELECT owner_user_id, messaging_group_id, conversation_lane_id
           FROM sessions WHERE id = 'legacy-feishu-session'`,
        )
        .get(),
    ).toEqual({
      owner_user_id: 'feishu:legacy-ou-alice',
      messaging_group_id: 'legacy-feishu-chat',
      conversation_lane_id: null,
    });
    expect(db.prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(0);
    expect(
      db
        .prepare(
          `SELECT agent_group_id, organization_id
           FROM user_roles WHERE user_id = 'feishu:legacy-ou-alice' AND role = 'owner'`,
        )
        .get(),
    ).toEqual({ agent_group_id: null, organization_id: null });

    // NULL organization remains a supported legacy compatibility state after
    // migration. Organization is still derived Host-side and never sent to the
    // Backend Gateway.
    db.prepare(
      `INSERT INTO agent_groups
         (id, name, folder, agent_provider, created_at, organization_id)
       VALUES ('legacy-null-org', '兼容 Agent', 'legacy-null-org', NULL, ?, NULL)`,
    ).run('2026-01-02T00:00:00.000Z');
    expect(
      db.prepare("SELECT organization_id FROM agent_groups WHERE id = 'legacy-null-org'").pluck().get(),
    ).toBeNull();

    // Populate additive Web/Lane state to prove that an emergency code rollback
    // can leave it in place. The old reader below deliberately knows none of
    // these tables or columns.
    db.exec(`
      INSERT INTO conversation_lanes
        (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
      VALUES
        ('lane-after-upgrade', 'legacy-agent', 'feishu:legacy-ou-alice', NULL,
         'active', '2026-01-02T00:00:00.000Z', NULL);
      INSERT INTO web_auth_sessions
        (id_hash, user_id, csrf_hash, created_at, last_seen_at, idle_expires_at,
         absolute_expires_at, revoked_at, auth_context_hash)
      VALUES
        ('session-hash', 'feishu:legacy-ou-alice', 'csrf-hash',
         '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
         '2026-01-02T01:00:00.000Z', '2026-01-03T00:00:00.000Z', NULL, NULL);
    `);
    db.close();

    const oldReadOnlyProcess = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(
      oldReadOnlyProcess
        .prepare(
          `SELECT id, agent_group_id, messaging_group_id, thread_id, owner_user_id, status
           FROM sessions WHERE id = 'legacy-feishu-session'`,
        )
        .get(),
    ).toEqual({
      id: 'legacy-feishu-session',
      agent_group_id: 'legacy-agent',
      messaging_group_id: 'legacy-feishu-chat',
      thread_id: null,
      owner_user_id: 'feishu:legacy-ou-alice',
      status: 'active',
    });
    expect(
      oldReadOnlyProcess
        .prepare(
          `SELECT id, channel_type, platform_id
           FROM messaging_groups WHERE id = 'legacy-feishu-chat'`,
        )
        .get(),
    ).toEqual({
      id: 'legacy-feishu-chat',
      channel_type: 'feishu',
      platform_id: 'feishu:oc_legacy',
    });
    oldReadOnlyProcess.close();
  });
});

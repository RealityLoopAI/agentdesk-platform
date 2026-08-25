import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations, runMigrationsThroughForCompatibilityTest } from './index.js';

describe('Gateway confirmation Delete-kind migration', () => {
  it('preserves existing Pending rows and accepts Delete after upgrade', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsThroughForCompatibilityTest(db, 'gateway-confirmations');
    db.exec(`
      INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('feishu:ou_requester', 'feishu', 'Requester', '2026-07-30T08:00:00.000Z');
      INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
      VALUES ('ag-1', 'Agent', 'agent', NULL, '2026-07-30T08:00:00.000Z');
      INSERT INTO sessions
        (id, agent_group_id, messaging_group_id, thread_id, agent_provider,
         status, container_status, last_active, created_at, owner_user_id,
         root_session_id, spawn_depth, conversation_thread_id, archived_at,
         conversation_lane_id)
      VALUES
        ('session-1', 'ag-1', NULL, NULL, NULL, 'active', 'idle',
         '2026-07-30T08:00:00.000Z', '2026-07-30T08:00:00.000Z',
         'feishu:ou_requester', 'session-1', 0, NULL, NULL, NULL);
      INSERT INTO pending_gateway_confirmations
        (confirmation_id, session_id, message_out_id, kind, requester_user_id,
         agent_group_id, conversation_lane_id, channel_type, platform_id, thread_id,
         confirmation_request, display_json, title, options_json, created_at,
         expires_at, status, resolved_at, error_code)
      VALUES
        ('confirm-update', 'session-1', 'message-update', 'update',
         'feishu:ou_requester', 'ag-1', NULL, 'feishu',
         'feishu:p2p:ou_requester', NULL, 'opaque-update', '{"recordId":"rec-1"}',
         'Confirm update', '[]', '2026-07-30T08:00:00.000Z',
         '2026-07-30T08:15:00.000Z', 'pending', NULL, NULL);
    `);

    runMigrations(db);

    expect(
      db
        .prepare(
          `SELECT kind, confirmation_request, status
           FROM pending_gateway_confirmations WHERE confirmation_id = 'confirm-update'`,
        )
        .get(),
    ).toEqual({ kind: 'update', confirmation_request: 'opaque-update', status: 'pending' });
    expect(() =>
      db
        .prepare(
          `INSERT INTO pending_gateway_confirmations
            (confirmation_id, session_id, message_out_id, kind, requester_user_id,
             agent_group_id, conversation_lane_id, channel_type, platform_id, thread_id,
             confirmation_request, display_json, title, options_json, created_at,
             expires_at, status, resolved_at, error_code)
           VALUES (?, ?, ?, 'delete', ?, ?, NULL, 'feishu', ?, NULL, ?, ?, ?, '[]', ?, ?, 'pending', NULL, NULL)`,
        )
        .run(
          'confirm-delete',
          'session-1',
          'message-delete',
          'feishu:ou_requester',
          'ag-1',
          'feishu:p2p:ou_requester',
          'opaque-delete',
          '{"recordId":"rec-delete"}',
          'Confirm delete',
          '2026-07-30T08:00:00.000Z',
          '2026-07-30T08:15:00.000Z',
        ),
    ).not.toThrow();
    db.close();
  });
});

import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Extend the Host-owned confirmation broker with the Delete intent introduced
 * by ADR-0075. SQLite cannot alter a CHECK constraint in place, so preserve
 * every row while rebuilding the table with the expanded kind domain.
 */
export const migration045: Migration = {
  version: 45,
  name: 'gateway-confirmation-delete-kind',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE pending_gateway_confirmations_next (
        confirmation_id      TEXT PRIMARY KEY,
        session_id           TEXT NOT NULL REFERENCES sessions(id),
        message_out_id       TEXT NOT NULL UNIQUE,
        kind                 TEXT NOT NULL CHECK(kind IN ('update', 'create', 'delete')),
        requester_user_id    TEXT NOT NULL REFERENCES users(id),
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
        conversation_lane_id TEXT REFERENCES conversation_lanes(id),
        channel_type         TEXT NOT NULL,
        platform_id          TEXT NOT NULL,
        thread_id            TEXT,
        confirmation_request TEXT,
        display_json         TEXT NOT NULL,
        title                TEXT NOT NULL,
        options_json         TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        expires_at           TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending', 'issuing', 'approved', 'rejected', 'expired', 'failed')),
        resolved_at          TEXT,
        error_code           TEXT
      );

      INSERT INTO pending_gateway_confirmations_next
        (confirmation_id, session_id, message_out_id, kind, requester_user_id,
         agent_group_id, conversation_lane_id, channel_type, platform_id, thread_id,
         confirmation_request, display_json, title, options_json, created_at,
         expires_at, status, resolved_at, error_code)
      SELECT confirmation_id, session_id, message_out_id, kind, requester_user_id,
             agent_group_id, conversation_lane_id, channel_type, platform_id, thread_id,
             confirmation_request, display_json, title, options_json, created_at,
             expires_at, status, resolved_at, error_code
      FROM pending_gateway_confirmations;

      DROP TABLE pending_gateway_confirmations;
      ALTER TABLE pending_gateway_confirmations_next RENAME TO pending_gateway_confirmations;

      CREATE INDEX idx_pending_gateway_confirmations_actor
        ON pending_gateway_confirmations(requester_user_id, status, expires_at);
      CREATE INDEX idx_pending_gateway_confirmations_lane
        ON pending_gateway_confirmations(conversation_lane_id, requester_user_id, status);
    `);
  },
};

import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Host-owned, durable confirmation broker state (ADR-0073).
 *
 * The container can request an interaction only through outbound.db. The Host
 * resolves the exact triggering inbound row, stores the canonical actor and
 * route here, and is the only writer of status transitions. Gateway execution
 * tokens are never persisted in this table.
 */
export const migration044: Migration = {
  version: 44,
  name: 'gateway-confirmations',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE pending_gateway_confirmations (
        confirmation_id      TEXT PRIMARY KEY,
        session_id           TEXT NOT NULL REFERENCES sessions(id),
        message_out_id       TEXT NOT NULL UNIQUE,
        kind                 TEXT NOT NULL CHECK(kind IN ('update', 'create')),
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

      CREATE INDEX idx_pending_gateway_confirmations_actor
        ON pending_gateway_confirmations(requester_user_id, status, expires_at);
      CREATE INDEX idx_pending_gateway_confirmations_lane
        ON pending_gateway_confirmations(conversation_lane_id, requester_user_id, status);
    `);
  },
};

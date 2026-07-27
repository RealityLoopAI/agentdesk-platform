import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Durable Web client-message idempotency receipts (ADR-0062).
 *
 * The browser supplies a stable client_message_id, but never a canonical user,
 * Session, or routing address. The Host binds the id to the authenticated user
 * and authorized Lane before entering the normal persist-before-route path.
 *
 * Message text is deliberately absent: the Session inbound/outbound DB pair
 * remains the only transcript source of truth.
 */
export const migration040: Migration = {
  version: 40,
  name: 'web-message-receipts',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_message_receipts (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id),
        lane_id           TEXT NOT NULL REFERENCES conversation_lanes(id),
        client_message_id TEXT NOT NULL,
        server_message_id TEXT NOT NULL,
        status            TEXT NOT NULL
                          CHECK(status IN ('routing', 'accepted', 'failed')),
        created_at        TEXT NOT NULL,
        completed_at      TEXT,
        failure_code      TEXT,
        UNIQUE(user_id, lane_id, client_message_id),
        UNIQUE(server_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_web_message_receipts_lane
        ON web_message_receipts(user_id, lane_id, created_at);
    `);
  },
};

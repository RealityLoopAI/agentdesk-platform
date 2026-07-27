import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Durable Web notification log (ADR-0062).
 *
 * Rows point at already-persisted Session resources; they deliberately do not
 * copy message bodies. The AUTOINCREMENT sequence is an internal ordering key
 * that is exposed to browsers only through an opaque cursor.
 */
export const migration041: Migration = {
  version: 41,
  name: 'web-events',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_events (
        sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id    TEXT NOT NULL UNIQUE,
        user_id     TEXT NOT NULL REFERENCES users(id),
        lane_id     TEXT NOT NULL REFERENCES conversation_lanes(id),
        event_type  TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(user_id, lane_id, event_type, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_web_events_user_sequence
        ON web_events(user_id, sequence);
    `);
  },
};

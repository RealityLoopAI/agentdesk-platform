import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * User-owned cross-channel conversation structure (ADR-0062).
 *
 * Organization is intentionally absent: tenancy is derived from the lane's
 * immutable agent_group_id and enforced by the Host access gate.
 */
export const migration039: Migration = {
  version: 39,
  name: 'cross-channel-conversation-lanes',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_lanes (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
        owner_user_id   TEXT NOT NULL REFERENCES users(id),
        root_session_id TEXT REFERENCES sessions(id),
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'archived')),
        created_at      TEXT NOT NULL,
        archived_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_lanes_owner
        ON conversation_lanes(owner_user_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_lanes_agent_owner
        ON conversation_lanes(agent_group_id, owner_user_id, status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_lanes_root
        ON conversation_lanes(root_session_id)
        WHERE root_session_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS conversation_bindings (
        id                   TEXT PRIMARY KEY,
        lane_id              TEXT NOT NULL REFERENCES conversation_lanes(id),
        channel_type         TEXT NOT NULL,
        messaging_group_id   TEXT REFERENCES messaging_groups(id),
        platform_id          TEXT NOT NULL,
        thread_id            TEXT,
        external_identity_id TEXT REFERENCES user_identities(id),
        delivery_mode        TEXT NOT NULL
                             CHECK(delivery_mode IN ('history-only', 'source-reply', 'mirror-dm')),
        verified_at          TEXT NOT NULL,
        revoked_at           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_lane
        ON conversation_bindings(lane_id, revoked_at);

      -- SQLite treats NULL values as distinct in a normal UNIQUE index. Four
      -- partial indexes make each nullable key shape unambiguous while only
      -- constraining active bindings; revoked history remains auditable.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_binding_active_no_thread_no_identity
        ON conversation_bindings(channel_type, platform_id)
        WHERE thread_id IS NULL AND external_identity_id IS NULL AND revoked_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_binding_active_no_thread_identity
        ON conversation_bindings(channel_type, platform_id, external_identity_id)
        WHERE thread_id IS NULL AND external_identity_id IS NOT NULL AND revoked_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_binding_active_thread_no_identity
        ON conversation_bindings(channel_type, platform_id, thread_id)
        WHERE thread_id IS NOT NULL AND external_identity_id IS NULL AND revoked_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_binding_active_thread_identity
        ON conversation_bindings(channel_type, platform_id, thread_id, external_identity_id)
        WHERE thread_id IS NOT NULL AND external_identity_id IS NOT NULL AND revoked_at IS NULL;
    `);

    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === 'conversation_lane_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN conversation_lane_id TEXT REFERENCES conversation_lanes(id);');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation_lane
        ON sessions(conversation_lane_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_conversation_lane_root
        ON sessions(conversation_lane_id)
        WHERE conversation_lane_id IS NOT NULL AND id = root_session_id;
    `);
  },
};

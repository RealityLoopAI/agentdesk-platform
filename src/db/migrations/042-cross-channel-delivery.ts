import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Explicit Feishu DM subscriptions and their reference-only delivery ledger
 * (ADR-0062). Message bodies remain exclusively in the Session DB pair.
 */
export const migration042: Migration = {
  version: 42,
  name: 'cross-channel-delivery-subscriptions',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_subscriptions (
        id                   TEXT PRIMARY KEY,
        lane_id              TEXT NOT NULL REFERENCES conversation_lanes(id),
        channel_type         TEXT NOT NULL CHECK(channel_type = 'feishu'),
        delivery_kind        TEXT NOT NULL CHECK(delivery_kind = 'agent-reply-mirror'),
        platform_id          TEXT NOT NULL CHECK(platform_id GLOB 'feishu:p2p:ou_*'),
        external_identity_id TEXT NOT NULL REFERENCES user_identities(id),
        provider_scope       TEXT NOT NULL,
        enabled_at           TEXT NOT NULL,
        revoked_at           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_subscriptions_lane
        ON delivery_subscriptions(lane_id, revoked_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_subscription_active_lane_kind
        ON delivery_subscriptions(lane_id, channel_type, delivery_kind)
        WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS cross_channel_deliveries (
        id                  TEXT PRIMARY KEY,
        origin_id           TEXT NOT NULL,
        subscription_id     TEXT NOT NULL REFERENCES delivery_subscriptions(id),
        lane_id             TEXT NOT NULL REFERENCES conversation_lanes(id),
        session_id          TEXT NOT NULL REFERENCES sessions(id),
        message_out_id      TEXT NOT NULL,
        channel_type        TEXT NOT NULL CHECK(channel_type = 'feishu'),
        platform_id         TEXT NOT NULL CHECK(platform_id GLOB 'feishu:p2p:ou_*'),
        status              TEXT NOT NULL
                            CHECK(status IN ('pending', 'delivered', 'failed', 'suppressed')),
        attempts            INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_retry_at       TEXT,
        platform_message_id TEXT,
        failure_code        TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        delivered_at        TEXT,
        UNIQUE(subscription_id, session_id, message_out_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cross_channel_deliveries_due
        ON cross_channel_deliveries(session_id, status, next_retry_at, created_at);
    `);
  },
};

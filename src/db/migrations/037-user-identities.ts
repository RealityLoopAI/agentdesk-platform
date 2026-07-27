import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Federated user identities (ADR-0061).
 *
 * `users` remains the canonical authorization subject referenced by roles,
 * memberships, sessions and audit rows. This table only maps a provider-
 * verified external subject onto that canonical user; it never stores OAuth
 * tokens or other provider credentials.
 *
 * `provider_scope` is deliberately part of the unique key. Feishu `open_id`
 * values are application-scoped, so comparing two of them without the app
 * scope could merge unrelated people.
 */
export const migration037: Migration = {
  version: 37,
  name: 'federated-user-identities',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_identities (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id),
        provider         TEXT NOT NULL,
        provider_scope   TEXT NOT NULL,
        identifier_type  TEXT NOT NULL,
        external_subject TEXT NOT NULL,
        verified_at      TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        last_seen_at     TEXT NOT NULL,
        UNIQUE(provider, provider_scope, identifier_type, external_subject)
      );

      CREATE INDEX IF NOT EXISTS idx_user_identities_user
        ON user_identities(user_id);
    `);
  },
};

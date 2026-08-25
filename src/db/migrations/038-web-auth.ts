import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Server-side Web authentication state (ADR-0061/0062).
 *
 * Browser cookies contain random opaque tokens. Only keyed hashes are stored
 * here, so a database read does not reveal a usable browser credential.
 * OAuth authorization codes and provider access/refresh tokens are never
 * persisted.
 */
export const migration038: Migration = {
  version: 38,
  name: 'web-auth-sessions',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_auth_sessions (
        id_hash             TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id),
        csrf_hash           TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        last_seen_at        TEXT NOT NULL,
        idle_expires_at     TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at          TEXT,
        auth_context_hash   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_web_auth_sessions_user
        ON web_auth_sessions(user_id, revoked_at, absolute_expires_at);

      CREATE TABLE IF NOT EXISTS web_auth_transactions (
        state_hash                 TEXT PRIMARY KEY,
        browser_nonce_hash         TEXT NOT NULL,
        pkce_verifier_ciphertext   TEXT,
        redirect_uri               TEXT NOT NULL,
        created_at                 TEXT NOT NULL,
        expires_at                 TEXT NOT NULL,
        used_at                    TEXT,
        authorization_code_hash    TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_web_auth_transactions_expiry
        ON web_auth_transactions(expires_at, used_at);
    `);
  },
};

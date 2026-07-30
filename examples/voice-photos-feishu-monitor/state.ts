import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { normalizeFeishuRequestUuid } from '../../src/channels/feishu/outbound-image.js';
import type { FileSnapshot, ValidatedImage } from './scanner.js';
import { eventIdFor, snapshotFingerprint } from './scanner.js';

export type DeliveryStatus = 'ready' | 'sending' | 'retry_wait' | 'delivered' | 'terminal_failure';

export interface DeliveryEvent {
  id: string;
  relativePath: string;
  digest: string;
  size: number;
  mtimeMs: number;
  status: DeliveryStatus;
  attempts: number;
  providerUuid: string;
}

interface ObservationRow {
  relative_path: string;
  fingerprint: string;
  stable_count: number;
  state: 'baseline' | 'observed' | 'processed' | 'invalid';
}

interface EventRow {
  id: string;
  relative_path: string;
  digest: string;
  size: number;
  mtime_ms: number;
  status: DeliveryStatus;
  attempts: number;
  provider_uuid: string;
}

function toEvent(row: EventRow): DeliveryEvent {
  return {
    id: row.id,
    relativePath: row.relative_path,
    digest: row.digest,
    size: row.size,
    mtimeMs: row.mtime_ms,
    status: row.status,
    attempts: row.attempts,
    providerUuid: row.provider_uuid,
  };
}

export class VoicePhotoState {
  readonly ownerId = randomUUID();
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_metadata (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        relative_path TEXT PRIMARY KEY,
        fingerprint   TEXT NOT NULL,
        dev           TEXT NOT NULL,
        ino           TEXT NOT NULL,
        size          INTEGER NOT NULL,
        mtime_ms      REAL NOT NULL,
        ctime_ms      REAL NOT NULL,
        stable_count  INTEGER NOT NULL,
        state         TEXT NOT NULL CHECK(state IN ('baseline', 'observed', 'processed', 'invalid')),
        content_digest TEXT,
        failure_code  TEXT,
        first_seen_at INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_events (
        id                  TEXT PRIMARY KEY,
        relative_path       TEXT NOT NULL,
        digest              TEXT NOT NULL,
        size                INTEGER NOT NULL,
        mtime_ms            REAL NOT NULL,
        status              TEXT NOT NULL CHECK(status IN ('ready', 'sending', 'retry_wait', 'delivered', 'terminal_failure')),
        attempts            INTEGER NOT NULL DEFAULT 0,
        provider_uuid       TEXT NOT NULL,
        provider_message_id TEXT,
        failure_code        TEXT,
        next_retry_at       INTEGER,
        lease_until         INTEGER,
        last_attempt_at     INTEGER,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        delivered_at        INTEGER,
        UNIQUE(relative_path, digest)
      );
      CREATE INDEX IF NOT EXISTS idx_voice_photo_events_due
        ON notification_events(status, next_retry_at, created_at);

      CREATE TABLE IF NOT EXISTS process_lease (
        id         INTEGER PRIMARY KEY CHECK(id = 1),
        owner_id   TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  isBaselineComplete(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM monitor_metadata WHERE key = 'baseline_completed_at'").get());
  }

  baselineCompletedAt(): number | null {
    const row = this.db.prepare("SELECT value FROM monitor_metadata WHERE key = 'baseline_completed_at'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  }

  commitBaseline(snapshots: FileSnapshot[], now: number): void {
    const insert = this.db.prepare(`
      INSERT INTO observations
        (relative_path, fingerprint, dev, ino, size, mtime_ms, ctime_ms, stable_count, state, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'baseline', ?, ?)
      ON CONFLICT(relative_path) DO NOTHING
    `);
    this.db.transaction(() => {
      for (const snapshot of snapshots) {
        insert.run(
          snapshot.relativePath,
          snapshotFingerprint(snapshot),
          snapshot.dev,
          snapshot.ino,
          snapshot.size,
          snapshot.mtimeMs,
          snapshot.ctimeMs,
          now,
          now,
        );
      }
      this.db
        .prepare(
          `
          INSERT INTO monitor_metadata (key, value, updated_at)
          VALUES ('baseline_completed_at', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `,
        )
        .run(String(now), now);
    })();
  }

  observe(snapshot: FileSnapshot, stabilityScans: number, now: number): boolean {
    const fingerprint = snapshotFingerprint(snapshot);
    const existing = this.db
      .prepare('SELECT relative_path, fingerprint, stable_count, state FROM observations WHERE relative_path = ?')
      .get(snapshot.relativePath) as ObservationRow | undefined;

    if (!existing || existing.fingerprint !== fingerprint) {
      this.db
        .prepare(
          `
          INSERT INTO observations
            (relative_path, fingerprint, dev, ino, size, mtime_ms, ctime_ms, stable_count, state, content_digest, failure_code, first_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'observed', NULL, NULL, ?, ?)
          ON CONFLICT(relative_path) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            dev = excluded.dev,
            ino = excluded.ino,
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            ctime_ms = excluded.ctime_ms,
            stable_count = 1,
            state = 'observed',
            content_digest = NULL,
            failure_code = NULL,
            first_seen_at = excluded.first_seen_at,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          snapshot.relativePath,
          fingerprint,
          snapshot.dev,
          snapshot.ino,
          snapshot.size,
          snapshot.mtimeMs,
          snapshot.ctimeMs,
          now,
          now,
        );
      return stabilityScans <= 1;
    }

    if (existing.state !== 'observed') return false;
    const nextCount = Math.min(stabilityScans, existing.stable_count + 1);
    this.db
      .prepare('UPDATE observations SET stable_count = ?, updated_at = ? WHERE relative_path = ?')
      .run(nextCount, now, snapshot.relativePath);
    return existing.stable_count < stabilityScans && nextCount >= stabilityScans;
  }

  resetObservation(snapshot: FileSnapshot, now: number): void {
    this.db
      .prepare(
        `
        UPDATE observations
        SET fingerprint = ?,
            dev = ?,
            ino = ?,
            size = ?,
            mtime_ms = ?,
            ctime_ms = ?,
            stable_count = 0,
            state = 'observed',
            content_digest = NULL,
            failure_code = NULL,
            updated_at = ?
        WHERE relative_path = ?
      `,
      )
      .run(
        snapshotFingerprint(snapshot),
        snapshot.dev,
        snapshot.ino,
        snapshot.size,
        snapshot.mtimeMs,
        snapshot.ctimeMs,
        now,
        snapshot.relativePath,
      );
  }

  recordReady(image: ValidatedImage, now: number): string {
    const eventId = eventIdFor(image.relativePath, image.digest);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO notification_events
            (id, relative_path, digest, size, mtime_ms, status, provider_uuid, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
        `,
        )
        .run(
          eventId,
          image.relativePath,
          image.digest,
          image.size,
          image.mtimeMs,
          normalizeFeishuRequestUuid(eventId),
          now,
          now,
        );
      this.db
        .prepare(
          `
          UPDATE observations
          SET state = 'processed', content_digest = ?, failure_code = NULL, updated_at = ?
          WHERE relative_path = ?
        `,
        )
        .run(image.digest, now, image.relativePath);
    })();
    return eventId;
  }

  recordValidationFailure(snapshot: FileSnapshot, code: string, now: number): void {
    const digest = `invalid:${snapshotFingerprint(snapshot)}:${code}`;
    const eventId = eventIdFor(snapshot.relativePath, digest);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO notification_events
            (id, relative_path, digest, size, mtime_ms, status, provider_uuid, failure_code, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'terminal_failure', ?, ?, ?, ?)
        `,
        )
        .run(
          eventId,
          snapshot.relativePath,
          digest,
          snapshot.size,
          snapshot.mtimeMs,
          normalizeFeishuRequestUuid(eventId),
          code,
          now,
          now,
        );
      this.db
        .prepare(
          `
          UPDATE observations
          SET state = 'invalid', failure_code = ?, updated_at = ?
          WHERE relative_path = ?
        `,
        )
        .run(code, now, snapshot.relativePath);
    })();
  }

  claimDue(limit: number, leaseMs: number, now: number): DeliveryEvent[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `
          SELECT id, relative_path, digest, size, mtime_ms, status, attempts, provider_uuid
          FROM notification_events
          WHERE status = 'ready'
             OR (status = 'retry_wait' AND COALESCE(next_retry_at, 0) <= ?)
             OR (status = 'sending' AND COALESCE(lease_until, 0) <= ?)
          ORDER BY created_at, id
          LIMIT ?
        `,
        )
        .all(now, now, limit) as EventRow[];
      const claim = this.db.prepare(`
        UPDATE notification_events
        SET status = 'sending',
            attempts = attempts + 1,
            last_attempt_at = ?,
            lease_until = ?,
            updated_at = ?
        WHERE id = ?
      `);
      for (const row of rows) claim.run(now, now + leaseMs, now, row.id);
      return rows.map((row) => toEvent({ ...row, status: 'sending', attempts: row.attempts + 1 }));
    })();
  }

  markDelivered(eventId: string, providerMessageId: string | undefined, now: number): void {
    this.db
      .prepare(
        `
        UPDATE notification_events
        SET status = 'delivered',
            provider_message_id = ?,
            failure_code = NULL,
            next_retry_at = NULL,
            lease_until = NULL,
            delivered_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(providerMessageId ?? null, now, now, eventId);
  }

  markRetry(eventId: string, failureCode: string, nextRetryAt: number, now: number): void {
    this.db
      .prepare(
        `
        UPDATE notification_events
        SET status = 'retry_wait',
            failure_code = ?,
            next_retry_at = ?,
            lease_until = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(failureCode, nextRetryAt, now, eventId);
  }

  markTerminal(eventId: string, failureCode: string, now: number): void {
    this.db
      .prepare(
        `
        UPDATE notification_events
        SET status = 'terminal_failure',
            failure_code = ?,
            next_retry_at = NULL,
            lease_until = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(failureCode, now, eventId);
  }

  attemptsSince(timestamp: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM notification_events WHERE last_attempt_at >= ?')
      .get(timestamp) as { count: number };
    return row.count;
  }

  queueDepth(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM notification_events WHERE status IN ('ready', 'sending', 'retry_wait')")
      .get() as { count: number };
    return row.count;
  }

  getEvent(eventId: string): DeliveryEvent | null {
    const row = this.db
      .prepare(
        `
        SELECT id, relative_path, digest, size, mtime_ms, status, attempts, provider_uuid
        FROM notification_events WHERE id = ?
      `,
      )
      .get(eventId) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  listEvents(): DeliveryEvent[] {
    return (
      this.db
        .prepare(
          `
          SELECT id, relative_path, digest, size, mtime_ms, status, attempts, provider_uuid
          FROM notification_events ORDER BY created_at, id
        `,
        )
        .all() as EventRow[]
    ).map(toEvent);
  }

  acquireLease(leaseMs: number, now: number): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT owner_id, expires_at FROM process_lease WHERE id = 1').get() as
        | { owner_id: string; expires_at: number }
        | undefined;
      if (current && current.owner_id !== this.ownerId && current.expires_at > now) return false;
      this.db
        .prepare(
          `
          INSERT INTO process_lease (id, owner_id, expires_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at
        `,
        )
        .run(this.ownerId, now + leaseMs);
      return true;
    })();
  }

  refreshLease(leaseMs: number, now: number): boolean {
    const result = this.db
      .prepare('UPDATE process_lease SET expires_at = ? WHERE id = 1 AND owner_id = ?')
      .run(now + leaseMs, this.ownerId);
    return result.changes === 1;
  }

  releaseLease(): void {
    this.db.prepare('DELETE FROM process_lease WHERE id = 1 AND owner_id = ?').run(this.ownerId);
  }
}

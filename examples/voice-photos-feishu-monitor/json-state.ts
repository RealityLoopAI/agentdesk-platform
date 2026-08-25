import Database from 'better-sqlite3';

import type { JsonSnapshot, QualifiedJsonFile } from './json-scanner.js';
import { jsonSnapshotFingerprint } from './json-scanner.js';

export class VoicePhotoJsonState {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS json_monitor_metadata (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS json_observations (
        relative_path TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        stable_count INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('baseline','observed','submitted','invalid')),
        digest TEXT,
        failure_code TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS json_ingest_events (
        digest TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('submitted','verified','failed')),
        record_id TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    const eventColumns = this.db.prepare('PRAGMA table_info(json_ingest_events)').all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === 'record_id')) {
      this.db.exec('ALTER TABLE json_ingest_events ADD COLUMN record_id TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  baselineComplete(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM json_monitor_metadata WHERE key='baseline-v1'").get());
  }

  commitBaseline(snapshots: JsonSnapshot[], now: number): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO json_observations
       (relative_path,fingerprint,stable_count,state,updated_at) VALUES (?, ?, 0, 'baseline', ?)`,
    );
    this.db.transaction(() => {
      for (const snapshot of snapshots) insert.run(snapshot.relativePath, jsonSnapshotFingerprint(snapshot), now);
      this.db
        .prepare("INSERT OR REPLACE INTO json_monitor_metadata(key,value) VALUES('baseline-v1',?)")
        .run(String(now));
    })();
  }

  stable(snapshot: JsonSnapshot, required: number, now: number): boolean {
    const fingerprint = jsonSnapshotFingerprint(snapshot);
    const row = this.db
      .prepare('SELECT fingerprint, stable_count, state FROM json_observations WHERE relative_path=?')
      .get(snapshot.relativePath) as { fingerprint: string; stable_count: number; state: string } | undefined;
    if (!row || row.fingerprint !== fingerprint) {
      this.db
        .prepare(
          `INSERT INTO json_observations(relative_path,fingerprint,stable_count,state,updated_at)
           VALUES(?,?,1,'observed',?)
           ON CONFLICT(relative_path) DO UPDATE SET fingerprint=excluded.fingerprint,
             stable_count=1,state='observed',digest=NULL,failure_code=NULL,updated_at=excluded.updated_at`,
        )
        .run(snapshot.relativePath, fingerprint, now);
      return false;
    }
    if (row.state !== 'observed') return false;
    const count = Math.min(required, row.stable_count + 1);
    this.db
      .prepare('UPDATE json_observations SET stable_count=?,updated_at=? WHERE relative_path=?')
      .run(count, now, snapshot.relativePath);
    return row.stable_count < required && count >= required;
  }

  invalid(snapshot: JsonSnapshot, code: string, now: number): void {
    this.db
      .prepare("UPDATE json_observations SET state='invalid',failure_code=?,updated_at=? WHERE relative_path=?")
      .run(code.slice(0, 128), now, snapshot.relativePath);
  }

  submitted(file: QualifiedJsonFile, idempotencyKey: string, now: number): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO json_ingest_events(digest,relative_path,idempotency_key,status,updated_at)
         VALUES(?,?,?,'submitted',?)`,
        )
        .run(file.digest, file.relativePath, idempotencyKey, now);
      this.db
        .prepare("UPDATE json_observations SET state='submitted',digest=?,updated_at=? WHERE relative_path=?")
        .run(file.digest, now, file.relativePath);
      return result.changes === 1;
    })();
  }

  mark(digest: string, status: 'verified' | 'failed', now: number, recordId?: string): void {
    this.db
      .prepare('UPDATE json_ingest_events SET status=?,record_id=?,updated_at=? WHERE digest=?')
      .run(status, recordId ?? null, now, digest);
  }

  retry(digest: string, now: number): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT relative_path FROM json_ingest_events WHERE digest=?').get(digest) as
        | { relative_path: string }
        | undefined;
      if (!row) return;
      this.db.prepare('DELETE FROM json_ingest_events WHERE digest=?').run(digest);
      this.db
        .prepare(
          "UPDATE json_observations SET state='observed',stable_count=0,digest=NULL,updated_at=? WHERE relative_path=?",
        )
        .run(now, row.relative_path);
    })();
  }
}

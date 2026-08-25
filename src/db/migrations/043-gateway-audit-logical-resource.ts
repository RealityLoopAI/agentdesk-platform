import type Database from 'better-sqlite3';
import { hasTable } from '../connection.js';
import type { Migration } from './index.js';

/**
 * Store the operator-defined logical resource alias for Backend Gateway calls.
 *
 * The alias is intentionally not a Feishu app_token/table_id. It is safe,
 * bounded audit metadata such as `sales-orders`; the Gateway remains the only
 * component allowed to resolve it to real business-system identifiers.
 */
export const migration043: Migration = {
  version: 43,
  name: 'gateway-audit-logical-resource',
  up: (db: Database.Database) => {
    if (!hasTable(db, 'gateway_audit')) return;
    const columns = new Set(
      (db.prepare('PRAGMA table_info(gateway_audit)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has('logical_resource')) {
      db.exec('ALTER TABLE gateway_audit ADD COLUMN logical_resource TEXT');
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_gateway_audit_logical_resource ON gateway_audit(logical_resource, occurred_at)',
    );
  },
};

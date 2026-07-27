import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('migration 042 cross-channel delivery subscriptions', () => {
  it('creates explicit subscription and reference-only delivery tables', () => {
    const subscriptionColumns = getDb().prepare('PRAGMA table_info(delivery_subscriptions)').all() as Array<{
      name: string;
    }>;
    expect(subscriptionColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'lane_id',
        'channel_type',
        'delivery_kind',
        'platform_id',
        'external_identity_id',
        'provider_scope',
        'enabled_at',
        'revoked_at',
      ]),
    );

    const deliveryColumns = getDb().prepare('PRAGMA table_info(cross_channel_deliveries)').all() as Array<{
      name: string;
    }>;
    expect(deliveryColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'origin_id',
        'subscription_id',
        'lane_id',
        'session_id',
        'message_out_id',
        'status',
        'attempts',
        'next_retry_at',
      ]),
    );
    expect(deliveryColumns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['content', 'text', 'message_json', 'token', 'organization_id']),
    );
  });
});

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { queryGatewayAudit } from '../../db/gateway-audit.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import { feishuBitableOperationsTotal } from '../../metrics.js';
import type { Session } from '../../types.js';

/** A minimal host-written inbound.db carrying the given namespaced origins —
 *  the "legitimate identity set" the actor is cross-validated against. */
function fakeInboundDb(origins: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE messages_in (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, origin_user_id TEXT, content TEXT, channel_type TEXT)',
  );
  const ins = db.prepare(
    "INSERT INTO messages_in (kind, origin_user_id, content, channel_type) VALUES ('chat', ?, '{}', 'feishu')",
  );
  for (const o of origins) ins.run(o);
  return db;
}

const captured: Map<string, DeliveryActionHandler> = new Map();

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    captured.set(action, handler);
  },
}));

// Importing the module triggers registerDeliveryAction as a side effect.
await import('./index.js');

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: 'sess-1',
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('gateway_audit delivery action', () => {
  it('persists a well-formed audit payload', async () => {
    const metricBefore =
      (await feishuBitableOperationsTotal.get()).values.find(
        (value) => value.labels.operation === 'feishu.bitable.record.update' && value.labels.outcome === 'ok',
      )?.value ?? 0;
    const handler = captured.get('gateway_audit');
    expect(handler).toBeDefined();
    // Owner-less (shared) session: the claimed actor is honored because ou_1
    // genuinely appeared in this session's host-written inbound.db.
    const inDb = fakeInboundDb(['feishu:ou_1']);
    await handler!(
      {
        action: 'gateway_audit',
        path: '/execute',
        operation: 'feishu.bitable.record.update',
        logicalResource: 'sales-orders',
        userId: 'feishu:ou_1',
        requesterSource: 'session',
        status: 'ok',
        httpStatus: 200,
        durationMs: 42,
        idempotencyKey: 'idem-xyz',
        inputHash: 'deadbeef',
      },
      session(),
      inDb,
    );
    inDb.close();

    const rows = queryGatewayAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      user_id: 'feishu:ou_1',
      path: '/execute',
      operation: 'feishu.bitable.record.update',
      logical_resource: 'sales-orders',
      requester_source: 'session',
      status: 'ok',
      http_status: 200,
      duration_ms: 42,
      idempotency_key: 'idem-xyz',
      input_hash: 'deadbeef',
    });
    expect(
      (await feishuBitableOperationsTotal.get()).values.find(
        (value) => value.labels.operation === 'feishu.bitable.record.update' && value.labels.outcome === 'ok',
      )?.value,
    ).toBe(metricBefore + 1);
  });

  it('labels Bitable HTTP 429 outcomes as rate_limited', async () => {
    const before =
      (await feishuBitableOperationsTotal.get()).values.find(
        (value) => value.labels.operation === 'feishu.bitable.record.list' && value.labels.outcome === 'rate_limited',
      )?.value ?? 0;
    const handler = captured.get('gateway_audit')!;
    await handler(
      {
        action: 'gateway_audit',
        path: '/execute',
        operation: 'feishu.bitable.record.list',
        logicalResource: 'orders',
        requesterSource: 'session',
        status: 'error',
        httpStatus: 429,
      },
      session(),
      {} as never,
    );
    expect(
      (await feishuBitableOperationsTotal.get()).values.find(
        (value) => value.labels.operation === 'feishu.bitable.record.list' && value.labels.outcome === 'rate_limited',
      )?.value,
    ).toBe(before + 1);
  });

  it('owner-less session: DROPS a forged actor not in the session identity set (audit-only attribution)', async () => {
    const handler = captured.get('gateway_audit')!;
    const inDb = fakeInboundDb(['feishu:ou_alice']); // victim never appeared
    await handler(
      {
        action: 'gateway_audit',
        path: '/execute',
        requesterSource: 'session',
        status: 'ok',
        userId: 'feishu:ou_victim',
      },
      session(),
      inDb,
    );
    inDb.close();
    // The row is still recorded (it's a real gateway call) but the forged actor
    // is dropped to null rather than stamped as the victim.
    const rows = queryGatewayAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBeNull();
  });

  it('owner-less session: KEEPS a claimed actor that genuinely appeared in the session', async () => {
    const handler = captured.get('gateway_audit')!;
    const inDb = fakeInboundDb(['feishu:ou_alice', 'feishu:ou_bob']);
    await handler(
      { action: 'gateway_audit', path: '/describe', requesterSource: 'session', status: 'ok', userId: 'feishu:ou_bob' },
      session(),
      inDb,
    );
    inDb.close();
    expect(queryGatewayAudit()[0]!.user_id).toBe('feishu:ou_bob');
  });

  it('drops payloads missing required fields', async () => {
    const handler = captured.get('gateway_audit')!;
    await handler({ action: 'gateway_audit' }, session(), {} as never);
    expect(queryGatewayAudit()).toHaveLength(0);
  });

  it('coerces unknown status to error', async () => {
    const handler = captured.get('gateway_audit')!;
    await handler(
      { action: 'gateway_audit', path: '/execute', requesterSource: 'session', status: 'weird' },
      session(),
      {} as never,
    );
    expect(queryGatewayAudit()[0]!.status).toBe('error');
  });

  it('drops logical resource metadata for non-Bitable operations or malformed aliases', async () => {
    const handler = captured.get('gateway_audit')!;
    await handler(
      {
        action: 'gateway_audit',
        path: '/execute',
        operation: 'sales.order.read',
        logicalResource: 'orders',
        requesterSource: 'session',
        status: 'ok',
      },
      session(),
      {} as never,
    );
    await handler(
      {
        action: 'gateway_audit',
        path: '/execute',
        operation: 'feishu.bitable.record.list',
        logicalResource: '../raw-token',
        requesterSource: 'session',
        status: 'ok',
      },
      session(),
      {} as never,
    );
    expect(queryGatewayAudit().map((row) => row.logical_resource)).toEqual([null, null]);
  });
});

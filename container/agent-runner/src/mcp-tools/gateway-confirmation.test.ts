import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { gatewayRequestConfirmation } from './gateway-confirmation.js';

const HASH = `sha256:${'a'.repeat(64)}`;

function request() {
  return {
    kind: 'update',
    preview: {
      recordId: 'rec-1',
      diff: [{ field: '状态', before: '待办', after: '完成', highImpact: false }],
      expectedRecordFingerprint: HASH,
      bindingHash: HASH,
      confirmationRequest: 'opaque-preview',
      expiresAt: Date.now() + 30_000,
      auditId: 'preview-audit-1',
      highImpactFields: [],
    },
  };
}

function insertHostResponse(status: 'approved' | 'rejected'): void {
  const outbound = getUndeliveredMessages();
  const confirmationId = outbound[0]?.id;
  if (!confirmationId) throw new Error('confirmation outbound was not written');
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id,
          content, process_after, recurrence, series_id, trigger, source_session_id,
          origin_user_id)
       VALUES (?, 4, 'system', datetime('now'), 'pending', NULL, NULL, NULL,
               ?, NULL, NULL, ?, 1, NULL, NULL)`,
    )
    .run(
      `response-${confirmationId}`,
      JSON.stringify({
        type: 'gateway_confirmation_response',
        confirmationId,
        status,
        ...(status === 'approved'
          ? {
              confirmation: 'secret-update-token',
              expiresAt: Date.now() + 20_000,
              bindingHash: HASH,
              auditId: 'issue-audit-1',
            }
          : { errorCode: 'user_rejected' }),
      }),
      `response-${confirmationId}`,
    );
}

beforeEach(() => {
  initTestSessionDb();
  getOutboundDb()
    .prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed)
       VALUES ('inbound-origin-1', 'processing', datetime('now'))`,
    )
    .run();
});

afterEach(() => closeSessionDb());

describe('gateway_request_confirmation MCP tool', () => {
  it('uses the outbound/inbound protocol and returns the Host token only in the private result', async () => {
    setTimeout(() => insertHostResponse('approved'), 20);
    const result = await gatewayRequestConfirmation.handler(request());

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('secret-update-token');
    const outbound = getUndeliveredMessages();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].kind).toBe('system');
    expect(outbound[0].in_reply_to).toBe('inbound-origin-1');
    expect(outbound[0].content).toContain('opaque-preview');
    expect(outbound[0].content).not.toContain('secret-update-token');
  });

  it('returns a closed error on user rejection and never invents a token', async () => {
    setTimeout(() => insertHostResponse('rejected'), 20);
    const result = await gatewayRequestConfirmation.handler(request());

    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('user_rejected');
    expect(text).not.toContain('secret-update-token');
  });

  it('rejects a forged update preview before writing outbound state', async () => {
    const forged = request();
    (forged.preview.diff[0] as Record<string, unknown>).injected = true;
    const result = await gatewayRequestConfirmation.handler(forged);
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('assigns a bounded expiry to a create preview without trusting model time', async () => {
    setTimeout(() => insertHostResponse('approved'), 20);
    const before = Date.now();
    const result = await gatewayRequestConfirmation.handler({
      kind: 'create',
      preview: {
        operation: 'feishu.bitable.record.create',
        resource: 'pilot.records',
        fields: { 待办事项: '提交周报' },
      },
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).not.toContain('secret-update-token');
    const outbound = getUndeliveredMessages();
    const content = JSON.parse(outbound[0]?.content ?? '{}') as {
      preview?: { expiresAt?: number };
    };
    expect(content.preview?.expiresAt).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(content.preview?.expiresAt).toBeLessThanOrEqual(before + 15 * 60_000 + 1_000);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { gatewayRequestConfirmation } from './gateway-confirmation.js';
import {
  clearGatewayConfirmationPreviewCache,
  rememberGatewayConfirmationPreview,
} from './gateway-confirmation-preview-cache.js';

const HASH = `sha256:${'a'.repeat(64)}`;

function request() {
  const preview = {
    recordId: 'rec-1',
    diff: [{ field: '状态', before: '待办', after: '完成', highImpact: false }],
    expectedRecordFingerprint: HASH,
    bindingHash: HASH,
    confirmationRequest: 'opaque-preview',
    expiresAt: Date.now() + 30_000,
    auditId: 'preview-audit-1',
    highImpactFields: [],
  };
  const display = rememberGatewayConfirmationPreview('update', preview);
  if (!display) throw new Error('failed to cache update preview');
  return {
    kind: 'update',
    preview: display,
  };
}

function deleteRequest() {
  const preview = {
    recordId: 'rec-delete-1',
    fields: { 状态: '测试数据', 名称: '仅删除这一条' },
    expectedRecordFingerprint: HASH,
    bindingHash: HASH,
    confirmationRequest: 'opaque-delete-preview',
    expiresAt: Date.now() + 30_000,
    auditId: 'preview-delete-audit-1',
  };
  const display = rememberGatewayConfirmationPreview('delete', preview);
  if (!display) throw new Error('failed to cache delete preview');
  return {
    kind: 'delete',
    preview: display,
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
  clearGatewayConfirmationPreviewCache();
  initTestSessionDb();
  getOutboundDb()
    .prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed)
       VALUES ('inbound-origin-1', 'processing', datetime('now'))`,
    )
    .run();
});

afterEach(() => {
  clearGatewayConfirmationPreviewCache();
  closeSessionDb();
});

describe('gateway_request_confirmation MCP tool', () => {
  it('publishes top-level properties that OpenAI-compatible providers expose as callable arguments', () => {
    const schema = gatewayRequestConfirmation.tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).toMatchObject({
      properties: {
        kind: { type: 'string', enum: ['update', 'create', 'delete'] },
        preview: { type: 'object' },
      },
      required: ['kind', 'preview'],
      additionalProperties: false,
    });
  });

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

  it('never requires the model to receive or repeat the opaque Gateway confirmation request', async () => {
    setTimeout(() => insertHostResponse('approved'), 20);
    const submitted = request();
    expect(submitted.preview).not.toHaveProperty('confirmationRequest');

    const result = await gatewayRequestConfirmation.handler(submitted);

    expect(result.isError).toBeUndefined();
    expect(getUndeliveredMessages()[0]?.content).toContain('opaque-preview');
  });

  it('fails closed when a model-visible preview was not produced by gateway_execute in this session', async () => {
    const submitted = request();
    clearGatewayConfirmationPreviewCache();

    const result = await gatewayRequestConfirmation.handler(submitted);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('rerun gateway_execute');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('fails closed when any displayed update field differs from the cached Gateway preview', async () => {
    const submitted = request();
    submitted.preview.diff[0]!.after = '被模型改写';

    const result = await gatewayRequestConfirmation.handler(submitted);

    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
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

  it('passes an exact Delete preview and returns the Host-issued token only in the private result', async () => {
    setTimeout(() => insertHostResponse('approved'), 20);
    const result = await gatewayRequestConfirmation.handler(deleteRequest());

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('secret-update-token');
    const outbound = getUndeliveredMessages();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].content).toContain('opaque-delete-preview');
    expect(outbound[0].content).toContain('仅删除这一条');
    expect(outbound[0].content).not.toContain('secret-update-token');
  });

  it('rejects a forged Delete preview before writing outbound state', async () => {
    const forged = deleteRequest();
    (forged.preview as Record<string, unknown>).injected = true;
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
        correlationId: 'a'.repeat(64),
      },
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).not.toContain('secret-update-token');
    const outbound = getUndeliveredMessages();
    const content = JSON.parse(outbound[0]?.content ?? '{}') as {
      preview?: { expiresAt?: number; correlationId?: string };
    };
    expect(content.preview?.expiresAt).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(content.preview?.expiresAt).toBeLessThanOrEqual(before + 15 * 60_000 + 1_000);
    expect(content.preview?.correlationId).toBe('a'.repeat(64));
  });
});

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryActionHandler } from '../../delivery.js';
import type { ResponseHandler, ResponsePayload } from '../../response-registry.js';
import type { Session } from '../../types.js';

const harness = vi.hoisted(() => ({
  actions: new Map<string, unknown>(),
  responseHandlers: [] as unknown[],
  interceptors: [] as unknown[],
  delivered: vi.fn(),
  writeSessionMessage: vi.fn(),
  wakeContainer: vi.fn(async () => true),
  issue: vi.fn(async () => ({
    httpStatus: 200,
    outcome: 'ok',
    body: JSON.stringify({
      ok: true,
      confirmation: 'secret-update-token',
      expiresAt: Date.now() + 30_000,
      bindingHash: `sha256:${'b'.repeat(64)}`,
      auditId: 'issue-audit-1',
    }),
  })),
  rootInbound: null as unknown,
}));

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: unknown) => harness.actions.set(action, handler),
  getDeliveryAdapter: () => ({ deliver: harness.delivered }),
}));
vi.mock('../../response-registry.js', () => ({
  registerResponseHandler: (handler: unknown) => harness.responseHandlers.push(handler),
}));
vi.mock('../../router.js', () => ({
  setMessageInterceptor: (handler: unknown) => harness.interceptors.push(handler),
  resolveSender: () => 'feishu:ou_requester',
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: harness.wakeContainer,
}));
vi.mock('../../gateway-signing-proxy.js', () => ({
  processHostGatewayConfirmationRequest: harness.issue,
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: harness.writeSessionMessage,
  openInboundDb: vi.fn(
    () =>
      harness.rootInbound ?? {
        prepare: () => ({ get: () => undefined }),
        close: () => {},
      },
  ),
}));

const broker = await import('./index.js');
const { closeDb, getDb, initTestDb } = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations/index.js');
const { createAgentGroup } = await import('../../db/agent-groups.js');
const { createSession } = await import('../../db/sessions.js');
const { getPendingGatewayConfirmation } = await import('../../db/gateway-confirmations.js');
const {
  onGatewayConfirmationDelivered,
  onGatewayConfirmationResolved,
} = await import('./events.js');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function session(): Session {
  const timestamp = new Date().toISOString();
  return {
    id: 'session-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: 'feishu:ou_requester',
    root_session_id: 'root-session',
    conversation_lane_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: timestamp,
    created_at: timestamp,
  };
}

function inbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER,
      timestamp TEXT,
      kind TEXT,
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT,
      source_session_id TEXT,
      origin_user_id TEXT,
      conversation_thread_id TEXT
    )
  `);
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, kind, channel_type, platform_id, thread_id, source_session_id,
        origin_user_id, conversation_thread_id)
     VALUES (?, 2, 'chat', 'feishu', 'feishu:p2p:ou_requester', NULL, NULL, ?, ?)`,
  ).run('input-1', 'feishu:ou_requester', 'thread-1');
  return db;
}

function a2aInbound(): Database.Database {
  const db = inbound();
  db.prepare(
    `UPDATE messages_in
     SET channel_type = 'agent', platform_id = 'ag-frontdesk',
         source_session_id = 'root-session'
     WHERE id = 'input-1'`,
  ).run();
  return db;
}

function rootInbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER,
      timestamp TEXT,
      kind TEXT,
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT,
      source_session_id TEXT,
      origin_user_id TEXT,
      conversation_thread_id TEXT,
      content TEXT
    )
  `);
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, timestamp, kind, channel_type, platform_id, thread_id, source_session_id,
        origin_user_id, conversation_thread_id, content)
     VALUES ('root-input-1', 2, datetime('now'), 'chat', 'feishu', 'feishu:group:oc_real', NULL,
             NULL, 'feishu:ou_requester', 'thread-1', '{}')`,
  ).run();
  return db;
}

function updateIntent(expiresAt = Date.now() + 60_000): Record<string, unknown> {
  return {
    action: 'gateway_confirmation_request',
    kind: 'update',
    preview: {
      recordId: 'rec-1',
      diff: [{ field: '状态', before: '待办', after: '完成', highImpact: false }],
      expectedRecordFingerprint: HASH_A,
      bindingHash: HASH_B,
      confirmationRequest: 'opaque-preview',
      expiresAt,
      auditId: 'preview-audit-1',
      highImpactFields: [],
    },
  };
}

function deleteIntent(expiresAt = Date.now() + 60_000): Record<string, unknown> {
  return {
    action: 'gateway_confirmation_request',
    kind: 'delete',
    preview: {
      recordId: 'rec-delete-1',
      fields: { 名称: '仅删除这一条', 状态: '测试数据' },
      expectedRecordFingerprint: HASH_A,
      bindingHash: HASH_B,
      confirmationRequest: 'opaque-delete-preview',
      expiresAt,
      auditId: 'preview-delete-audit-1',
    },
  };
}

function optionalRiskMetadataIntent(): Record<string, unknown> {
  const intent = updateIntent();
  const preview = intent.preview as Record<string, unknown>;
  delete preview.highImpactFields;
  const [diff] = preview.diff as Array<Record<string, unknown>>;
  delete diff.highImpact;
  diff.before = '待|办\n排队';
  return intent;
}

function responsePayload(userId: string, value = 'approve'): ResponsePayload {
  return {
    questionId: 'confirm-1',
    value,
    userId,
    channelType: 'feishu',
    platformId: 'feishu:p2p:ou_requester',
    threadId: null,
  };
}

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createAgentGroup({
    id: 'ag-frontdesk',
    name: 'Frontdesk',
    folder: 'frontdesk',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run('feishu:ou_requester', 'feishu', 'Requester', new Date().toISOString());
  createSession({ ...session(), id: 'root-session', agent_group_id: 'ag-frontdesk', root_session_id: 'root-session' });
  createSession(session());
  harness.delivered.mockReset().mockResolvedValue('platform-card-1');
  harness.writeSessionMessage.mockReset();
  harness.wakeContainer.mockClear();
  harness.issue.mockReset().mockResolvedValue({
    httpStatus: 200,
    outcome: 'ok',
    body: JSON.stringify({
      ok: true,
      confirmation: 'secret-update-token',
      expiresAt: Date.now() + 30_000,
      bindingHash: HASH_B,
      auditId: 'issue-audit-1',
    }),
  });
  harness.rootInbound = null;
});

afterEach(() => {
  (harness.rootInbound as Database.Database | null)?.close?.();
  harness.rootInbound = null;
  closeDb();
});

describe('Host-mediated Gateway confirmation broker', () => {
  it('derives actor/route from the Host inbound row and keeps the token out of the card', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = inbound();
    await handler(updateIntent(), session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' });
    db.close();

    expect(getPendingGatewayConfirmation('confirm-1')).toMatchObject({
      requester_user_id: 'feishu:ou_requester',
      platform_id: 'feishu:p2p:ou_requester',
      status: 'pending',
    });
    const card = String(harness.delivered.mock.calls[0]?.[4]);
    expect(card).toContain('修改前');
    expect(card).not.toContain('opaque-preview');
    expect(card).not.toContain('secret-update-token');
  });

  it('accepts optional risk metadata and escapes table-breaking cell values', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = inbound();
    await handler(optionalRiskMetadataIntent(), session(), db, {
      messageOutId: 'confirm-optional-risk',
      inReplyTo: 'input-1',
    });
    db.close();

    const card = String(harness.delivered.mock.calls[0]?.[4]);
    expect(card).toContain('待\\\\|办<br>排队');
    expect(getPendingGatewayConfirmation('confirm-optional-risk')).toMatchObject({ status: 'pending' });
  });

  it('preserves the original canonical user and root channel route across an A2A hop', async () => {
    harness.rootInbound = rootInbound();
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = a2aInbound();
    await handler(updateIntent(), session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' });
    db.close();

    expect(getPendingGatewayConfirmation('confirm-1')).toMatchObject({
      requester_user_id: 'feishu:ou_requester',
      channel_type: 'feishu',
      platform_id: 'feishu:group:oc_real',
    });
    expect(harness.delivered).toHaveBeenCalledWith(
      'feishu',
      'feishu:group:oc_real',
      null,
      'chat-sdk',
      expect.any(String),
    );
  });

  it('rejects another user, issues through the Host for the requester, and unblocks the Worker once', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const response = harness.responseHandlers[0] as ResponseHandler;
    const db = inbound();
    await handler(updateIntent(), session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' });
    db.close();

    expect(await response(responsePayload('ou_other'))).toBe(true);
    expect(getPendingGatewayConfirmation('confirm-1')?.status).toBe('pending');
    expect(harness.issue).not.toHaveBeenCalled();

    expect(await response(responsePayload('ou_requester'))).toBe(true);
    expect(harness.issue).toHaveBeenCalledOnce();
    expect(getPendingGatewayConfirmation('confirm-1')?.status).toBe('approved');
    const systemBody = JSON.parse(harness.writeSessionMessage.mock.calls[0]?.[2].content as string);
    expect(systemBody).toMatchObject({
      type: 'gateway_confirmation_response',
      status: 'approved',
      confirmation: 'secret-update-token',
    });

    expect(await response(responsePayload('ou_requester'))).toBe(true);
    expect(harness.issue).toHaveBeenCalledOnce();
    expect(harness.writeSessionMessage).toHaveBeenCalledOnce();
  });

  it('fails closed when /confirmation/issue is unavailable', async () => {
    harness.issue.mockResolvedValueOnce({
      httpStatus: 404,
      outcome: 'upstream_4xx',
      body: '{"error":{"code":"OPERATION_NOT_FOUND"}}',
    });
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = inbound();
    await handler(updateIntent(), session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' });
    db.close();

    await broker.resolveGatewayConfirmationDecision('confirm-1', 'ou_requester', 'approve');
    expect(getPendingGatewayConfirmation('confirm-1')).toMatchObject({
      status: 'failed',
      error_code: 'confirmation_issue_not_supported',
    });
    const body = JSON.parse(harness.writeSessionMessage.mock.calls[0]?.[2].content as string);
    expect(body).toMatchObject({ status: 'failed', errorCode: 'confirmation_issue_not_supported' });
    expect(body).not.toHaveProperty('confirmation');
  });

  it('fails closed on a signing/authentication failure from the Gateway path', async () => {
    harness.issue.mockResolvedValueOnce({
      httpStatus: 401,
      outcome: 'upstream_4xx',
      body: '{"error":{"code":"BACKEND_UNAUTHORIZED"}}',
    });
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = inbound();
    await handler(updateIntent(), session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' });
    db.close();

    await broker.resolveGatewayConfirmationDecision('confirm-1', 'ou_requester', 'approve');
    expect(getPendingGatewayConfirmation('confirm-1')).toMatchObject({
      status: 'failed',
      error_code: 'confirmation_issue_failed',
    });
    expect(JSON.parse(harness.writeSessionMessage.mock.calls[0]?.[2].content as string)).not.toHaveProperty(
      'confirmation',
    );
  });

  it('rejects a container-forged display shape before creating Pending state', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const forged = updateIntent();
    (forged.preview as Record<string, unknown>).diff = [
      { field: '状态', before: '待办', after: '完成', highImpact: false, injected: true },
    ];
    const db = inbound();
    await expect(handler(forged, session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' })).rejects.toThrow(
      'invalid Gateway confirmation intent',
    );
    db.close();
    expect(getPendingGatewayConfirmation('confirm-1')).toBeUndefined();
  });

  it('renders and issues an actor-bound Delete confirmation without exposing its bearer request', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = inbound();
    await handler(deleteIntent(), session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' });
    db.close();

    expect(getPendingGatewayConfirmation('confirm-1')).toMatchObject({
      kind: 'delete',
      requester_user_id: 'feishu:ou_requester',
      confirmation_request: 'opaque-delete-preview',
      status: 'pending',
    });
    const card = String(harness.delivered.mock.calls[0]?.[4]);
    expect(card).toContain('确认删除');
    expect(card).toContain('仅删除这一条');
    expect(card).not.toContain('opaque-delete-preview');
    expect(card).not.toContain('secret-update-token');

    await broker.resolveGatewayConfirmationDecision('confirm-1', 'ou_requester', 'approve');
    expect(harness.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentGroupId: 'ag-1',
        body: expect.objectContaining({
          confirmationRequest: 'opaque-delete-preview',
          display: {
            recordId: 'rec-delete-1',
            fields: { 名称: '仅删除这一条', 状态: '测试数据' },
            expectedRecordFingerprint: HASH_A,
            expiresAt: expect.any(Number),
          },
        }),
      }),
    );
    const body = JSON.parse(harness.writeSessionMessage.mock.calls[0]?.[2].content as string);
    expect(body).toMatchObject({ status: 'approved', confirmation: 'secret-update-token' });
  });

  it('rejects a container-forged Delete display before creating Pending state', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const forged = deleteIntent();
    (forged.preview as Record<string, unknown>).fields = { 名称: Number.POSITIVE_INFINITY };
    const db = inbound();
    await expect(handler(forged, session(), db, { messageOutId: 'confirm-1', inReplyTo: 'input-1' })).rejects.toThrow(
      'invalid Gateway confirmation intent',
    );
    db.close();
    expect(getPendingGatewayConfirmation('confirm-1')).toBeUndefined();
  });

  it('uses the same actor-bound Pending flow for create without issuing an update token', async () => {
    const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
    const db = inbound();
    await handler(
      {
        action: 'gateway_confirmation_request',
        kind: 'create',
        preview: {
          operation: 'feishu.bitable.record.create',
          resource: 'pilot.records',
          fields: { 待办事项: '测试新增' },
          expiresAt: Date.now() + 60_000,
        },
      },
      session(),
      db,
      { messageOutId: 'confirm-1', inReplyTo: 'input-1' },
    );
    db.close();
    await broker.resolveGatewayConfirmationDecision('confirm-1', 'ou_requester', 'approve');
    expect(harness.issue).not.toHaveBeenCalled();
    const body = JSON.parse(harness.writeSessionMessage.mock.calls[0]?.[2].content as string);
    expect(body).toMatchObject({ status: 'approved' });
    expect(body).not.toHaveProperty('confirmation');
  });

  it('emits a terminal observation after a Create confirmation resolves', async () => {
    const resolved = vi.fn();
    const unsubscribe = onGatewayConfirmationResolved(resolved);
    try {
      const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
      const db = inbound();
      await handler(
        {
          action: 'gateway_confirmation_request',
          kind: 'create',
          preview: {
            operation: 'feishu.bitable.record.create',
            resource: 'pilot.records',
            fields: { 待办事项: '测试新增' },
            expiresAt: Date.now() + 60_000,
          },
        },
        session(),
        db,
        { messageOutId: 'confirm-resolved', inReplyTo: 'input-1' },
      );
      db.close();
      await broker.resolveGatewayConfirmationDecision(
        'confirm-resolved',
        'ou_requester',
        'approve',
      );
      expect(resolved).toHaveBeenCalledWith({
        confirmationId: 'confirm-resolved',
        kind: 'create',
        status: 'approved',
        requesterUserId: 'feishu:ou_requester',
        channelType: 'feishu',
        platformId: 'feishu:p2p:ou_requester',
        threadId: null,
      });
    } finally {
      unsubscribe();
    }
  });

  it('emits correlation-only metadata after a Create card is delivered', async () => {
    const delivered = vi.fn();
    const unsubscribe = onGatewayConfirmationDelivered(delivered);
    try {
      const handler = harness.actions.get('gateway_confirmation_request') as DeliveryActionHandler;
      const db = inbound();
      await handler(
        {
          action: 'gateway_confirmation_request',
          kind: 'create',
          preview: {
            operation: 'feishu.bitable.record.create',
            resource: 'pilot.records',
            fields: { 待办事项: '测试新增' },
            correlationId: 'a'.repeat(64),
            expiresAt: Date.now() + 60_000,
          },
        },
        session(),
        db,
        { messageOutId: 'confirm-correlated', inReplyTo: 'input-1' },
      );
      db.close();

      expect(delivered).toHaveBeenCalledWith({
        confirmationId: 'confirm-correlated',
        kind: 'create',
        requesterUserId: 'feishu:ou_requester',
        channelType: 'feishu',
        platformId: 'feishu:p2p:ou_requester',
        threadId: null,
        resource: 'pilot.records',
        correlationId: 'a'.repeat(64),
      });
      const card = String(harness.delivered.mock.calls[0]?.[4]);
      expect(card).not.toContain('correlationId');
      expect(card).not.toContain('a'.repeat(64));
    } finally {
      unsubscribe();
    }
  });
});

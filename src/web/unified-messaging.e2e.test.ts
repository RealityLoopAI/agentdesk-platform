/**
 * Web ↔ Feishu unified-messaging E2E.
 *
 * This test deliberately keeps the Host boundary real: an actual HTTP server
 * authenticates a browser session, checks Origin + CSRF, creates a Lane, and
 * routes both Web and Feishu messages through the production Router into the
 * production per-Session SQLite pair. Only the external model is replaced by
 * the runner's deterministic MockProvider.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http, { type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/agentdesk-test-web-feishu-e2e', DELIVERY_TIMEOUT_MS: 300 };
});

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { createWebAdapter } from '../channels/web.js';
import type { ChannelAdapter, ChannelSetup } from '../channels/adapter.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { createConversationBinding } from '../db/conversation-lanes.js';
import { runMigrations } from '../db/migrations/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { getPendingQuestion } from '../db/sessions.js';
import { createUserIdentity } from '../db/user-identities.js';
import { createWebAuthSession } from '../db/web-auth.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../delivery.js';
import { resolvePendingQuestion } from '../modules/interactive/index.js';
import { routeInbound, setSenderResolver } from '../router.js';
import { inboundDbPath, outboundDbPath } from '../session-manager.js';
import type { Session } from '../types.js';
import '../modules/gateway-audit/index.js';
import type { WebConfig } from './config.js';
import { createWebRequestHandler } from './server.js';
// @ts-expect-error 参考 Gateway 是供运营者直接运行的原生 ESM 模块，不参与 Host 的 TS 声明发布。
import { createFeishuBitableAdapter } from '../../examples/reference-gateway/feishu-bitable-adapter.mjs';

const TEST_DIR = '/tmp/agentdesk-test-web-feishu-e2e';
const SECRET = '3343e16ed72c245827d2760f3544ce75bb6f25e7710b0874f81c4c7a6fd771a7';
const CONFIG: WebConfig = {
  enabled: true,
  port: 3100,
  publicOrigin: 'https://web.e2e.example',
  redirectUri: 'https://web.e2e.example/auth/feishu/callback',
  sessionSecret: SECRET,
  sessionPolicy: { idleTtlMs: 60 * 60_000, absoluteTtlMs: 24 * 60 * 60_000 },
  authTransactionTtlMs: 10 * 60_000,
  maxBodyBytes: 16 * 1024,
  requestTimeoutMs: 5_000,
  cookieName: 'agentdesk_web_session',
  secureCookies: true,
  loginRateLimit: 20,
  apiRateLimit: 600,
  rateWindowMs: 60_000,
  sseMaxConnectionsPerUser: 5,
  feishu: {
    appId: 'cli_web_e2e',
    appSecret: 'not-used-by-this-test',
    authorizeUrl: 'https://accounts.example/authorize',
    tokenUrl: 'https://accounts.example/token',
    userInfoUrl: 'https://accounts.example/user',
    pkce: false,
  },
};

let server: Server;
let baseUrl: string;
let webAdapter: ChannelAdapter;
let previousCrossChannelLanesFlag: string | undefined;

function hostSetup(): ChannelSetup {
  return {
    onInbound: async () => {},
    onInboundEvent: (event) => routeInbound(event),
    onMetadata: () => {},
    onAction: () => {},
  };
}

/**
 * Deterministic provider double at the model boundary. The real container
 * runner's MockProvider uses the same "Mock response to:" behavior; keeping
 * this tiny Node-side equivalent avoids importing Bun-only runner modules into
 * the Host TypeScript project.
 */
function mockProviderReply(prompt: string): string {
  return `Mock response to: ${prompt.slice(0, 100)}`;
}

function writeOutboundMessage(args: {
  sessionId: string;
  inReplyTo?: string | null;
  text?: string;
  content?: Record<string, unknown>;
  id: string;
  kind: 'chat' | 'chat-sdk' | 'system';
}): void {
  const db = new Database(outboundDbPath('ag-unified', args.sessionId));
  db.prepare(
    `INSERT INTO messages_out
       (id, timestamp, kind, platform_id, channel_type, thread_id, content, in_reply_to)
     VALUES (?, datetime('now'), ?, NULL, NULL, NULL, ?, ?)`,
  ).run(args.id, args.kind, JSON.stringify(args.content ?? { text: args.text ?? '' }), args.inReplyTo ?? null);
  db.close();
}

function writeMockReply(args: { sessionId: string; inReplyTo: string; text: string; id: string }): void {
  writeOutboundMessage({ ...args, kind: 'chat' });
}

async function postJson(pathname: string, auth: { token: string; csrfToken: string }, body: unknown) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      cookie: `${CONFIG.cookieName}=${auth.token}`,
      origin: CONFIG.publicOrigin,
      'x-csrf-token': auth.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function cookieValue(setCookie: string, name: string): string {
  const match = new RegExp(`(?:^|, )${name}=([A-Za-z0-9_-]+)`).exec(setCookie);
  if (!match?.[1]) throw new Error(`missing cookie ${name}: ${setCookie}`);
  return match[1];
}

function feishuSsoProviderFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input) === CONFIG.feishu.tokenUrl) {
      return new Response(JSON.stringify({ code: 0, access_token: 'mock-provider-token' }));
    }
    if (String(input) === CONFIG.feishu.userInfoUrl) {
      return new Response(JSON.stringify({ code: 0, data: { open_id: 'ou_alice', name: 'Alice' } }));
    }
    throw new Error(`unexpected SSO provider endpoint: ${String(input)}`);
  });
}

async function loginThroughFeishuSso(): Promise<{ token: string; csrfToken: string }> {
  const start = await fetch(`${baseUrl}/auth/feishu/start`, { redirect: 'manual' });
  expect(start.status).toBe(303);
  const oauthCookie = start.headers.get('set-cookie')!;
  const authorize = new URL(start.headers.get('location')!);

  const callback = await fetch(
    `${baseUrl}/auth/feishu/callback?state=${encodeURIComponent(authorize.searchParams.get('state')!)}&code=valid-code`,
    {
      redirect: 'manual',
      headers: {
        cookie: `${CONFIG.cookieName}_oauth=${cookieValue(oauthCookie, `${CONFIG.cookieName}_oauth`)}`,
      },
    },
  );
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe('/conversations');
  const token = cookieValue(callback.headers.get('set-cookie')!, CONFIG.cookieName);

  const me = await fetch(`${baseUrl}/api/me`, {
    headers: { cookie: `${CONFIG.cookieName}=${token}` },
  });
  expect(me.status).toBe(200);
  const payload = (await me.json()) as { user: { id: string }; csrfToken: string };
  expect(payload.user.id).toBe('user-alice');
  return { token, csrfToken: payload.csrfToken };
}

beforeEach(async () => {
  previousCrossChannelLanesFlag = process.env.CROSS_CHANNEL_LANES_ENABLED;
  process.env.CROSS_CHANNEL_LANES_ENABLED = 'true';
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('user-alice', 'person', 'Alice', '${now}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-unified', '统一消息 Agent', 'unified-agent', 'mock', '${now}', NULL);
    INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
      VALUES ('user-alice', 'ag-unified', NULL, '${now}');
  `);

  setSenderResolver((event) =>
    event.senderIdentity?.provider === 'feishu' && event.senderIdentity.externalSubject === 'ou_alice'
      ? 'user-alice'
      : null,
  );

  webAdapter = createWebAdapter();
  await webAdapter.setup(hostSetup());
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content, files, source) {
      if (channelType === 'web') {
        return webAdapter.deliver(platformId, threadId, {
          kind,
          content: JSON.parse(content),
          files,
          source,
        });
      }
      return `feishu-e2e-${source?.messageId ?? 'message'}`;
    },
  });

  const handler = createWebRequestHandler(CONFIG, { fetchImpl: feishuSsoProviderFetch() });
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('E2E Web server failed to bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await webAdapter.teardown();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  if (previousCrossChannelLanesFlag === undefined) {
    delete process.env.CROSS_CHANNEL_LANES_ENABLED;
  } else {
    process.env.CROSS_CHANNEL_LANES_ENABLED = previousCrossChannelLanesFlag;
  }
});

describe('真实 Host + MockProvider 的 Web/飞书统一消息', () => {
  it('把飞书 ask_question 同步为 Web 只读卡片并在飞书回答后原位更新', async () => {
    createUserIdentity({
      userId: 'user-alice',
      provider: 'feishu',
      providerScope: CONFIG.feishu.appId,
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    createMessagingGroup({
      id: 'mg-question-card',
      channel_type: 'feishu',
      platform_id: 'feishu:p2p:ou_alice',
      name: 'Alice P2P',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createMessagingGroupAgent({
      id: 'mga-question-card',
      messaging_group_id: 'mg-question-card',
      agent_group_id: 'ag-unified',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-user',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    await routeInbound({
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      senderIdentity: {
        provider: 'feishu',
        providerScope: CONFIG.feishu.appId,
        identifierType: 'open_id',
        externalSubject: 'ou_alice',
      },
      message: {
        id: 'feishu-question-trigger',
        kind: 'chat',
        content: JSON.stringify({ text: '请校验设备仪器', sender: 'Alice' }),
        timestamp: new Date().toISOString(),
        isMention: false,
        isGroup: false,
      },
    });
    const session = getDb()
      .prepare("SELECT * FROM sessions WHERE messaging_group_id = 'mg-question-card'")
      .get() as Session;
    const inbound = new Database(inboundDbPath('ag-unified', session.id), { readonly: true });
    const inboundId = inbound.prepare('SELECT id FROM messages_in ORDER BY seq LIMIT 1').pluck().get() as string;
    inbound.close();
    writeOutboundMessage({
      sessionId: session.id,
      inReplyTo: inboundId,
      id: 'question-card-1',
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'question-card-1',
        title: '设备仪器字段需要确认',
        question: '请选择设备仪器。',
        options: [
          { label: '力辰科技', selectedLabel: '力辰科技', value: '力辰科技' },
          { label: '链路测试', selectedLabel: '链路测试', value: '链路测试' },
        ],
      },
    });
    await deliverSessionMessages(session);

    const auth = createWebAuthSession({
      userId: 'user-alice',
      secret: SECRET,
      policy: CONFIG.sessionPolicy,
    });
    const historyUrl = `${baseUrl}/api/conversations/${encodeURIComponent(session.conversation_lane_id!)}/messages`;
    const pendingHistory = await fetch(historyUrl, {
      headers: { cookie: `${CONFIG.cookieName}=${auth.token}` },
    });
    expect(pendingHistory.status).toBe(200);
    const pendingBody = (await pendingHistory.json()) as {
      messages: Array<{
        id: string;
        text: string;
        presentation?: {
          state: string;
          selectedLabel: string | null;
          options: Array<{ label: string; selected: boolean }>;
        };
      }>;
    };
    expect(pendingBody.messages).toHaveLength(2);
    expect(pendingBody.messages.find((message) => message.id === 'question-card-1')).toMatchObject({
      text: '请选择设备仪器。',
      presentation: {
        state: 'awaiting-external-response',
        selectedLabel: null,
        options: [
          { label: '力辰科技', selected: false },
          { label: '链路测试', selected: false },
        ],
      },
    });
    expect(JSON.stringify(pendingBody)).not.toContain('"type":"ask_question"');
    expect(getDb().prepare("SELECT COUNT(*) FROM web_events WHERE resource_id = 'question-card-1'").pluck().get()).toBe(
      1,
    );

    const pendingQuestion = getPendingQuestion('question-card-1');
    expect(pendingQuestion).toBeDefined();
    await resolvePendingQuestion(session, pendingQuestion!, '链路测试', 'ou_alice');

    const answeredHistory = await fetch(historyUrl, {
      headers: { cookie: `${CONFIG.cookieName}=${auth.token}` },
    });
    expect(answeredHistory.status).toBe(200);
    const answeredBody = (await answeredHistory.json()) as typeof pendingBody;
    expect(answeredBody.messages).toHaveLength(2);
    expect(answeredBody.messages.find((message) => message.id === 'question-card-1')).toMatchObject({
      presentation: {
        state: 'answered',
        selectedLabel: '链路测试',
        options: [
          { label: '力辰科技', selected: false },
          { label: '链路测试', selected: true },
        ],
      },
    });
    expect(
      getDb()
        .prepare(
          `SELECT COUNT(*) FROM web_events
           WHERE lane_id = ? AND event_type = 'conversation.message.available'`,
        )
        .pluck()
        .get(session.conversation_lane_id),
    ).toBe(2);

    const deliveredDb = new Database(inboundDbPath('ag-unified', session.id), { readonly: true });
    const delivered = deliveredDb
      .prepare("SELECT status, platform_message_id FROM delivered WHERE message_out_id = 'question-card-1'")
      .get();
    deliveredDb.close();
    expect(delivered).toEqual({
      status: 'delivered',
      platform_message_id: 'feishu-e2e-question-card-1',
    });
  });

  it('让飞书多维表格请求经 Gateway 授权执行并审计，拒绝越权和未确认删除', async () => {
    createUserIdentity({
      userId: 'user-alice',
      provider: 'feishu',
      providerScope: CONFIG.feishu.appId,
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    createMessagingGroup({
      id: 'mg-bitable-assistant',
      channel_type: 'feishu',
      platform_id: 'feishu:oc_bitable_assistant',
      name: '多维表格助手群',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createMessagingGroupAgent({
      id: 'mga-bitable-assistant',
      messaging_group_id: 'mg-bitable-assistant',
      agent_group_id: 'ag-unified',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-user',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    await routeInbound({
      channelType: 'feishu',
      platformId: 'feishu:oc_bitable_assistant',
      threadId: null,
      senderIdentity: {
        provider: 'feishu',
        providerScope: CONFIG.feishu.appId,
        identifierType: 'open_id',
        externalSubject: 'ou_alice',
      },
      message: {
        id: 'feishu-bitable-create',
        kind: 'chat',
        content: JSON.stringify({ text: '在销售管道中新建“上海续约”', sender: 'Alice' }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: true,
      },
    });
    const session = getDb()
      .prepare("SELECT * FROM sessions WHERE messaging_group_id = 'mg-bitable-assistant'")
      .get() as Session;
    const inDb = new Database(inboundDbPath('ag-unified', session.id), { readonly: true });
    const inboundId = inDb.prepare('SELECT id FROM messages_in ORDER BY seq LIMIT 1').pluck().get() as string;
    inDb.close();

    const gatewayAudits: Array<Record<string, unknown>> = [];
    let createProviderCalls = 0;
    let deleteProviderCalls = 0;
    const bitableFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const href = String(input);
      if (href.endsWith('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'mock-tenant-token', expire: 7200 }));
      }
      if (href.includes('/fields')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                { field_id: 'fld-name', field_name: 'Name', type: 1, ui_type: 'Text' },
                {
                  field_id: 'fld-status',
                  field_name: 'Status',
                  type: 3,
                  ui_type: 'SingleSelect',
                  property: { options: [{ name: 'Open' }, { name: 'Closed' }] },
                },
              ],
              has_more: false,
            },
          }),
        );
      }
      if (href.endsWith('/records') && init.method === 'POST') {
        createProviderCalls += 1;
        const body = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
        return new Response(
          JSON.stringify({
            code: 0,
            data: { record: { record_id: 'rec-created', fields: body.fields } },
          }),
        );
      }
      if (init.method === 'DELETE') {
        deleteProviderCalls += 1;
        return new Response(JSON.stringify({ code: 0, data: {} }));
      }
      throw new Error(`unexpected Bitable provider endpoint: ${href}`);
    });
    const adapter = createFeishuBitableAdapter({
      appId: 'cli-bitable-e2e',
      appSecret: 'gateway-only-secret',
      cursorSecret: 'cursor-secret-at-least-32-characters-long',
      confirmationSecret: 'confirmation-secret-at-least-32-characters',
      readEnabled: true,
      writeEnabled: true,
      fetchImpl: bitableFetch,
      baseUrl: 'https://mock.feishu.local/open-apis',
      audit: async (event: Record<string, unknown>) => gatewayAudits.push(event),
      resources: {
        'sales.pipeline': {
          appToken: 'bas-provider-secret',
          tableId: 'tbl-provider-secret',
          name: '销售管道',
          readers: ['user-alice'],
          writers: ['user-alice'],
          requiredFields: ['Name'],
          highImpactFields: ['Status'],
        },
      },
    });
    const createRequest = {
      operation: 'feishu.bitable.record.create',
      input: { resource: 'sales.pipeline', fields: { Name: '上海续约', Status: 'Open' } },
      requester: { userId: 'user-alice' },
      requesterSource: 'session',
      dryRun: false,
      idempotencyKey: 'bitable-create-e2e',
    };
    await expect(adapter.authorize(createRequest)).resolves.toMatchObject({ allowed: true });
    const createdRecord = await adapter.execute(createRequest);
    expect(createdRecord).toMatchObject({
      ok: true,
      result: { recordId: 'rec-created', fields: { Name: '上海续约', Status: 'Open' } },
    });
    expect(createProviderCalls).toBe(1);

    const providerCallsAfterCreate = bitableFetch.mock.calls.length;
    const unauthorized = await adapter.execute({
      ...createRequest,
      requester: { userId: 'user-bob' },
      idempotencyKey: 'bitable-bob-e2e',
    });
    expect(unauthorized).toMatchObject({ status: 403, body: { code: 'BACKEND_UNAUTHORIZED' } });
    expect(bitableFetch).toHaveBeenCalledTimes(providerCallsAfterCreate);

    const unconfirmedDelete = await adapter.execute({
      operation: 'feishu.bitable.record.delete',
      input: { resource: 'sales.pipeline', recordId: 'rec-created' },
      requester: { userId: 'user-alice' },
      requesterSource: 'session',
      dryRun: false,
      idempotencyKey: 'bitable-delete-e2e',
    });
    expect(unconfirmedDelete).toMatchObject({
      status: 409,
      body: { code: 'CONFIRMATION_REQUIRED' },
    });
    expect(deleteProviderCalls).toBe(0);
    expect(gatewayAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'execute',
          requesterUserId: 'user-alice',
          operation: 'feishu.bitable.record.create',
          resource: 'sales.pipeline',
          outcome: 'ok',
        }),
        expect.objectContaining({
          phase: 'execute',
          requesterUserId: 'user-bob',
          outcome: 'BACKEND_UNAUTHORIZED',
        }),
        expect.objectContaining({
          phase: 'execute',
          operation: 'feishu.bitable.record.delete',
          outcome: 'CONFIRMATION_REQUIRED',
        }),
      ]),
    );

    writeOutboundMessage({
      sessionId: session.id,
      id: 'gateway-audit-bitable-create',
      kind: 'system',
      content: {
        action: 'gateway_audit',
        path: '/execute',
        operation: 'feishu.bitable.record.create',
        logicalResource: 'sales.pipeline',
        userId: 'user-alice',
        requesterSource: 'session',
        status: 'ok',
        httpStatus: 200,
        durationMs: 3,
        idempotencyKey: 'bitable-create-e2e',
        inputHash: 'sha256:e2e',
      },
    });
    writeMockReply({
      sessionId: session.id,
      inReplyTo: inboundId,
      id: 'bitable-create-result',
      text: '已在销售管道创建记录“上海续约”（rec-created）。',
    });
    await deliverSessionMessages(session);

    expect(
      getDb()
        .prepare(
          `SELECT session_id, agent_group_id, user_id, operation, logical_resource, status
           FROM gateway_audit WHERE idempotency_key = 'bitable-create-e2e'`,
        )
        .get(),
    ).toEqual({
      session_id: session.id,
      agent_group_id: 'ag-unified',
      user_id: 'user-alice',
      operation: 'feishu.bitable.record.create',
      logical_resource: 'sales.pipeline',
      status: 'ok',
    });

    const auth = createWebAuthSession({
      userId: 'user-alice',
      secret: SECRET,
      policy: CONFIG.sessionPolicy,
    });
    const history = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent(session.conversation_lane_id!)}/messages`,
      { headers: { cookie: `${CONFIG.cookieName}=${auth.token}` } },
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      messages: Array<{ direction: string; text: string; channel: { type: string } }>;
    };
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'user',
          text: '在销售管道中新建“上海续约”',
          channel: expect.objectContaining({ type: 'feishu' }),
        }),
        expect.objectContaining({
          direction: 'agent',
          text: expect.stringContaining('rec-created'),
          channel: expect.objectContaining({ type: 'feishu' }),
        }),
      ]),
    );
    expect(body.messages).toHaveLength(2);
  });

  it('不预置 Lane/Binding 时由飞书首条消息自动建档，SSO 后回填历史并继续 Web 对话', async () => {
    createUserIdentity({
      userId: 'user-alice',
      provider: 'feishu',
      providerScope: CONFIG.feishu.appId,
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    createMessagingGroup({
      id: 'mg-feishu-first',
      channel_type: 'feishu',
      platform_id: 'feishu:oc_feishu_first',
      name: '飞书主流程群',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createMessagingGroupAgent({
      id: 'mga-feishu-first',
      messaging_group_id: 'mg-feishu-first',
      agent_group_id: 'ag-unified',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-user',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_bindings').pluck().get()).toBe(0);

    await routeInbound({
      channelType: 'feishu',
      platformId: 'feishu:oc_feishu_first',
      threadId: null,
      senderIdentity: {
        provider: 'feishu',
        providerScope: CONFIG.feishu.appId,
        identifierType: 'open_id',
        externalSubject: 'ou_alice',
      },
      message: {
        id: 'feishu-first-turn',
        kind: 'chat',
        content: JSON.stringify({ text: '请总结本周进展', sender: 'Alice' }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: true,
      },
    });

    const session = getDb()
      .prepare(
        `SELECT * FROM sessions
         WHERE agent_group_id = 'ag-unified' AND messaging_group_id = 'mg-feishu-first'`,
      )
      .get() as Session;
    expect(session.conversation_lane_id).toEqual(expect.any(String));
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_lanes').pluck().get()).toBe(1);
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_bindings').pluck().get()).toBe(1);

    const inboundDb = new Database(inboundDbPath('ag-unified', session.id), { readonly: true });
    const inboundId = inboundDb.prepare('SELECT id FROM messages_in ORDER BY seq LIMIT 1').pluck().get() as string;
    inboundDb.close();
    writeMockReply({
      sessionId: session.id,
      inReplyTo: inboundId,
      id: 'mock-feishu-first-reply',
      text: mockProviderReply('请总结本周进展'),
    });
    await deliverSessionMessages(session);

    const auth = await loginThroughFeishuSso();
    const list = await fetch(`${baseUrl}/api/conversations`, {
      headers: { cookie: `${CONFIG.cookieName}=${auth.token}` },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      conversations: Array<{ id: string; sourceChannel: string }>;
    };
    expect(listed.conversations).toEqual([
      expect.objectContaining({
        id: session.conversation_lane_id,
        sourceChannel: 'feishu',
      }),
    ]);

    const history = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent(session.conversation_lane_id!)}/messages`,
      { headers: { cookie: `${CONFIG.cookieName}=${auth.token}` } },
    );
    expect(history.status).toBe(200);
    const historicalMessages = (await history.json()) as {
      messages: Array<{ direction: string; text: string; channel: { type: string } }>;
    };
    expect(historicalMessages.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'user',
          text: '请总结本周进展',
          channel: expect.objectContaining({ type: 'feishu' }),
        }),
        expect.objectContaining({
          direction: 'agent',
          text: expect.stringContaining('请总结本周进展'),
          channel: expect.objectContaining({ type: 'feishu' }),
        }),
      ]),
    );
    expect(historicalMessages.messages).toHaveLength(2);

    const continuation = await postJson(
      `/api/conversations/${encodeURIComponent(session.conversation_lane_id!)}/messages`,
      auth,
      {
        clientMessageId: 'web-after-sso',
        text: '继续补充风险项',
      },
    );
    expect(continuation.status).toBe(202);
    expect(getDb().prepare("SELECT COUNT(*) FROM sessions WHERE agent_group_id = 'ag-unified'").pluck().get()).toBe(1);
    const continuedInboundDb = new Database(inboundDbPath('ag-unified', session.id), {
      readonly: true,
    });
    expect(continuedInboundDb.prepare('SELECT channel_type FROM messages_in ORDER BY seq').pluck().all()).toEqual([
      'feishu',
      'web',
    ]);
    continuedInboundDb.close();
  });

  it('把同一飞书用户的 Web 和飞书消息路由到同一 Lane 与同一根 Session', async () => {
    const auth = createWebAuthSession({
      userId: 'user-alice',
      secret: SECRET,
      policy: CONFIG.sessionPolicy,
    });

    const create = await postJson('/api/conversations', auth, { agentGroupId: 'ag-unified' });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { conversation: { id: string } };
    const laneId = created.conversation.id;

    const identity = createUserIdentity({
      userId: 'user-alice',
      provider: 'feishu',
      providerScope: CONFIG.feishu.appId,
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    createMessagingGroup({
      id: 'mg-feishu-e2e',
      channel_type: 'feishu',
      platform_id: 'feishu:oc_e2e',
      name: '飞书 E2E 群',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createMessagingGroupAgent({
      id: 'mga-feishu-e2e',
      messaging_group_id: 'mg-feishu-e2e',
      agent_group_id: 'ag-unified',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-user',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    createConversationBinding({
      laneId,
      channelType: 'feishu',
      messagingGroupId: 'mg-feishu-e2e',
      platformId: 'feishu:oc_e2e',
      externalIdentityId: identity.id,
      deliveryMode: 'source-reply',
    });

    const webSend = await postJson(`/api/conversations/${encodeURIComponent(laneId)}/messages`, auth, {
      clientMessageId: 'web-turn-1',
      text: 'Web 端问题',
    });
    expect(webSend.status).toBe(202);

    await routeInbound({
      channelType: 'feishu',
      platformId: 'feishu:oc_e2e',
      threadId: null,
      senderIdentity: {
        provider: 'feishu',
        providerScope: CONFIG.feishu.appId,
        identifierType: 'open_id',
        externalSubject: 'ou_alice',
      },
      message: {
        id: 'feishu-turn-1',
        kind: 'chat',
        content: JSON.stringify({ text: '飞书端追问', sender: 'Alice' }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: true,
      },
    });

    const sessions = getDb()
      .prepare(
        `SELECT id, owner_user_id, conversation_lane_id
         FROM sessions WHERE agent_group_id = 'ag-unified'`,
      )
      .all() as Array<{ id: string; owner_user_id: string; conversation_lane_id: string }>;
    expect(sessions).toEqual([
      {
        id: expect.any(String),
        owner_user_id: 'user-alice',
        conversation_lane_id: laneId,
      },
    ]);
    const inDb = new Database(inboundDbPath('ag-unified', sessions[0]!.id), { readonly: true });
    const inbound = inDb
      .prepare(
        `SELECT id, channel_type, platform_id, origin_user_id
         FROM messages_in ORDER BY seq`,
      )
      .all() as Array<{
      id: string;
      channel_type: string;
      platform_id: string;
      origin_user_id: string;
    }>;
    inDb.close();
    expect(
      inbound.map(({ channel_type, platform_id, origin_user_id }) => ({ channel_type, platform_id, origin_user_id })),
    ).toEqual([
      { channel_type: 'web', platform_id: `web:${laneId}`, origin_user_id: 'user-alice' },
      { channel_type: 'feishu', platform_id: 'feishu:oc_e2e', origin_user_id: 'user-alice' },
    ]);

    writeMockReply({
      sessionId: sessions[0]!.id,
      inReplyTo: inbound[0]!.id,
      id: 'mock-web-reply',
      text: mockProviderReply('Web 端问题'),
    });
    writeMockReply({
      sessionId: sessions[0]!.id,
      inReplyTo: inbound[1]!.id,
      id: 'mock-feishu-reply',
      text: mockProviderReply('飞书端追问'),
    });
    await deliverSessionMessages(
      getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessions[0]!.id) as Session,
    );

    const history = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(laneId)}/messages`, {
      headers: { cookie: `${CONFIG.cookieName}=${auth.token}` },
    });
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      messages: Array<{ direction: string; text: string; channel: { type: string } }>;
    };
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'user',
          text: 'Web 端问题',
          channel: expect.objectContaining({ type: 'web' }),
        }),
        expect.objectContaining({
          direction: 'user',
          text: '飞书端追问',
          channel: expect.objectContaining({ type: 'feishu' }),
        }),
        expect.objectContaining({
          direction: 'agent',
          text: expect.stringContaining('Web 端问题'),
          channel: expect.objectContaining({ type: 'web' }),
        }),
        expect.objectContaining({
          direction: 'agent',
          text: expect.stringContaining('飞书端追问'),
          channel: expect.objectContaining({ type: 'feishu' }),
        }),
      ]),
    );
    expect(body.messages).toHaveLength(4);
  });
});

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
import { createUserIdentity } from '../db/user-identities.js';
import { createWebAuthSession } from '../db/web-auth.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../delivery.js';
import { routeInbound, setSenderResolver } from '../router.js';
import { inboundDbPath, outboundDbPath } from '../session-manager.js';
import type { Session } from '../types.js';
import type { WebConfig } from './config.js';
import { createWebRequestHandler } from './server.js';

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

function writeMockReply(args: { sessionId: string; inReplyTo: string; text: string; id: string }): void {
  const db = new Database(outboundDbPath('ag-unified', args.sessionId));
  db.prepare(
    `INSERT INTO messages_out
       (id, timestamp, kind, platform_id, channel_type, thread_id, content, in_reply_to)
     VALUES (?, datetime('now'), 'chat', NULL, NULL, NULL, ?, ?)`,
  ).run(args.id, JSON.stringify({ text: args.text }), args.inReplyTo);
  db.close();
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

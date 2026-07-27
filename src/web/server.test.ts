import fs from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { appendWebEvent, encodeWebEventCursor } from '../db/web-events.js';
import { authenticateWebSession, createWebAuthSession } from '../db/web-auth.js';
import { runMigrations } from '../db/migrations/index.js';
import type { WebConfig } from './config.js';
import type { SubmitWebInbound } from './conversations.js';
import { createWebRequestHandler } from './server.js';

const SECRET = '82a60d53458239ca70aa1294ef743477cd8772d778d32962362674e3237a20d2';
const CONFIG: WebConfig = {
  enabled: true,
  port: 3100,
  publicOrigin: 'https://agent.example.com',
  redirectUri: 'https://agent.example.com/auth/feishu/callback',
  sessionSecret: SECRET,
  sessionPolicy: { idleTtlMs: 60 * 60_000, absoluteTtlMs: 24 * 60 * 60_000 },
  authTransactionTtlMs: 10 * 60_000,
  maxBodyBytes: 32,
  requestTimeoutMs: 5_000,
  cookieName: 'agentdesk_web_session',
  secureCookies: true,
  loginRateLimit: 20,
  apiRateLimit: 600,
  rateWindowMs: 60_000,
  sseMaxConnectionsPerUser: 5,
  feishu: {
    appId: 'cli_web_test',
    appSecret: 'provider-secret',
    authorizeUrl: 'https://accounts.feishu.example/open-apis/authen/v1/authorize',
    tokenUrl: 'https://open.feishu.example/open-apis/authen/v2/oauth/token',
    userInfoUrl: 'https://open.feishu.example/open-apis/authen/v1/user_info',
    scope: 'auth:user.id:read',
    pkce: false,
  },
};

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

async function serve(
  config: WebConfig,
  fetchImpl?: typeof fetch,
  submitInbound?: SubmitWebInbound,
  staticDir?: string,
): Promise<string> {
  const server = http.createServer(createWebRequestHandler(config, { fetchImpl, submitInbound, staticDir }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

function cookieValue(setCookie: string, name: string): string {
  const match = new RegExp(`(?:^|, )${name}=([A-Za-z0-9_-]+)`).exec(setCookie);
  if (!match?.[1]) throw new Error(`missing cookie ${name}: ${setCookie}`);
  return match[1];
}

function providerFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input) === CONFIG.feishu.tokenUrl) {
      return new Response(JSON.stringify({ code: 0, access_token: 'provider-access-token' }));
    }
    if (String(input) === CONFIG.feishu.userInfoUrl) {
      return new Response(JSON.stringify({ code: 0, data: { open_id: 'ou_web', name: 'Web User' } }));
    }
    throw new Error('unexpected provider endpoint');
  });
}

async function login(base: string): Promise<{ sessionCookie: string; csrfToken: string }> {
  const start = await fetch(`${base}/auth/feishu/start`, { redirect: 'manual' });
  expect(start.status).toBe(303);
  const oauthCookie = start.headers.get('set-cookie')!;
  expect(oauthCookie).toContain('HttpOnly');
  expect(oauthCookie).toContain('SameSite=Lax');
  expect(oauthCookie).toContain('Secure');
  const authorize = new URL(start.headers.get('location')!);

  const callback = await fetch(
    `${base}/auth/feishu/callback?state=${encodeURIComponent(authorize.searchParams.get('state')!)}&code=valid-code`,
    {
      redirect: 'manual',
      headers: {
        cookie: `${CONFIG.cookieName}_oauth=${cookieValue(oauthCookie, `${CONFIG.cookieName}_oauth`)}`,
      },
    },
  );
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe('/conversations');
  const sessionSetCookie = callback.headers.get('set-cookie')!;
  const sessionToken = cookieValue(sessionSetCookie, CONFIG.cookieName);
  const sessionCookie = `${CONFIG.cookieName}=${sessionToken}`;

  const me = await fetch(`${base}/api/me`, { headers: { cookie: sessionCookie } });
  expect(me.status).toBe(200);
  expect(me.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(me.headers.get('strict-transport-security')).toContain('max-age=');
  const payload = (await me.json()) as { csrfToken: string };
  return { sessionCookie, csrfToken: payload.csrfToken };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Web HTTP authentication boundary', () => {
  it('exposes only validated public branding before authentication', async () => {
    const base = await serve(CONFIG);
    const response = await fetch(`${base}/api/branding`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      branding: {
        displayName: expect.any(String),
        logoPath: '/brand/logo.svg',
        theme: { brandPrimary: '#245866', canvas: '#FAF8F4' },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|namespace|token|cookie/i);
  });

  it('serves versioned Web assets with safe cache rules and explicit SPA fallbacks', async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-web-static-'));
    temporaryDirectories.push(staticDir);
    fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(staticDir, 'brand'), { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Web fixture</title>');
    fs.writeFileSync(path.join(staticDir, 'assets', 'app-AbCd1234.js'), 'globalThis.__fixture = true;');
    fs.writeFileSync(path.join(staticDir, 'assets', 'app-AbCd1234.js.map'), '{"sources":["private.ts"]}');
    fs.writeFileSync(path.join(staticDir, 'brand', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-web-outside-'));
    temporaryDirectories.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'outside.js');
    fs.writeFileSync(outsideFile, 'must not be served');
    fs.symlinkSync(outsideFile, path.join(staticDir, 'assets', 'escape-AbCd1234.js'));

    const base = await serve(CONFIG, undefined, undefined, staticDir);
    for (const route of ['/', '/login', '/conversations', '/conversations/lane-1']) {
      const page = await fetch(`${base}${route}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('cache-control')).toBe('no-cache');
      expect(await page.text()).toContain('Web fixture');
    }

    const asset = await fetch(`${base}/assets/app-AbCd1234.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toContain('__fixture');

    const logo = await fetch(`${base}/brand/logo.svg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('cache-control')).toBe('public, max-age=3600');
    const head = await fetch(`${base}/assets/app-AbCd1234.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('globalThis.__fixture = true;')));
    expect(await head.text()).toBe('');

    const api = await fetch(`${base}/api/not-a-route`);
    expect(api.status).toBe(401);
    expect(api.headers.get('content-type')).toContain('application/json');
    const unknown = await fetch(`${base}/not-a-spa-route`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect((await fetch(`${base}/assets/app-AbCd1234.js.map`)).status).toBe(404);
    expect((await fetch(`${base}/assets/escape-AbCd1234.js`)).status).toBe(404);
  });

  it('sets hardened cookies, exposes /api/me and revokes the server session on logout', async () => {
    const base = await serve(CONFIG, providerFetch());
    const { sessionCookie, csrfToken } = await login(base);

    const wrongOrigin = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
        origin: 'https://attacker.example',
        'x-csrf-token': csrfToken,
      },
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongCsrf = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
        origin: CONFIG.publicOrigin,
        'x-csrf-token': 'forged',
      },
    });
    expect(wrongCsrf.status).toBe(403);

    const logout = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
        origin: CONFIG.publicOrigin,
        'x-csrf-token': csrfToken,
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const afterLogout = await fetch(`${base}/api/me`, { headers: { cookie: sessionCookie } });
    expect(afterLogout.status).toBe(401);
  });

  it('enforces the configured request-body limit before a write handler runs', async () => {
    const config = { ...CONFIG, maxBodyBytes: 8 };
    getDb()
      .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, ?)')
      .run('user-limit', 'feishu', new Date().toISOString());
    const session = createWebAuthSession({
      userId: 'user-limit',
      secret: SECRET,
      policy: config.sessionPolicy,
    });
    const base = await serve(config);
    const response = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: {
        cookie: `${config.cookieName}=${session.token}`,
        origin: config.publicOrigin,
        'x-csrf-token': session.csrfToken,
        'content-type': 'text/plain',
      },
      body: '123456789',
    });
    expect(response.status).toBe(413);
    expect(authenticateAfterRequest(session.token, config)).toBe(true);
  });

  it('rate-limits login starts by socket address without trusting forwarded headers', async () => {
    const config = { ...CONFIG, loginRateLimit: 1 };
    const base = await serve(config);
    const first = await fetch(`${base}/auth/feishu/start`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    const second = await fetch(`${base}/auth/feishu/start`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });
    expect(first.status).toBe(303);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
  });

  it('creates only authorized conversations and deduplicates authenticated Web messages', async () => {
    const config = { ...CONFIG, maxBodyBytes: 4_096 };
    const now = new Date().toISOString();
    getDb().exec(`
      INSERT INTO users (id, kind, display_name, created_at)
        VALUES ('alice', 'feishu', 'Alice', '${now}');
      INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
        VALUES
        ('ag-allowed', 'Allowed Agent', 'allowed', NULL, '${now}', NULL),
        ('ag-denied', 'Denied Agent', 'denied', NULL, '${now}', NULL);
      INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
        VALUES ('alice', 'ag-allowed', NULL, '${now}');
    `);
    const session = createWebAuthSession({
      userId: 'alice',
      secret: SECRET,
      policy: config.sessionPolicy,
    });
    const submitted: Parameters<SubmitWebInbound>[0][] = [];
    const base = await serve(config, undefined, async (event) => {
      submitted.push(event);
    });
    const headers = {
      cookie: `${config.cookieName}=${session.token}`,
      origin: config.publicOrigin,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    };

    const list = await fetch(`${base}/api/conversations`, { headers: { cookie: headers.cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      conversations: [],
      availableAgentGroups: [{ id: 'ag-allowed', name: 'Allowed Agent' }],
    });

    const denied = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentGroupId: 'ag-denied' }),
    });
    expect(denied.status).toBe(403);

    const created = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentGroupId: 'ag-allowed', userId: 'bob', sessionId: 'forged' }),
    });
    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as { conversation: { id: string } };
    const laneId = createdPayload.conversation.id;

    const submitBody = JSON.stringify({
      clientMessageId: 'client-1',
      text: '来自浏览器的消息',
      userId: 'bob',
      agentGroupId: 'ag-denied',
      sessionId: 'forged',
      conversationLaneId: 'lane-forged',
    });
    const first = await fetch(`${base}/api/conversations/${laneId}/messages`, {
      method: 'POST',
      headers,
      body: submitBody,
    });
    expect(first.status).toBe(202);
    const firstPayload = (await first.json()) as { message: { messageId: string; replayed: boolean } };
    expect(firstPayload.message.replayed).toBe(false);

    const duplicate = await fetch(`${base}/api/conversations/${laneId}/messages`, {
      method: 'POST',
      headers,
      body: submitBody,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      message: { messageId: firstPayload.message.messageId, status: 'accepted', replayed: true },
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      authenticatedUserId: 'alice',
      conversationLaneId: laneId,
      platformId: `web:${laneId}`,
      threadId: null,
      message: { isMention: true, isGroup: false },
    });
    expect(JSON.parse(submitted[0]!.message.content)).toEqual({
      text: '来自浏览器的消息',
      sender: 'Alice',
    });

    getDb()
      .prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .run('alice', 'ag-allowed');
    const afterRevoke = await fetch(`${base}/api/conversations`, { headers: { cookie: headers.cookie } });
    expect(await afterRevoke.json()).toMatchObject({ conversations: [], availableAgentGroups: [] });
    const hidden = await fetch(`${base}/api/conversations/${laneId}/messages`, {
      headers: { cookie: headers.cookie },
    });
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toEqual({ error: 'conversation_unavailable' });
  });

  it('protects the SSE route with authentication and exact Origin, then honors Last-Event-ID replay', async () => {
    const now = new Date().toISOString();
    getDb().exec(`
      INSERT INTO users (id, kind, display_name, created_at)
        VALUES ('alice', 'feishu', 'Alice', '${now}');
      INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
        VALUES ('ag-1', 'Agent', 'agent', NULL, '${now}', NULL);
      INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
        VALUES ('alice', 'ag-1', NULL, '${now}');
      INSERT INTO conversation_lanes
        (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
        VALUES ('lane-1', 'ag-1', 'alice', NULL, 'active', '${now}', NULL);
    `);
    const session = createWebAuthSession({
      userId: 'alice',
      secret: SECRET,
      policy: CONFIG.sessionPolicy,
    });
    const first = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-1',
      eventType: 'conversation.message.accepted',
      resourceId: 'message-1',
    }).event;
    const second = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-1',
      eventType: 'conversation.message.available',
      resourceId: 'message-2',
    }).event;
    const base = await serve(CONFIG);
    const cookie = `${CONFIG.cookieName}=${session.token}`;

    const unauthenticated = await fetch(`${base}/api/events`, { headers: { origin: CONFIG.publicOrigin } });
    expect(unauthenticated.status).toBe(401);
    const wrongOrigin = await fetch(`${base}/api/events`, {
      headers: { cookie, origin: 'https://attacker.example' },
    });
    expect(wrongOrigin.status).toBe(403);
    const malformed = await fetch(`${base}/api/events?cursor=forged`, {
      headers: { cookie, origin: CONFIG.publicOrigin },
    });
    expect(malformed.status).toBe(400);

    const stream = await fetch(`${base}/api/events`, {
      headers: {
        cookie,
        origin: CONFIG.publicOrigin,
        'last-event-id': encodeWebEventCursor(first.sequence),
      },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain(second.event_id);
    expect(text).toContain('message-2');
    expect(text).not.toContain('message-1');
    await reader.cancel();
  });
});

function authenticateAfterRequest(token: string, config: WebConfig): boolean {
  return Boolean(
    authenticateWebSession({
      token,
      secret: config.sessionSecret,
      policy: config.sessionPolicy,
    }),
  );
}

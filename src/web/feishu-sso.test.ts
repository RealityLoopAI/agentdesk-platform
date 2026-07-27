import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { authenticateWebSession, createWebAuthSession, WebAuthStateError } from '../db/web-auth.js';
import { runMigrations } from '../db/migrations/index.js';
import { createUserIdentity, getUserIdentity } from '../db/user-identities.js';
import type { WebConfig } from './config.js';
import {
  completeFeishuSso,
  FeishuSsoError,
  startFeishuSso,
} from './feishu-sso.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const CALLBACK_NOW = new Date('2026-01-01T00:01:00.000Z');
const SECRET = '45ac2d73456f87a7884e3fb326469107cdf739a63c92e1ba85bb1c32e864056f';

const CONFIG: WebConfig = {
  enabled: true,
  port: 3100,
  publicOrigin: 'https://agent.example.com',
  redirectUri: 'https://agent.example.com/auth/feishu/callback',
  sessionSecret: SECRET,
  sessionPolicy: { idleTtlMs: 60 * 60_000, absoluteTtlMs: 24 * 60 * 60_000 },
  authTransactionTtlMs: 10 * 60_000,
  maxBodyBytes: 256 * 1024,
  requestTimeoutMs: 5_000,
  cookieName: 'agentdesk_web_session',
  secureCookies: true,
  loginRateLimit: 20,
  apiRateLimit: 600,
  rateWindowMs: 60_000,
  sseMaxConnectionsPerUser: 5,
  feishu: {
    appId: 'cli_test_app',
    appSecret: 'provider-secret-that-must-never-be-persisted',
    authorizeUrl: 'https://accounts.feishu.example/open-apis/authen/v1/authorize',
    tokenUrl: 'https://open.feishu.example/open-apis/authen/v2/oauth/token',
    userInfoUrl: 'https://open.feishu.example/open-apis/authen/v1/user_info',
    scope: 'auth:user.id:read',
    pkce: true,
  },
};

function providerFetch(openId = 'ou_alice', name = 'Alice') {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === CONFIG.feishu.tokenUrl) {
      return new Response(JSON.stringify({ code: 0, access_token: 'u-token-secret' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === CONFIG.feishu.userInfoUrl) {
      expect(init?.headers).toEqual({ authorization: 'Bearer u-token-secret' });
      return new Response(JSON.stringify({ code: 0, data: { open_id: openId, name } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected provider URL: ${url}`);
  });
}

function seedUser(id: string): void {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, ?)')
    .run(id, 'feishu', NOW.toISOString());
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('Feishu Web SSO', () => {
  it('starts a browser-bound, expiring transaction with S256 PKCE', () => {
    const started = startFeishuSso(CONFIG, NOW);
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe(CONFIG.feishu.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.feishu.appId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const raw = JSON.stringify(getDb().prepare('SELECT * FROM web_auth_transactions').get());
    expect(raw).not.toContain(url.searchParams.get('state'));
    expect(raw).not.toContain(started.browserNonce);
    expect(raw).toContain('"pkce_verifier_ciphertext":"v1.');
  });

  it('maps verified open_id to one canonical user and creates an opaque Web session', async () => {
    const started = startFeishuSso(CONFIG, NOW);
    const authorizationUrl = new URL(started.authorizationUrl);
    const fetchImpl = providerFetch();

    const completed = await completeFeishuSso({
      config: CONFIG,
      state: authorizationUrl.searchParams.get('state')!,
      browserNonce: started.browserNonce,
      authorizationCode: 'authorization-code-secret',
      fetchImpl,
      now: CALLBACK_NOW,
    });

    expect(completed.userId).toBe('feishu:ou_alice');
    expect(
      getUserIdentity({
        provider: 'feishu',
        providerScope: CONFIG.feishu.appId,
        identifierType: 'open_id',
        externalSubject: 'ou_alice',
      })?.user_id,
    ).toBe(completed.userId);
    expect(
      authenticateWebSession({
        token: completed.sessionToken,
        secret: SECRET,
        policy: CONFIG.sessionPolicy,
        now: CALLBACK_NOW,
      })?.session.user_id,
    ).toBe(completed.userId);

    const tokenRequest = fetchImpl.mock.calls[0]!;
    const tokenBody = JSON.parse(String(tokenRequest[1]?.body)) as { code_verifier: string };
    expect(tokenBody.code_verifier).toBeTruthy();
    expect(
      createHash('sha256').update(tokenBody.code_verifier).digest('base64url'),
    ).toBe(authorizationUrl.searchParams.get('code_challenge'));

    const persisted = JSON.stringify({
      transactions: getDb().prepare('SELECT * FROM web_auth_transactions').all(),
      sessions: getDb().prepare('SELECT * FROM web_auth_sessions').all(),
      users: getDb().prepare('SELECT * FROM users').all(),
      audit: getDb().prepare('SELECT * FROM enterprise_audit').all(),
    });
    expect(persisted).not.toContain('authorization-code-secret');
    expect(persisted).not.toContain('u-token-secret');
    expect(persisted).not.toContain(CONFIG.feishu.appSecret);
    expect(persisted).not.toContain(completed.sessionToken);
    expect(persisted).not.toContain(completed.csrfToken);
  });

  it('rejects forged state before contacting Feishu or creating a session', async () => {
    const started = startFeishuSso(CONFIG, NOW);
    const fetchImpl = providerFetch();
    await expect(
      completeFeishuSso({
        config: CONFIG,
        state: 'forged-state',
        browserNonce: started.browserNonce,
        authorizationCode: 'code',
        fetchImpl,
        now: CALLBACK_NOW,
      }),
    ).rejects.toBeInstanceOf(WebAuthStateError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT count(*) AS count FROM web_auth_sessions').get()).toEqual({ count: 0 });
  });

  it('rejects an authorization code replay under another valid state', async () => {
    const first = startFeishuSso(CONFIG, NOW);
    const firstState = new URL(first.authorizationUrl).searchParams.get('state')!;
    await completeFeishuSso({
      config: CONFIG,
      state: firstState,
      browserNonce: first.browserNonce,
      authorizationCode: 'one-code',
      fetchImpl: providerFetch(),
      now: CALLBACK_NOW,
    });

    const second = startFeishuSso(CONFIG, NOW);
    await expect(
      completeFeishuSso({
        config: CONFIG,
        state: new URL(second.authorizationUrl).searchParams.get('state')!,
        browserNonce: second.browserNonce,
        authorizationCode: 'one-code',
        fetchImpl: providerFetch(),
        now: CALLBACK_NOW,
      }),
    ).rejects.toMatchObject({ reason: 'code_replay' });
  });

  it('fails closed instead of silently switching an authenticated user to another mapping', async () => {
    seedUser('canonical-alice');
    seedUser('canonical-bob');
    createUserIdentity({
      userId: 'canonical-bob',
      provider: 'feishu',
      providerScope: CONFIG.feishu.appId,
      identifierType: 'open_id',
      externalSubject: 'ou_bob',
    });
    const current = createWebAuthSession({
      userId: 'canonical-alice',
      secret: SECRET,
      policy: CONFIG.sessionPolicy,
      now: NOW,
    });
    const started = startFeishuSso(CONFIG, NOW);

    await expect(
      completeFeishuSso({
        config: CONFIG,
        state: new URL(started.authorizationUrl).searchParams.get('state')!,
        browserNonce: started.browserNonce,
        authorizationCode: 'bob-code',
        currentSessionToken: current.token,
        fetchImpl: providerFetch('ou_bob', 'Bob'),
        now: CALLBACK_NOW,
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<FeishuSsoError>>({
      reason: 'identity_conflict',
    }));
    expect(
      authenticateWebSession({
        token: current.token,
        secret: SECRET,
        policy: CONFIG.sessionPolicy,
        now: CALLBACK_NOW,
      }),
    ).toBeDefined();
    expect(
      getDb()
        .prepare("SELECT count(*) AS count FROM enterprise_audit WHERE event_type = 'web_sso_identity_conflict'")
        .get(),
    ).toEqual({ count: 1 });
  });
});

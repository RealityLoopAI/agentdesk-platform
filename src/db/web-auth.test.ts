import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  authenticateWebSession,
  countActiveWebAuthSessions,
  consumeWebAuthTransaction,
  createWebAuthSession,
  createWebAuthTransaction,
  revokeAllWebAuthSessionsForUser,
  revokeWebAuthSessionByToken,
  rotateWebAuthSession,
  verifyWebCsrf,
  WebAuthStateError,
} from './web-auth.js';
import { webActiveSessions } from '../metrics.js';

const SECRET = '3bb44a7b3ab94621be6d3cba8b5f6679ed4de7bf1750d5c787ae5f26ce9439c6';
const POLICY = { idleTtlMs: 60_000, absoluteTtlMs: 3_600_000 };
const VALID_TRANSACTION_TIME = new Date('2026-01-01T00:01:00.000Z');

function seedUser(id = 'u-1'): void {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, ?)')
    .run(id, 'feishu', '2026-01-01T00:00:00.000Z');
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedUser();
});

afterEach(() => {
  closeDb();
});

describe('web auth sessions', () => {
  it('publishes the current non-expired, non-revoked Web session count', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const first = createWebAuthSession({ userId: 'u-1', secret: SECRET, policy: POLICY, now });
    createWebAuthSession({ userId: 'u-1', secret: SECRET, policy: POLICY, now });
    expect(countActiveWebAuthSessions(now)).toBe(2);

    const revokedAt = new Date('2026-01-01T00:00:01.000Z');
    revokeWebAuthSessionByToken({
      token: first.token,
      secret: SECRET,
      reason: 'test',
      now: revokedAt,
    });
    expect(countActiveWebAuthSessions(revokedAt)).toBe(1);
    expect((await webActiveSessions.get()).values[0]?.value).toBe(1);
  });

  it('stores only keyed hashes and authenticates with idle sliding bounded by absolute expiry', () => {
    const created = createWebAuthSession({
      userId: 'u-1',
      secret: SECRET,
      policy: POLICY,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const raw = JSON.stringify(getDb().prepare('SELECT * FROM web_auth_sessions').get());
    expect(raw).not.toContain(created.token);
    expect(raw).not.toContain(created.csrfToken);

    const authenticated = authenticateWebSession({
      token: created.token,
      secret: SECRET,
      policy: POLICY,
      now: new Date('2026-01-01T00:00:30.000Z'),
    });
    expect(authenticated?.session.user_id).toBe('u-1');
    expect(authenticated?.session.idle_expires_at).toBe('2026-01-01T00:01:30.000Z');
    expect(verifyWebCsrf({ session: authenticated!, candidate: created.csrfToken, secret: SECRET })).toBe(true);
    expect(verifyWebCsrf({ session: authenticated!, candidate: 'forged', secret: SECRET })).toBe(false);
  });

  it('expires on idle or absolute TTL and rejects the cookie thereafter', () => {
    const idle = createWebAuthSession({
      userId: 'u-1',
      secret: SECRET,
      policy: POLICY,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(
      authenticateWebSession({
        token: idle.token,
        secret: SECRET,
        policy: POLICY,
        now: new Date('2026-01-01T00:01:00.000Z'),
      }),
    ).toBeUndefined();

    const absolute = createWebAuthSession({
      userId: 'u-1',
      secret: SECRET,
      policy: { idleTtlMs: 3_600_000, absoluteTtlMs: 3_600_000 },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(
      authenticateWebSession({
        token: absolute.token,
        secret: SECRET,
        policy: { idleTtlMs: 3_600_000, absoluteTtlMs: 3_600_000 },
        now: new Date('2026-01-01T01:00:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('supports logout, operator revocation and session rotation', () => {
    const first = createWebAuthSession({ userId: 'u-1', secret: SECRET, policy: POLICY });
    const next = rotateWebAuthSession({
      currentToken: first.token,
      userId: 'u-1',
      secret: SECRET,
      policy: POLICY,
    });
    expect(authenticateWebSession({ token: first.token, secret: SECRET, policy: POLICY })).toBeUndefined();
    expect(authenticateWebSession({ token: next.token, secret: SECRET, policy: POLICY })).toBeDefined();

    expect(
      revokeWebAuthSessionByToken({
        token: next.token,
        secret: SECRET,
        reason: 'logout',
      }),
    ).toBe(true);
    expect(authenticateWebSession({ token: next.token, secret: SECRET, policy: POLICY })).toBeUndefined();

    createWebAuthSession({ userId: 'u-1', secret: SECRET, policy: POLICY });
    createWebAuthSession({ userId: 'u-1', secret: SECRET, policy: POLICY });
    expect(revokeAllWebAuthSessionsForUser({ userId: 'u-1', actor: 'operator', reason: 'offboarding' })).toBe(2);

    const audit = JSON.stringify(
      getDb().prepare("SELECT event_type, details FROM enterprise_audit WHERE event_type LIKE 'web_session_%'").all(),
    );
    expect(audit).toContain('web_session_created');
    expect(audit).toContain('web_session_logout');
    expect(audit).toContain('web_sessions_revoked');
    expect(audit).not.toContain(first.token);
    expect(audit).not.toContain(first.csrfToken);
    expect(audit).not.toContain(next.token);
    expect(audit).not.toContain(next.csrfToken);
  });
});

describe('one-time Web OAuth transactions', () => {
  function transaction(now = new Date('2026-01-01T00:00:00.000Z')) {
    return createWebAuthTransaction({
      secret: SECRET,
      redirectUri: 'https://agent.example.com/auth/feishu/callback',
      ttlMs: 10 * 60_000,
      pkceVerifierCiphertext: 'encrypted-verifier',
      now,
    });
  }

  it('consumes matching state/browser/code exactly once without storing raw values', () => {
    const created = transaction();
    const consumed = consumeWebAuthTransaction({
      secret: SECRET,
      state: created.state,
      browserNonce: created.browserNonce,
      authorizationCode: 'one-time-code',
      expectedRedirectUri: 'https://agent.example.com/auth/feishu/callback',
      now: new Date('2026-01-01T00:01:00.000Z'),
    });
    expect(consumed.used_at).toBe('2026-01-01T00:01:00.000Z');
    const raw = JSON.stringify(getDb().prepare('SELECT * FROM web_auth_transactions').get());
    expect(raw).not.toContain(created.state);
    expect(raw).not.toContain(created.browserNonce);
    expect(raw).not.toContain('one-time-code');
    expect(() =>
      consumeWebAuthTransaction({
        secret: SECRET,
        state: created.state,
        browserNonce: created.browserNonce,
        authorizationCode: 'second-code',
        expectedRedirectUri: 'https://agent.example.com/auth/feishu/callback',
      }),
    ).toThrow(WebAuthStateError);
  });

  it('rejects browser mismatch, expiry and redirect mismatch', () => {
    const browser = transaction();
    expect(() =>
      consumeWebAuthTransaction({
        secret: SECRET,
        state: browser.state,
        browserNonce: 'wrong-browser',
        authorizationCode: 'code-a',
        expectedRedirectUri: 'https://agent.example.com/auth/feishu/callback',
        now: VALID_TRANSACTION_TIME,
      }),
    ).toThrowError(expect.objectContaining({ reason: 'browser_mismatch' }));

    const expired = transaction();
    expect(() =>
      consumeWebAuthTransaction({
        secret: SECRET,
        state: expired.state,
        browserNonce: expired.browserNonce,
        authorizationCode: 'code-b',
        expectedRedirectUri: 'https://agent.example.com/auth/feishu/callback',
        now: new Date('2026-01-01T00:10:00.000Z'),
      }),
    ).toThrowError(expect.objectContaining({ reason: 'state_expired' }));

    const redirect = transaction();
    expect(() =>
      consumeWebAuthTransaction({
        secret: SECRET,
        state: redirect.state,
        browserNonce: redirect.browserNonce,
        authorizationCode: 'code-c',
        expectedRedirectUri: 'https://evil.example.com/callback',
        now: VALID_TRANSACTION_TIME,
      }),
    ).toThrowError(expect.objectContaining({ reason: 'redirect_mismatch' }));
  });

  it('rejects an authorization code replayed under a second valid state', () => {
    const first = transaction();
    consumeWebAuthTransaction({
      secret: SECRET,
      state: first.state,
      browserNonce: first.browserNonce,
      authorizationCode: 'same-code',
      expectedRedirectUri: 'https://agent.example.com/auth/feishu/callback',
      now: VALID_TRANSACTION_TIME,
    });
    const second = transaction();
    expect(() =>
      consumeWebAuthTransaction({
        secret: SECRET,
        state: second.state,
        browserNonce: second.browserNonce,
        authorizationCode: 'same-code',
        expectedRedirectUri: 'https://agent.example.com/auth/feishu/callback',
        now: VALID_TRANSACTION_TIME,
      }),
    ).toThrowError(expect.objectContaining({ reason: 'code_replay' }));
  });
});

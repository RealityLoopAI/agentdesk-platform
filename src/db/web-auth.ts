import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { WebAuthSession, WebAuthTransaction } from '../types.js';
import { webActiveSessions } from '../metrics.js';
import { getDb } from './connection.js';
import { recordEnterpriseAudit } from './enterprise-audit.js';

export interface WebAuthSessionPolicy {
  idleTtlMs: number;
  absoluteTtlMs: number;
}

export interface AuthenticatedWebSession {
  session: WebAuthSession;
  csrfToken: string;
}

export type WebAuthStateErrorReason =
  | 'state_missing'
  | 'state_expired'
  | 'state_used'
  | 'browser_mismatch'
  | 'code_replay'
  | 'redirect_mismatch';

export class WebAuthStateError extends Error {
  constructor(readonly reason: WebAuthStateErrorReason) {
    super(`Web authentication transaction rejected: ${reason}`);
    this.name = 'WebAuthStateError';
  }
}

function requireSecret(secret: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Web session secret must be at least 32 bytes');
  }
  return secret;
}

function keyedHash(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', requireSecret(secret)).update(`${purpose}\0${value}`).digest('hex');
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function csrfForSessionToken(secret: string, token: string): string {
  return createHmac('sha256', requireSecret(secret)).update(`csrf-token\0${token}`).digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertPolicy(policy: WebAuthSessionPolicy): void {
  if (!Number.isSafeInteger(policy.idleTtlMs) || policy.idleTtlMs <= 0) {
    throw new Error('Web session idle TTL must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.absoluteTtlMs) || policy.absoluteTtlMs <= 0) {
    throw new Error('Web session absolute TTL must be a positive integer');
  }
}

export function countActiveWebAuthSessions(now: Date = new Date()): number {
  const timestamp = now.toISOString();
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM web_auth_sessions
         WHERE revoked_at IS NULL
           AND idle_expires_at > ?
           AND absolute_expires_at > ?`,
      )
      .get(timestamp, timestamp) as { count: number }
  ).count;
}

export function refreshActiveWebSessionMetric(now: Date = new Date()): void {
  try {
    webActiveSessions.set(countActiveWebAuthSessions(now));
  } catch {
    // Metrics are read-only observability and must never affect auth/session state.
  }
}

export function createWebAuthSession(args: {
  userId: string;
  secret: string;
  policy: WebAuthSessionPolicy;
  authContextHash?: string | null;
  now?: Date;
}): { token: string; csrfToken: string; session: WebAuthSession } {
  assertPolicy(args.policy);
  const db = getDb();
  const now = args.now ?? new Date();
  const token = opaqueToken();
  const csrfToken = csrfForSessionToken(args.secret, token);
  const absoluteExpires = new Date(now.getTime() + args.policy.absoluteTtlMs);
  const idleExpires = new Date(Math.min(now.getTime() + args.policy.idleTtlMs, absoluteExpires.getTime()));
  const session: WebAuthSession = {
    id_hash: keyedHash(args.secret, 'session', token),
    user_id: args.userId,
    csrf_hash: keyedHash(args.secret, 'csrf-store', csrfToken),
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    idle_expires_at: idleExpires.toISOString(),
    absolute_expires_at: absoluteExpires.toISOString(),
    revoked_at: null,
    auth_context_hash: args.authContextHash ?? null,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO web_auth_sessions
         (id_hash, user_id, csrf_hash, created_at, last_seen_at,
          idle_expires_at, absolute_expires_at, revoked_at, auth_context_hash)
       VALUES
         (@id_hash, @user_id, @csrf_hash, @created_at, @last_seen_at,
          @idle_expires_at, @absolute_expires_at, @revoked_at, @auth_context_hash)`,
    ).run(session);
    recordEnterpriseAudit({
      eventType: 'web_session_created',
      actor: args.userId,
      details: {
        userId: args.userId,
        sessionRef: session.id_hash.slice(0, 16),
        absoluteExpiresAt: session.absolute_expires_at,
      },
    });
  })();
  refreshActiveWebSessionMetric(now);

  return { token, csrfToken, session };
}

export function getWebAuthSessionByHash(idHash: string): WebAuthSession | undefined {
  return getDb().prepare('SELECT * FROM web_auth_sessions WHERE id_hash = ?').get(idHash) as WebAuthSession | undefined;
}

export function authenticateWebSession(args: {
  token: string;
  secret: string;
  policy: WebAuthSessionPolicy;
  now?: Date;
  touch?: boolean;
}): AuthenticatedWebSession | undefined {
  assertPolicy(args.policy);
  if (!args.token) return undefined;
  const db = getDb();
  const idHash = keyedHash(args.secret, 'session', args.token);
  const session = getWebAuthSessionByHash(idHash);
  if (!session || session.revoked_at) return undefined;

  const now = args.now ?? new Date();
  const expired = now >= new Date(session.idle_expires_at) || now >= new Date(session.absolute_expires_at);
  if (expired) {
    const result = db
      .prepare('UPDATE web_auth_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
      .run(now.toISOString(), idHash);
    if (result.changes > 0) {
      recordEnterpriseAudit({
        eventType: 'web_session_expired',
        actor: session.user_id,
        details: { userId: session.user_id, sessionRef: idHash.slice(0, 16) },
      });
    }
    refreshActiveWebSessionMetric(now);
    return undefined;
  }

  const csrfToken = csrfForSessionToken(args.secret, args.token);
  if (!constantTimeEqual(session.csrf_hash, keyedHash(args.secret, 'csrf-store', csrfToken))) {
    return undefined;
  }

  if (args.touch !== false) {
    const nextIdle = new Date(
      Math.min(now.getTime() + args.policy.idleTtlMs, new Date(session.absolute_expires_at).getTime()),
    ).toISOString();
    db.prepare('UPDATE web_auth_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?').run(
      now.toISOString(),
      nextIdle,
      idHash,
    );
    session.last_seen_at = now.toISOString();
    session.idle_expires_at = nextIdle;
  }
  return { session, csrfToken };
}

export function verifyWebCsrf(args: {
  session: AuthenticatedWebSession;
  candidate: string | undefined;
  secret: string;
}): boolean {
  if (!args.candidate) return false;
  const expectedHash = args.session.session.csrf_hash;
  const candidateHash = keyedHash(args.secret, 'csrf-store', args.candidate);
  return constantTimeEqual(expectedHash, candidateHash) && constantTimeEqual(args.session.csrfToken, args.candidate);
}

export function revokeWebAuthSessionByToken(args: {
  token: string;
  secret: string;
  actor?: string | null;
  reason: string;
  now?: Date;
}): boolean {
  const idHash = keyedHash(args.secret, 'session', args.token);
  const session = getWebAuthSessionByHash(idHash);
  if (!session) return false;
  const now = (args.now ?? new Date()).toISOString();
  const result = getDb()
    .prepare('UPDATE web_auth_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
    .run(now, idHash);
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: args.reason === 'logout' ? 'web_session_logout' : 'web_session_revoked',
      actor: args.actor ?? session.user_id,
      details: {
        userId: session.user_id,
        sessionRef: idHash.slice(0, 16),
        reason: args.reason,
      },
    });
  }
  refreshActiveWebSessionMetric(new Date(now));
  return result.changes > 0;
}

export function revokeAllWebAuthSessionsForUser(args: {
  userId: string;
  actor: string;
  reason: string;
  now?: Date;
}): number {
  const now = (args.now ?? new Date()).toISOString();
  const result = getDb()
    .prepare('UPDATE web_auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now, args.userId);
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: 'web_sessions_revoked',
      actor: args.actor,
      details: { userId: args.userId, reason: args.reason, revokedCount: result.changes },
    });
  }
  refreshActiveWebSessionMetric(new Date(now));
  return result.changes;
}

export function rotateWebAuthSession(args: {
  currentToken: string;
  userId: string;
  secret: string;
  policy: WebAuthSessionPolicy;
  authContextHash?: string | null;
  now?: Date;
}): { token: string; csrfToken: string; session: WebAuthSession } {
  return getDb().transaction(() => {
    const next = createWebAuthSession(args);
    revokeWebAuthSessionByToken({
      token: args.currentToken,
      secret: args.secret,
      actor: args.userId,
      reason: 'rotated',
      now: args.now,
    });
    return next;
  })();
}

export function createWebAuthTransaction(args: {
  secret: string;
  redirectUri: string;
  ttlMs: number;
  pkceVerifierCiphertext?: string | null;
  now?: Date;
}): { state: string; browserNonce: string; transaction: WebAuthTransaction } {
  if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs <= 0) {
    throw new Error('Web authentication transaction TTL must be a positive integer');
  }
  const now = args.now ?? new Date();
  const state = opaqueToken();
  const browserNonce = opaqueToken();
  const transaction: WebAuthTransaction = {
    state_hash: keyedHash(args.secret, 'oauth-state', state),
    browser_nonce_hash: keyedHash(args.secret, 'oauth-browser', browserNonce),
    pkce_verifier_ciphertext: args.pkceVerifierCiphertext ?? null,
    redirect_uri: args.redirectUri,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + args.ttlMs).toISOString(),
    used_at: null,
    authorization_code_hash: null,
  };
  getDb()
    .prepare(
      `INSERT INTO web_auth_transactions
         (state_hash, browser_nonce_hash, pkce_verifier_ciphertext, redirect_uri,
          created_at, expires_at, used_at, authorization_code_hash)
       VALUES
         (@state_hash, @browser_nonce_hash, @pkce_verifier_ciphertext, @redirect_uri,
          @created_at, @expires_at, @used_at, @authorization_code_hash)`,
    )
    .run(transaction);
  return { state, browserNonce, transaction };
}

export function consumeWebAuthTransaction(args: {
  secret: string;
  state: string;
  browserNonce: string;
  authorizationCode: string;
  expectedRedirectUri: string;
  now?: Date;
}): WebAuthTransaction {
  if (!args.state || !args.authorizationCode) throw new WebAuthStateError('state_missing');
  const db = getDb();
  const now = args.now ?? new Date();
  const stateHash = keyedHash(args.secret, 'oauth-state', args.state);

  return db.transaction(() => {
    const transaction = db.prepare('SELECT * FROM web_auth_transactions WHERE state_hash = ?').get(stateHash) as
      | WebAuthTransaction
      | undefined;
    if (!transaction) throw new WebAuthStateError('state_missing');
    if (transaction.used_at) throw new WebAuthStateError('state_used');
    if (now >= new Date(transaction.expires_at)) throw new WebAuthStateError('state_expired');
    if (transaction.redirect_uri !== args.expectedRedirectUri) {
      throw new WebAuthStateError('redirect_mismatch');
    }
    const browserHash = keyedHash(args.secret, 'oauth-browser', args.browserNonce);
    if (!constantTimeEqual(transaction.browser_nonce_hash, browserHash)) {
      throw new WebAuthStateError('browser_mismatch');
    }
    const codeHash = keyedHash(args.secret, 'oauth-code', args.authorizationCode);
    const replay = db
      .prepare('SELECT 1 FROM web_auth_transactions WHERE authorization_code_hash = ? LIMIT 1')
      .get(codeHash);
    if (replay) throw new WebAuthStateError('code_replay');

    try {
      const result = db
        .prepare(
          `UPDATE web_auth_transactions
           SET used_at = ?, authorization_code_hash = ?
           WHERE state_hash = ? AND used_at IS NULL`,
        )
        .run(now.toISOString(), codeHash, stateHash);
      if (result.changes !== 1) throw new WebAuthStateError('state_used');
    } catch (err) {
      if (err instanceof WebAuthStateError) throw err;
      throw new WebAuthStateError('code_replay');
    }
    return { ...transaction, used_at: now.toISOString(), authorization_code_hash: codeHash };
  })();
}

export function purgeExpiredWebAuthTransactions(now: Date = new Date()): number {
  return getDb()
    .prepare('DELETE FROM web_auth_transactions WHERE expires_at < ? OR used_at IS NOT NULL')
    .run(now.toISOString()).changes;
}

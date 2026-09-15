import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  authenticateWebSession,
  consumeWebAuthTransaction,
  createWebAuthSession,
  createWebAuthTransaction,
  rotateWebAuthSession,
  type AuthenticatedWebSession,
} from '../db/web-auth.js';
import { reconcileFeishuConversationLanes } from '../conversation-reconciliation.js';
import { recordEnterpriseAudit } from '../db/enterprise-audit.js';
import { getUserIdentitiesForUser, getUserIdentity, resolveOrCreateCanonicalUser } from '../db/user-identities.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { webLoginTotal } from '../metrics.js';
import type { UserIdentity } from '../types.js';
import type { WebConfig } from './config.js';

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

export type FeishuSsoErrorReason =
  'provider_rejected' | 'provider_unavailable' | 'provider_response_invalid' | 'identity_missing' | 'identity_conflict';

export class FeishuSsoError extends Error {
  constructor(readonly reason: FeishuSsoErrorReason) {
    super(`Feishu SSO failed: ${reason}`);
    this.name = 'FeishuSsoError';
  }
}

interface FeishuToken {
  accessToken: string;
}

interface FeishuProfile {
  openId: string;
  displayName: string | null;
}

interface ProviderResponse {
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  access_token?: unknown;
  data?: unknown;
  open_id?: unknown;
  name?: unknown;
}

export interface FeishuSsoStart {
  authorizationUrl: string;
  browserNonce: string;
  expiresAt: string;
}

export interface FeishuSsoCompletion {
  userId: string;
  sessionToken: string;
  csrfToken: string;
  sessionExpiresAt: string;
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update('web-oauth-pkce\0').update(secret).digest();
}

function encryptEphemeral(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptEphemeral(secret: string, encoded: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw, extra] = encoded.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw || extra) {
    throw new FeishuSsoError('provider_response_invalid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new FeishuSsoError('provider_response_invalid');
  }
}

function pkceVerifier(): string {
  return randomBytes(64).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function readProviderJson(response: Response): Promise<ProviderResponse> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new FeishuSsoError('provider_response_invalid');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new FeishuSsoError('provider_response_invalid');
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as ProviderResponse;
  } catch {
    throw new FeishuSsoError('provider_response_invalid');
  }
}

async function fetchProvider(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(input, { ...init, redirect: 'error', signal: timeout });
  } catch {
    throw new FeishuSsoError('provider_unavailable');
  }
  if (!response.ok) {
    throw new FeishuSsoError(response.status >= 500 ? 'provider_unavailable' : 'provider_rejected');
  }
  return response;
}

async function exchangeAuthorizationCode(args: {
  config: WebConfig;
  code: string;
  pkceVerifier?: string;
  fetchImpl: typeof fetch;
}): Promise<FeishuToken> {
  const response = await fetchProvider(
    args.fetchImpl,
    args.config.feishu.tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: args.config.feishu.appId,
        client_secret: args.config.feishu.appSecret,
        code: args.code,
        redirect_uri: args.config.redirectUri,
        ...(args.pkceVerifier ? { code_verifier: args.pkceVerifier } : {}),
      }),
    },
    args.config.requestTimeoutMs,
  );
  const body = await readProviderJson(response);
  if (body.code !== 0) throw new FeishuSsoError('provider_rejected');
  const accessToken = safeString(body.access_token);
  if (!accessToken) throw new FeishuSsoError('provider_response_invalid');
  return { accessToken };
}

async function fetchFeishuProfile(args: {
  config: WebConfig;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<FeishuProfile> {
  const response = await fetchProvider(
    args.fetchImpl,
    args.config.feishu.userInfoUrl,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${args.accessToken}` },
    },
    args.config.requestTimeoutMs,
  );
  const body = await readProviderJson(response);
  if (body.code !== 0) throw new FeishuSsoError('provider_rejected');
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? (body.data as ProviderResponse) : body;
  const openId = safeString(data.open_id);
  if (!openId?.startsWith('ou_')) throw new FeishuSsoError('identity_missing');
  return { openId, displayName: safeString(data.name) ?? null };
}

function sameUser(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function feishuAuthContextHash(providerScope: string, externalSubject: string): string {
  return createHash('sha256').update(`feishu\0${providerScope}\0${externalSubject}`).digest('hex');
}

/**
 * Resolve the exact Feishu identity that established an authenticated Web
 * session. The browser cannot select an external identity; the opaque
 * auth-context hash is matched against server-side verified mappings.
 */
export function getFeishuIdentityForWebSession(
  config: WebConfig,
  authenticated: AuthenticatedWebSession,
): UserIdentity | undefined {
  return getUserIdentitiesForUser(authenticated.session.user_id).find(
    (identity) =>
      identity.provider === 'feishu' &&
      identity.provider_scope === config.feishu.appId &&
      identity.identifier_type === 'open_id' &&
      feishuAuthContextHash(identity.provider_scope, identity.external_subject) ===
        authenticated.session.auth_context_hash,
  );
}

export function startFeishuSso(config: WebConfig, now: Date = new Date()): FeishuSsoStart {
  const verifier = config.feishu.pkce ? pkceVerifier() : undefined;
  const created = createWebAuthTransaction({
    secret: config.sessionSecret,
    redirectUri: config.redirectUri,
    ttlMs: config.authTransactionTtlMs,
    pkceVerifierCiphertext: verifier ? encryptEphemeral(config.sessionSecret, verifier) : null,
    now,
  });
  const url = new URL(config.feishu.authorizeUrl);
  url.searchParams.set('client_id', config.feishu.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', created.state);
  if (config.feishu.scope) {
    url.searchParams.set('scope', config.feishu.scope);
  }
  if (verifier) {
    url.searchParams.set('code_challenge', pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  recordEnterpriseAudit(
    {
      eventType: 'web_sso_started',
      details: {
        provider: 'feishu',
        providerScope: config.feishu.appId,
        expiresAt: created.transaction.expires_at,
        pkce: Boolean(verifier),
      },
    },
    now,
  );
  try {
    webLoginTotal.labels('started').inc();
  } catch {
    // Metrics are best-effort and never alter authentication.
  }
  return {
    authorizationUrl: url.toString(),
    browserNonce: created.browserNonce,
    expiresAt: created.transaction.expires_at,
  };
}

export async function completeFeishuSso(args: {
  config: WebConfig;
  state: string;
  browserNonce: string;
  authorizationCode: string;
  currentSessionToken?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<FeishuSsoCompletion> {
  const now = args.now ?? new Date();
  let currentSession: AuthenticatedWebSession | undefined;
  try {
    currentSession = args.currentSessionToken
      ? authenticateWebSession({
          token: args.currentSessionToken,
          secret: args.config.sessionSecret,
          policy: args.config.sessionPolicy,
          now,
          touch: false,
        })
      : undefined;

    const transaction = consumeWebAuthTransaction({
      secret: args.config.sessionSecret,
      state: args.state,
      browserNonce: args.browserNonce,
      authorizationCode: args.authorizationCode,
      expectedRedirectUri: args.config.redirectUri,
      now,
    });
    const verifier = transaction.pkce_verifier_ciphertext
      ? decryptEphemeral(args.config.sessionSecret, transaction.pkce_verifier_ciphertext)
      : undefined;
    const fetchImpl = args.fetchImpl ?? fetch;
    const token = await exchangeAuthorizationCode({
      config: args.config,
      code: args.authorizationCode,
      pkceVerifier: verifier,
      fetchImpl,
    });
    const profile = await fetchFeishuProfile({
      config: args.config,
      accessToken: token.accessToken,
      fetchImpl,
    });

    const identityKey = {
      provider: 'feishu',
      providerScope: args.config.feishu.appId,
      identifierType: 'open_id',
      externalSubject: profile.openId,
    };
    const existing = getUserIdentity(identityKey);
    if (currentSession && existing && !sameUser(currentSession.session.user_id, existing.user_id)) {
      throw new FeishuSsoError('identity_conflict');
    }

    const userId = resolveOrCreateCanonicalUser({
      ...identityKey,
      legacyUserId: `feishu:${profile.openId}`,
      userKind: 'feishu',
      displayName: profile.displayName,
      verifiedAt: now.toISOString(),
      seenAt: now.toISOString(),
    });
    if (currentSession && !sameUser(currentSession.session.user_id, userId)) {
      throw new FeishuSsoError('identity_conflict');
    }

    const authContextHash = feishuAuthContextHash(args.config.feishu.appId, profile.openId);
    const session =
      args.currentSessionToken && currentSession
        ? rotateWebAuthSession({
            currentToken: args.currentSessionToken,
            userId,
            secret: args.config.sessionSecret,
            policy: args.config.sessionPolicy,
            authContextHash,
            now,
          })
        : createWebAuthSession({
            userId,
            secret: args.config.sessionSecret,
            policy: args.config.sessionPolicy,
            authContextHash,
            now,
          });
    recordEnterpriseAudit(
      {
        eventType: 'web_sso_succeeded',
        actor: userId,
        details: {
          provider: 'feishu',
          providerScope: args.config.feishu.appId,
          userId,
          sessionRotated: Boolean(args.currentSessionToken && currentSession),
        },
      },
      now,
    );
    try {
      webLoginTotal.labels('succeeded').inc();
    } catch {
      // Metrics are best-effort and never alter authentication.
    }
    const verifiedIdentity = getUserIdentity(identityKey);
    if (verifiedIdentity) {
      try {
        reconcileFeishuConversationLanes({
          userId,
          externalIdentityId: verifiedIdentity.id,
          actor: userId,
          trigger: 'sso',
          limit: 50,
          authorizeAgentGroup: (agentGroupId) => canAccessAgentGroup(userId, agentGroupId).allowed,
        });
        // Reconciliation is additive and retryable, so login remains valid.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        // Reconciliation is additive and retryable. An unexpected backfill
        // failure must not invalidate an otherwise completed SSO login.
        recordEnterpriseAudit({
          eventType: 'conversation_reconciliation_failed',
          actor: userId,
          details: {
            trigger: 'sso',
            reason: error instanceof Error ? error.name : 'unknown',
          },
        });
      }
    }
    return {
      userId,
      sessionToken: session.token,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.session.absolute_expires_at,
    };
  } catch (error) {
    const metricOutcome =
      error instanceof FeishuSsoError && error.reason === 'identity_conflict' ? 'identity_conflict' : 'rejected';
    recordEnterpriseAudit(
      {
        eventType: metricOutcome === 'identity_conflict' ? 'web_sso_identity_conflict' : 'web_sso_rejected',
        actor: currentSession?.session.user_id ?? null,
        details: {
          provider: 'feishu',
          providerScope: args.config.feishu.appId,
          reason: error instanceof FeishuSsoError ? error.reason : error instanceof Error ? error.name : 'unknown',
        },
      },
      now,
    );
    try {
      webLoginTotal.labels(metricOutcome).inc();
    } catch {
      // Metrics are best-effort and never alter authentication.
    }
    throw error;
  }
}

import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';

import { getDb } from '../db/connection.js';
import {
  authenticateWebSession,
  revokeWebAuthSessionByToken,
  verifyWebCsrf,
  type AuthenticatedWebSession,
} from '../db/web-auth.js';
import { recordEnterpriseAudit } from '../db/enterprise-audit.js';
import { log } from '../log.js';
import { readWebConfig, type WebConfig } from './config.js';
import {
  createWebConversation,
  getWebConversationHistory,
  listWebConversations,
  submitWebConversationMessage,
  WebConversationError,
  type SubmitWebInbound,
} from './conversations.js';
import { createWebEventStreamManager, WebEventStreamError } from './events.js';
import { completeFeishuSso, startFeishuSso } from './feishu-sso.js';

const OAUTH_BROWSER_COOKIE_SUFFIX = '_oauth';

export class WebRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'WebRequestError';
  }
}

interface RateEntry {
  count: number;
  resetAt: number;
}

export interface FixedWindowLimiter {
  consume(key: string, now?: number): { allowed: boolean; retryAfterSeconds: number };
}

export function createFixedWindowLimiter(limit: number, windowMs: number): FixedWindowLimiter {
  const entries = new Map<string, RateEntry>();
  return {
    consume(key, now = Date.now()) {
      let entry = entries.get(key);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entries.size > 10_000) {
        for (const [candidate, value] of entries) {
          if (now >= value.resetAt) entries.delete(candidate);
        }
      }
      return {
        allowed: entry.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
      };
    },
  };
}

function cookies(req: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  const header = req.headers.cookie;
  if (!header || header.length > 8_192) return result;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value && /^[A-Za-z0-9_-]+$/.test(value)) result.set(name, value);
  }
  return result;
}

function serializeCookie(args: {
  name: string;
  value: string;
  secure: boolean;
  path: string;
  maxAgeSeconds: number;
}): string {
  return [
    `${args.name}=${args.value}`,
    `Path=${args.path}`,
    `Max-Age=${Math.max(0, Math.floor(args.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
    args.secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function sessionCookie(config: WebConfig, token: string): string {
  return serializeCookie({
    name: config.cookieName,
    value: token,
    secure: config.secureCookies,
    path: '/',
    maxAgeSeconds: config.sessionPolicy.absoluteTtlMs / 1_000,
  });
}

function clearSessionCookie(config: WebConfig): string {
  return serializeCookie({
    name: config.cookieName,
    value: 'deleted',
    secure: config.secureCookies,
    path: '/',
    maxAgeSeconds: 0,
  });
}

function oauthCookieName(config: WebConfig): string {
  return `${config.cookieName}${OAUTH_BROWSER_COOKIE_SUFFIX}`;
}

function oauthCookie(config: WebConfig, nonce: string): string {
  return serializeCookie({
    name: oauthCookieName(config),
    value: nonce,
    secure: config.secureCookies,
    path: '/auth/feishu/callback',
    maxAgeSeconds: config.authTransactionTtlMs / 1_000,
  });
}

function clearOauthCookie(config: WebConfig): string {
  return serializeCookie({
    name: oauthCookieName(config),
    value: 'deleted',
    secure: config.secureCookies,
    path: '/auth/feishu/callback',
    maxAgeSeconds: 0,
  });
}

function applySecurityHeaders(res: ServerResponse, config: WebConfig): void {
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join('; '),
  );
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (config.secureCookies) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

function json(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function redirect(res: ServerResponse, location: string, setCookie?: string | string[]): void {
  res.statusCode = 303;
  res.setHeader('location', location);
  res.setHeader('cache-control', 'no-store');
  if (setCookie) res.setHeader('set-cookie', setCookie);
  res.end();
}

function clientAddress(req: IncomingMessage): string {
  // Deliberately ignore X-Forwarded-For until a trusted-proxy allowlist exists.
  return req.socket.remoteAddress ?? 'unknown';
}

function exactOriginAllowed(req: IncomingMessage, config: WebConfig): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin === config.publicOrigin;
}

async function readJsonRequestBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebRequestError(413, 'request_too_large');
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) throw new WebRequestError(413, 'request_too_large');
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new WebRequestError(415, 'unsupported_media_type');
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body is not an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new WebRequestError(400, 'invalid_json');
  }
}

function requireWebSession(
  req: IncomingMessage,
  config: WebConfig,
): {
  token: string;
  authenticated: AuthenticatedWebSession;
} {
  const token = cookies(req).get(config.cookieName);
  const authenticated = token
    ? authenticateWebSession({
        token,
        secret: config.sessionSecret,
        policy: config.sessionPolicy,
      })
    : undefined;
  if (!token || !authenticated) throw new WebRequestError(401, 'authentication_required');
  return { token, authenticated };
}

function enforceRateLimit(limiter: FixedWindowLimiter, key: string, res: ServerResponse): void {
  const decision = limiter.consume(key);
  if (decision.allowed) return;
  res.setHeader('retry-after', String(decision.retryAfterSeconds));
  throw new WebRequestError(429, 'rate_limited');
}

export function createWebRequestHandler(
  config: WebConfig,
  options: { fetchImpl?: typeof fetch; submitInbound?: SubmitWebInbound; sseHeartbeatMs?: number } = {},
): RequestListener & { closeEventStreams(): void } {
  const loginLimiter = createFixedWindowLimiter(config.loginRateLimit, config.rateWindowMs);
  const apiLimiter = createFixedWindowLimiter(config.apiRateLimit, config.rateWindowMs);
  const eventStreams = createWebEventStreamManager(config, { heartbeatMs: options.sseHeartbeatMs });

  const handler: RequestListener = async (req, res) => {
    applySecurityHeaders(res, config);
    const timeout = setTimeout(() => {
      if (!res.headersSent) json(res, 408, { error: 'request_timeout' });
      else res.destroy();
    }, config.requestTimeoutMs);
    timeout.unref?.();

    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', config.publicOrigin);
      const ip = clientAddress(req);

      if (method === 'GET' && url.pathname === '/auth/feishu/start') {
        enforceRateLimit(loginLimiter, `start:${ip}`, res);
        const started = startFeishuSso(config);
        redirect(res, started.authorizationUrl, oauthCookie(config, started.browserNonce));
        return;
      }

      if (method === 'GET' && url.pathname === '/auth/feishu/callback') {
        enforceRateLimit(loginLimiter, `callback:${ip}`, res);
        const state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        const browserNonce = cookies(req).get(oauthCookieName(config)) ?? '';
        if (url.searchParams.has('error') || !state || !code || !browserNonce) {
          recordEnterpriseAudit({
            eventType: 'web_sso_rejected',
            details: { provider: 'feishu', providerScope: config.feishu.appId, reason: 'callback_invalid' },
          });
          redirect(res, '/login?error=authentication_failed', clearOauthCookie(config));
          return;
        }
        try {
          const currentSessionToken = cookies(req).get(config.cookieName);
          const completed = await completeFeishuSso({
            config,
            state,
            browserNonce,
            authorizationCode: code,
            currentSessionToken,
            fetchImpl: options.fetchImpl,
          });
          redirect(res, '/conversations', [sessionCookie(config, completed.sessionToken), clearOauthCookie(config)]);
          // Authentication failures intentionally collapse to one public result;
          // detailed, credential-free reasons are already written by the SSO core.
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch {
          redirect(res, '/login?error=authentication_failed', clearOauthCookie(config));
        }
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const { token, authenticated } = requireWebSession(req, config);
        enforceRateLimit(apiLimiter, `api:${authenticated.session.user_id}`, res);

        if (method === 'GET' && url.pathname === '/api/me') {
          const user = getDb()
            .prepare('SELECT id, kind, display_name FROM users WHERE id = ?')
            .get(authenticated.session.user_id) as
            | { id: string; kind: string; display_name: string | null }
            | undefined;
          if (!user) throw new WebRequestError(401, 'authentication_required');
          json(res, 200, {
            user: { id: user.id, kind: user.kind, displayName: user.display_name },
            csrfToken: authenticated.csrfToken,
            sessionExpiresAt: authenticated.session.absolute_expires_at,
          });
          return;
        }

        if (method === 'GET' && url.pathname === '/api/events') {
          if (!exactOriginAllowed(req, config)) throw new WebRequestError(403, 'request_forbidden');
          const lastEventId =
            typeof req.headers['last-event-id'] === 'string'
              ? req.headers['last-event-id']
              : url.searchParams.get('cursor');
          eventStreams.open({
            req,
            res,
            token,
            authenticated,
            cursor: lastEventId,
          });
          return;
        }

        if (method === 'GET' && url.pathname === '/api/conversations') {
          json(res, 200, listWebConversations(authenticated.session.user_id));
          return;
        }

        let postBody: Record<string, unknown> | null = null;
        if (method === 'POST') {
          if (!exactOriginAllowed(req, config)) throw new WebRequestError(403, 'request_forbidden');
          if (
            !verifyWebCsrf({
              session: authenticated,
              candidate: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
              secret: config.sessionSecret,
            })
          ) {
            throw new WebRequestError(403, 'request_forbidden');
          }
          postBody = await readJsonRequestBody(req, config.maxBodyBytes);
        }

        if (method === 'POST' && url.pathname === '/api/logout') {
          revokeWebAuthSessionByToken({
            token,
            secret: config.sessionSecret,
            actor: authenticated.session.user_id,
            reason: 'logout',
          });
          res.statusCode = 204;
          res.setHeader('cache-control', 'no-store');
          res.setHeader('set-cookie', clearSessionCookie(config));
          res.end();
          return;
        }

        if (method === 'POST' && url.pathname === '/api/conversations') {
          const agentGroupId = typeof postBody?.agentGroupId === 'string' ? postBody.agentGroupId : '';
          json(res, 201, { conversation: createWebConversation(authenticated.session.user_id, agentGroupId) });
          return;
        }

        const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
        if (messagesMatch?.[1]) {
          let laneId: string;
          try {
            laneId = decodeURIComponent(messagesMatch[1]);
          } catch {
            throw new WebRequestError(400, 'invalid_conversation_id');
          }
          if (method === 'GET') {
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw === null ? undefined : Number(limitRaw);
            if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
              throw new WebRequestError(400, 'invalid_limit');
            }
            json(
              res,
              200,
              getWebConversationHistory({
                userId: authenticated.session.user_id,
                laneId,
                cursor: url.searchParams.get('cursor'),
                limit,
              }),
            );
            return;
          }
          if (method === 'POST') {
            const clientMessageId = typeof postBody?.clientMessageId === 'string' ? postBody.clientMessageId : '';
            const text = typeof postBody?.text === 'string' ? postBody.text : '';
            const result = await submitWebConversationMessage({
              userId: authenticated.session.user_id,
              laneId,
              clientMessageId,
              text,
              submitInbound: options.submitInbound,
            });
            json(res, result.replayed ? 200 : 202, { message: result });
            return;
          }
        }

        throw new WebRequestError(404, 'not_found');
      }

      if (method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok' });
        return;
      }
      throw new WebRequestError(404, 'not_found');
      // This is the HTTP trust boundary: unexpected failures must become a
      // generic response instead of escaping as an unhandled rejection.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      if (res.writableEnded) return;
      if (error instanceof WebRequestError) {
        json(res, error.status, { error: error.code });
      } else if (error instanceof WebConversationError) {
        json(res, error.status, { error: error.code });
      } else if (error instanceof WebEventStreamError) {
        json(res, error.status, { error: error.code });
      } else {
        log.error('Web request failed', {
          method: req.method,
          path: new URL(req.url ?? '/', config.publicOrigin).pathname,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        json(res, 500, { error: 'internal_error' });
      }
    } finally {
      clearTimeout(timeout);
    }
  };
  return Object.assign(handler, {
    closeEventStreams(): void {
      eventStreams.closeAll();
    },
  });
}

let webServer: Server | null = null;
let closeWebEventStreams: (() => void) | null = null;

export async function startWebServer(): Promise<void> {
  const config = readWebConfig();
  if (!config || webServer) return;
  const handler = createWebRequestHandler(config);
  const server = http.createServer(handler);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.requestTimeoutMs + 1_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  webServer = server;
  closeWebEventStreams = handler.closeEventStreams;
  log.info('Web listener started', { port: config.port, publicOrigin: config.publicOrigin });
}

export async function stopWebServer(): Promise<void> {
  const server = webServer;
  webServer = null;
  if (!server) return;
  closeWebEventStreams?.();
  closeWebEventStreams = null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

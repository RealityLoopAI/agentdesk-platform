import { readEnvFile } from '../env.js';

export const WEB_CONFIG_KEYS = [
  'WEB_ENABLED',
  'WEB_PORT',
  'WEB_PUBLIC_ORIGIN',
  'WEB_SESSION_SECRET',
  'WEB_SESSION_IDLE_TTL_MINUTES',
  'WEB_SESSION_ABSOLUTE_TTL_HOURS',
  'WEB_AUTH_TRANSACTION_TTL_MINUTES',
  'WEB_MAX_BODY_BYTES',
  'WEB_REQUEST_TIMEOUT_MS',
  'WEB_COOKIE_NAME',
  'WEB_ALLOW_INSECURE_HTTP',
  'WEB_LOGIN_RATE_LIMIT',
  'WEB_API_RATE_LIMIT',
  'WEB_RATE_WINDOW_MS',
  'WEB_SSE_MAX_CONNECTIONS_PER_USER',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_SSO_AUTHORIZE_URL',
  'FEISHU_SSO_TOKEN_URL',
  'FEISHU_SSO_USERINFO_URL',
  'FEISHU_SSO_SCOPE',
  'FEISHU_SSO_PKCE',
] as const;

export interface WebConfig {
  enabled: boolean;
  port: number;
  publicOrigin: string;
  redirectUri: string;
  sessionSecret: string;
  sessionPolicy: {
    idleTtlMs: number;
    absoluteTtlMs: number;
  };
  authTransactionTtlMs: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  cookieName: string;
  secureCookies: boolean;
  loginRateLimit: number;
  apiRateLimit: number;
  rateWindowMs: number;
  sseMaxConnectionsPerUser: number;
  feishu: {
    appId: string;
    appSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    scope: string;
    pkce: boolean;
  };
}

export type WebConfigReader = (key: string) => string | undefined;

function boolValue(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function intValue(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function strictUrl(name: string, raw: string, allowInsecureHttp: boolean, originOnly = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name} must be an absolute URL`, { cause: error });
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} must not contain credentials or a fragment`);
  }
  const localHttp =
    allowInsecureHttp &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${name} must use HTTPS (only loopback HTTP is allowed for explicit local development)`);
  }
  if (originOnly && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error(`${name} must be an exact origin without path, query or fragment`);
  }
  return url;
}

export function parseWebConfig(get: WebConfigReader): WebConfig | null {
  const enabled = boolValue(get('WEB_ENABLED'));
  if (!enabled) return null;

  const allowInsecureHttp = boolValue(get('WEB_ALLOW_INSECURE_HTTP'));
  const publicOriginRaw = get('WEB_PUBLIC_ORIGIN');
  const sessionSecret = get('WEB_SESSION_SECRET');
  const appId = get('FEISHU_APP_ID');
  const appSecret = get('FEISHU_APP_SECRET');
  if (!publicOriginRaw) throw new Error('WEB_PUBLIC_ORIGIN is required when WEB_ENABLED=true');
  if (!sessionSecret) throw new Error('WEB_SESSION_SECRET is required when WEB_ENABLED=true');
  if (Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    throw new Error('WEB_SESSION_SECRET must be at least 32 bytes');
  }
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required when WEB_ENABLED=true');
  }

  const publicOriginUrl = strictUrl('WEB_PUBLIC_ORIGIN', publicOriginRaw, allowInsecureHttp, true);
  const authorizeUrl = strictUrl(
    'FEISHU_SSO_AUTHORIZE_URL',
    get('FEISHU_SSO_AUTHORIZE_URL') ?? 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    allowInsecureHttp,
  );
  const tokenUrl = strictUrl(
    'FEISHU_SSO_TOKEN_URL',
    get('FEISHU_SSO_TOKEN_URL') ?? 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    allowInsecureHttp,
  );
  const userInfoUrl = strictUrl(
    'FEISHU_SSO_USERINFO_URL',
    get('FEISHU_SSO_USERINFO_URL') ?? 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    allowInsecureHttp,
  );
  const cookieName = get('WEB_COOKIE_NAME') ?? 'agentdesk_web_session';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) {
    throw new Error('WEB_COOKIE_NAME contains unsupported characters');
  }

  const idleMinutes = intValue('WEB_SESSION_IDLE_TTL_MINUTES', get('WEB_SESSION_IDLE_TTL_MINUTES'), 60, 1, 43_200);
  const absoluteHours = intValue('WEB_SESSION_ABSOLUTE_TTL_HOURS', get('WEB_SESSION_ABSOLUTE_TTL_HOURS'), 24, 1, 8_760);
  const idleTtlMs = idleMinutes * 60_000;
  const absoluteTtlMs = absoluteHours * 60 * 60_000;
  if (idleTtlMs > absoluteTtlMs) {
    throw new Error('WEB_SESSION_IDLE_TTL_MINUTES cannot exceed WEB_SESSION_ABSOLUTE_TTL_HOURS');
  }

  return {
    enabled: true,
    port: intValue('WEB_PORT', get('WEB_PORT'), 3100, 1, 65_535),
    publicOrigin: publicOriginUrl.origin,
    redirectUri: new URL('/auth/feishu/callback', publicOriginUrl).toString(),
    sessionSecret,
    sessionPolicy: { idleTtlMs, absoluteTtlMs },
    authTransactionTtlMs:
      intValue('WEB_AUTH_TRANSACTION_TTL_MINUTES', get('WEB_AUTH_TRANSACTION_TTL_MINUTES'), 10, 1, 30) * 60_000,
    maxBodyBytes: intValue('WEB_MAX_BODY_BYTES', get('WEB_MAX_BODY_BYTES'), 256 * 1024, 1_024, 10 * 1024 * 1024),
    requestTimeoutMs: intValue('WEB_REQUEST_TIMEOUT_MS', get('WEB_REQUEST_TIMEOUT_MS'), 15_000, 1_000, 120_000),
    cookieName,
    secureCookies: !allowInsecureHttp,
    loginRateLimit: intValue('WEB_LOGIN_RATE_LIMIT', get('WEB_LOGIN_RATE_LIMIT'), 20, 1, 10_000),
    apiRateLimit: intValue('WEB_API_RATE_LIMIT', get('WEB_API_RATE_LIMIT'), 600, 1, 100_000),
    rateWindowMs: intValue('WEB_RATE_WINDOW_MS', get('WEB_RATE_WINDOW_MS'), 60_000, 1_000, 3_600_000),
    sseMaxConnectionsPerUser: intValue(
      'WEB_SSE_MAX_CONNECTIONS_PER_USER',
      get('WEB_SSE_MAX_CONNECTIONS_PER_USER'),
      5,
      1,
      100,
    ),
    feishu: {
      appId,
      appSecret,
      authorizeUrl: authorizeUrl.toString(),
      tokenUrl: tokenUrl.toString(),
      userInfoUrl: userInfoUrl.toString(),
      scope: get('FEISHU_SSO_SCOPE') ?? 'auth:user.id:read',
      pkce: boolValue(get('FEISHU_SSO_PKCE')),
    },
  };
}

export function readWebConfig(): WebConfig | null {
  const dotenv = readEnvFile([...WEB_CONFIG_KEYS]);
  return parseWebConfig((key) => {
    const value = (process.env[key] ?? dotenv[key])?.trim();
    return value || undefined;
  });
}

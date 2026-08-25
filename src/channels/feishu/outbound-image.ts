import { createHash } from 'node:crypto';

import type { FeishuApiResponse, FeishuReceiveTarget, FeishuTenantTokenResponse, TokenCacheEntry } from './types.js';
import { isWithdrawnReplyError } from './primitives.js';

const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const MAX_REQUEST_UUID_LENGTH = 50;
const MAX_ERROR_DETAIL_LENGTH = 256;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface FeishuOutboundImageConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  requestTimeoutMs: number;
}

export interface FeishuOutboundImageDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  getAccessToken?: () => Promise<string>;
}

export interface SendFeishuImageInput {
  target: FeishuReceiveTarget;
  filename: string;
  data: Buffer;
  threadId?: string | null;
  idempotencyKey?: string;
}

export interface SendFeishuImageResult {
  imageKey: string;
  messageId?: string;
}

export class FeishuOutboundImageError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: string, message: string, options: { retryable: boolean; retryAfterMs?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'FeishuOutboundImageError';
    this.code = code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function normalizeFeishuP2pTarget(platformId: string): FeishuReceiveTarget {
  const match = /^feishu:p2p:(ou_[A-Za-z0-9_-]+)$/.exec(platformId.trim());
  if (!match) {
    throw new FeishuOutboundImageError('INVALID_P2P_TARGET', 'Feishu notification target must use feishu:p2p:ou_*', {
      retryable: false,
    });
  }
  return { receiveId: match[1], receiveIdType: 'open_id' };
}

export function normalizeFeishuRequestUuid(value: string): string {
  const normalized = value.trim();
  if (normalized && normalized.length <= MAX_REQUEST_UUID_LENGTH && /^[A-Za-z0-9_-]+$/.test(normalized)) {
    return normalized;
  }
  return `vp-${createHash('sha256').update(normalized).digest('hex').slice(0, 40)}`;
}

function boundedDetail(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_DETAIL_LENGTH);
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function providerError(
  stage: 'token' | 'upload' | 'send',
  response: Response,
  parsed: FeishuApiResponse | FeishuTenantTokenResponse | null,
): FeishuOutboundImageError {
  const detail = boundedDetail(parsed?.msg) || `HTTP ${response.status}`;
  return new FeishuOutboundImageError(`FEISHU_${stage.toUpperCase()}_FAILED`, `Feishu ${stage} failed: ${detail}`, {
    retryable: retryableStatus(response.status),
    retryAfterMs: retryAfterMs(response),
  });
}

function requestFailure(stage: 'token' | 'upload' | 'send', error: unknown): FeishuOutboundImageError {
  if (error instanceof FeishuOutboundImageError) return error;
  const timedOut = error instanceof Error && error.name === 'AbortError';
  return new FeishuOutboundImageError(
    timedOut ? `FEISHU_${stage.toUpperCase()}_TIMEOUT` : `FEISHU_${stage.toUpperCase()}_UNAVAILABLE`,
    timedOut ? `Feishu ${stage} timed out` : `Feishu ${stage} is unavailable`,
    { retryable: true, cause: error },
  );
}

async function parseResponse<T>(response: Response): Promise<T | null> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new FeishuOutboundImageError('FEISHU_RESPONSE_TOO_LARGE', 'Feishu response exceeded the byte limit', {
      retryable: retryableStatus(response.status),
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new FeishuOutboundImageError('FEISHU_RESPONSE_TOO_LARGE', 'Feishu response exceeded the byte limit', {
      retryable: retryableStatus(response.status),
    });
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new FeishuOutboundImageError('FEISHU_INVALID_RESPONSE', 'Feishu returned invalid JSON', {
      retryable: retryableStatus(response.status),
      cause: error,
    });
  }
}

export function createFeishuOutboundImageTransport(
  config: FeishuOutboundImageConfig,
  dependencies: FeishuOutboundImageDependencies = {},
): {
  sendImage(input: SendFeishuImageInput): Promise<SendFeishuImageResult>;
} {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  let tokenCache: TokenCacheEntry | null = null;
  let tokenInflight: Promise<string> | null = null;

  async function withTimeout<T>(
    stage: 'token' | 'upload' | 'send',
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    timeout.unref?.();
    try {
      return await run(controller.signal);
    } catch (error) {
      throw requestFailure(stage, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshToken(): Promise<string> {
    return withTimeout('token', async (signal) => {
      const response = await fetchImpl(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        signal,
      });
      const parsed = await parseResponse<FeishuTenantTokenResponse>(response);
      if (!response.ok || parsed?.code !== 0 || !parsed.tenant_access_token) {
        throw providerError('token', response, parsed);
      }
      tokenCache = {
        token: parsed.tenant_access_token,
        expiresAt: now() + Math.max(60, (parsed.expire || 7200) - 60) * 1000,
      };
      return tokenCache.token;
    });
  }

  async function accessToken(): Promise<string> {
    if (dependencies.getAccessToken) return dependencies.getAccessToken();
    if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_AHEAD_MS > now()) return tokenCache.token;
    if (tokenInflight) return tokenInflight;
    tokenInflight = refreshToken().finally(() => {
      tokenInflight = null;
    });
    return tokenInflight;
  }

  async function upload(filename: string, data: Buffer): Promise<string> {
    return withTimeout('upload', async (signal) => {
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', new Blob([new Uint8Array(data)]), filename);
      const response = await fetchImpl(`${config.baseUrl}/open-apis/im/v1/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}` },
        body: form,
        signal,
      });
      const parsed = await parseResponse<FeishuApiResponse & { data?: { image_key?: string } }>(response);
      if (!response.ok || parsed?.code !== 0 || !parsed.data?.image_key) {
        throw providerError('upload', response, parsed);
      }
      return parsed.data.image_key;
    });
  }

  async function send(
    target: FeishuReceiveTarget,
    imageKey: string,
    threadId: string | null,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return withTimeout('send', async (signal) => {
      const token = await accessToken();
      const content = JSON.stringify({ image_key: imageKey });
      if (threadId) {
        const replyResponse = await fetchImpl(
          `${config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(threadId)}/reply`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ content, msg_type: 'image', reply_in_thread: true }),
            signal,
          },
        );
        const reply = await parseResponse<FeishuApiResponse & { data?: { message_id?: string } }>(replyResponse);
        if (replyResponse.ok && reply?.code === 0) return reply.data?.message_id;
        if (!reply || !isWithdrawnReplyError(reply)) {
          throw providerError('send', replyResponse, reply);
        }
      }

      const query = new URLSearchParams({ receive_id_type: target.receiveIdType });
      if (idempotencyKey) query.set('uuid', normalizeFeishuRequestUuid(idempotencyKey));
      const response = await fetchImpl(`${config.baseUrl}/open-apis/im/v1/messages?${query}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          receive_id: target.receiveId,
          msg_type: 'image',
          content,
        }),
        signal,
      });
      const parsed = await parseResponse<FeishuApiResponse & { data?: { message_id?: string } }>(response);
      if (!response.ok || parsed?.code !== 0) throw providerError('send', response, parsed);
      return parsed.data?.message_id;
    });
  }

  return {
    async sendImage(input: SendFeishuImageInput): Promise<SendFeishuImageResult> {
      const imageKey = await upload(input.filename, input.data);
      const messageId = await send(input.target, imageKey, input.threadId ?? null, input.idempotencyKey);
      return { imageKey, messageId };
    },
  };
}

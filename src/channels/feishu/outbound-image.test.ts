import { describe, expect, it, vi } from 'vitest';

import {
  FeishuOutboundImageError,
  createFeishuOutboundImageTransport,
  normalizeFeishuP2pTarget,
  normalizeFeishuRequestUuid,
} from './outbound-image.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function transport(fetchImpl: typeof fetch, requestTimeoutMs = 1000) {
  return createFeishuOutboundImageTransport(
    {
      appId: 'cli_test',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.test',
      requestTimeoutMs,
    },
    { fetch: fetchImpl },
  );
}

describe('Feishu outbound image transport', () => {
  it('accepts only fixed p2p Open ID targets', () => {
    expect(normalizeFeishuP2pTarget('feishu:p2p:ou_abc-123')).toEqual({
      receiveId: 'ou_abc-123',
      receiveIdType: 'open_id',
    });
    expect(() => normalizeFeishuP2pTarget('feishu:oc_group')).toThrow(FeishuOutboundImageError);
    expect(() => normalizeFeishuP2pTarget('ou_abc')).toThrow(/feishu:p2p/);
  });

  it('keeps valid UUIDs and hashes long or unsafe identities within 50 characters', () => {
    expect(normalizeFeishuRequestUuid('event_123')).toBe('event_123');
    const first = normalizeFeishuRequestUuid(`unsafe:${'x'.repeat(100)}`);
    expect(first).toBe(normalizeFeishuRequestUuid(`unsafe:${'x'.repeat(100)}`));
    expect(first.length).toBeLessThanOrEqual(50);
    expect(first).toMatch(/^vp-[a-f0-9]{40}$/);
  });

  it('coalesces token refresh, uploads bytes, and reuses the stable message UUID', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/tenant_access_token/')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (url.endsWith('/images')) return jsonResponse({ code: 0, data: { image_key: 'img-key' } });
      return jsonResponse({ code: 0, data: { message_id: 'msg-1' } });
    }) as typeof fetch;

    const sender = transport(fetchImpl);
    const target = normalizeFeishuP2pTarget('feishu:p2p:ou_receiver');
    const [first, second] = await Promise.all([
      sender.sendImage({ target, filename: 'one.jpg', data: Buffer.from([0xff, 0xd8]), idempotencyKey: 'event-1' }),
      sender.sendImage({ target, filename: 'two.jpg', data: Buffer.from([0xff, 0xd8]), idempotencyKey: 'event-2' }),
    ]);

    expect(first.messageId).toBe('msg-1');
    expect(second.imageKey).toBe('img-key');
    expect(calls.filter((call) => call.url.includes('/tenant_access_token/'))).toHaveLength(1);
    const sends = calls.filter((call) => call.url.includes('/im/v1/messages?'));
    expect(new URL(sends[0].url).searchParams.get('uuid')).toBe('event-1');
    expect(new URL(sends[1].url).searchParams.get('uuid')).toBe('event-2');
    expect(JSON.parse(String(sends[0].init?.body))).toMatchObject({
      receive_id: 'ou_receiver',
      msg_type: 'image',
    });
  });

  it('uses an injected adapter token and falls back from a withdrawn reply', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/images')) return jsonResponse({ code: 0, data: { image_key: 'img-key' } });
      if (url.endsWith('/reply')) return jsonResponse({ code: 230011, msg: 'message withdrawn' });
      return jsonResponse({ code: 0, data: { message_id: 'fallback-msg' } });
    }) as typeof fetch;
    const getAccessToken = vi.fn(async () => 'shared-token');
    const sender = createFeishuOutboundImageTransport(
      {
        appId: 'unused',
        appSecret: 'unused',
        baseUrl: 'https://open.feishu.test',
        requestTimeoutMs: 1000,
      },
      { fetch: fetchImpl, getAccessToken },
    );

    const result = await sender.sendImage({
      target: { receiveId: 'oc_group', receiveIdType: 'chat_id' },
      threadId: 'om_withdrawn',
      filename: 'image.png',
      data: Buffer.from([0x89, 0x50]),
    });

    expect(result.messageId).toBe('fallback-msg');
    expect(calls.some((url) => url.endsWith('/reply'))).toBe(true);
    expect(calls.some((url) => url.includes('receive_id_type=chat_id'))).toBe(true);
    expect(getAccessToken).toHaveBeenCalled();
  });

  it('classifies throttling and preserves retry hints without exposing response bodies', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/tenant_access_token/')) {
        return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 });
      }
      return jsonResponse(
        { code: 99991663, msg: `rate limited\n${'detail'.repeat(100)}` },
        { status: 429, headers: { 'retry-after': '3' } },
      );
    }) as typeof fetch;

    const error = await transport(fetchImpl)
      .sendImage({
        target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
        filename: 'image.jpg',
        data: Buffer.from([0xff, 0xd8]),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeishuOutboundImageError);
    expect(error).toMatchObject({ code: 'FEISHU_UPLOAD_FAILED', retryable: true, retryAfterMs: 3000 });
    expect((error as Error).message.length).toBeLessThan(320);
  });

  it('aborts bounded requests and reports a retryable timeout', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        }),
    ) as typeof fetch;

    const error = await transport(fetchImpl, 10)
      .sendImage({
        target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
        filename: 'image.jpg',
        data: Buffer.from([0xff, 0xd8]),
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'FEISHU_TOKEN_TIMEOUT', retryable: true });
  });

  it('rejects oversized provider responses without retaining their body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('x'.repeat(70_000), {
          status: 502,
          headers: { 'content-length': '70000', 'content-type': 'text/plain' },
        }),
    ) as typeof fetch;

    const error = await transport(fetchImpl)
      .sendImage({
        target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
        filename: 'image.jpg',
        data: Buffer.from([0xff, 0xd8]),
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'FEISHU_RESPONSE_TOO_LARGE', retryable: true });
    expect((error as Error).message).not.toContain('xxxx');
  });
});

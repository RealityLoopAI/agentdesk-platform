import { describe, expect, it, vi } from 'vitest';

import type { EnabledTtsAckConfig } from '../examples/xiaohuan-bitable-bridge/config.js';
import {
  createTtsReceiptKey,
  sendTtsAcknowledgement,
  TtsAcknowledgementError,
} from '../examples/xiaohuan-bitable-bridge/tts-ack.js';

const config: EnabledTtsAckConfig = {
  enabled: true,
  baseUrl: 'http://192.168.66.133:18082',
  text: '收到',
  timeoutMs: 2_000,
};
const receiptKey = createTtsReceiptKey('test-run', 'capture-000001');
const requestId = `xiaohuan-received-${receiptKey}`;

describe('Xiaohuan TTS acknowledgement client', () => {
  it('submits the documented payload and accepts HTTP 202', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          accepted: true,
          request_id: requestId,
          task_id: 'task-1',
          queue_position: 1,
          duplicate: false,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(sendTtsAcknowledgement(config, receiptKey, fetchImpl)).resolves.toEqual({
      requestId,
      taskId: 'task-1',
      queuePosition: 1,
      duplicate: false,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('http://192.168.66.133:18082/api/tts/speak');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      request_id: requestId,
      text: '收到',
    });
  });

  it('accepts a hardware idempotency replay without changing the request ID', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          accepted: true,
          request_id: requestId,
          task_id: 'task-original',
          queue_position: 0,
          duplicate: true,
        }),
        { status: 202 },
      ),
    );

    await expect(sendTtsAcknowledgement(config, receiptKey, fetchImpl)).resolves.toMatchObject({
      requestId,
      duplicate: true,
      queuePosition: 0,
    });
  });

  it.each([
    [
      'queue full',
      new Response('{"accepted":false,"error":"queue_full"}', { status: 429 }),
      'TTS_QUEUE_FULL',
    ],
    [
      'mismatched request ID',
      new Response(
        JSON.stringify({
          accepted: true,
          request_id: 'other',
          task_id: 'task-1',
          queue_position: 1,
          duplicate: false,
        }),
        { status: 202 },
      ),
      'TTS_INVALID_RESPONSE',
    ],
  ])('fails safely for %s', async (_name, response, code) => {
    await expect(
      sendTtsAcknowledgement(config, receiptKey, vi.fn(async () => response)),
    ).rejects.toMatchObject({ code });
  });

  it('maps an aborted request to a typed timeout without exposing transport details', async () => {
    const timeoutConfig = { ...config, timeoutMs: 10 };
    const fetchImpl = vi.fn(
      async (_url: URL, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private socket detail')),
            { once: true },
          );
        }),
    );

    await expect(
      sendTtsAcknowledgement(timeoutConfig, receiptKey, fetchImpl),
    ).rejects.toEqual(
      expect.objectContaining<TtsAcknowledgementError>({ code: 'TTS_TIMEOUT' }),
    );
  });
});

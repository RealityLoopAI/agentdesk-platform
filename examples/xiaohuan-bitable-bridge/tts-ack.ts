import { createHash } from 'node:crypto';

import type { TtsAckConfig } from './config.js';

const SHA256 = /^[a-f0-9]{64}$/;

export interface TtsAcknowledgement {
  requestId: string;
  taskId: string;
  queuePosition: number;
  duplicate: boolean;
}

export class TtsAcknowledgementError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TtsAcknowledgementError';
    this.code = code;
  }
}

export function createTtsReceiptKey(runId: string, captureId: string): string {
  if (runId.length < 1 || runId.length > 128 || captureId.length < 1 || captureId.length > 256) {
    throw new TtsAcknowledgementError(
      'TTS_INVALID_RECEIPT_SOURCE',
      'TTS acknowledgement receipt source is invalid',
    );
  }
  return createHash('sha256')
    .update(JSON.stringify({ runId, captureId }), 'utf8')
    .digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAcceptedResponse(value: unknown, requestId: string): TtsAcknowledgement {
  if (
    !isObject(value) ||
    value.accepted !== true ||
    value.request_id !== requestId ||
    typeof value.task_id !== 'string' ||
    value.task_id.length < 1 ||
    value.task_id.length > 128 ||
    !Number.isSafeInteger(value.queue_position) ||
    (value.queue_position as number) < 0 ||
    typeof value.duplicate !== 'boolean'
  ) {
    throw new TtsAcknowledgementError(
      'TTS_INVALID_RESPONSE',
      'Xiaohuan TTS returned an invalid acceptance response',
    );
  }
  return {
    requestId,
    taskId: value.task_id,
    queuePosition: value.queue_position as number,
    duplicate: value.duplicate,
  };
}

export async function sendTtsAcknowledgement(
  config: TtsAckConfig,
  receiptKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TtsAcknowledgement> {
  if (!config.enabled) {
    throw new TtsAcknowledgementError('TTS_DISABLED', 'Xiaohuan TTS acknowledgement is disabled');
  }
  if (!SHA256.test(receiptKey)) {
    throw new TtsAcknowledgementError('TTS_INVALID_RECEIPT_KEY', 'TTS acknowledgement receipt key is invalid');
  }

  const requestId = `xiaohuan-received-${receiptKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(new URL('/api/tts/speak', config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, text: config.text }),
      signal: controller.signal,
    });
    if (response.status !== 202) {
      throw new TtsAcknowledgementError(
        response.status === 429 ? 'TTS_QUEUE_FULL' : 'TTS_REJECTED',
        'Xiaohuan TTS did not accept the acknowledgement',
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TtsAcknowledgementError(
        'TTS_INVALID_RESPONSE',
        'Xiaohuan TTS returned invalid JSON',
        { cause: error },
      );
    }
    return parseAcceptedResponse(payload, requestId);
  } catch (error) {
    if (error instanceof TtsAcknowledgementError) throw error;
    if (controller.signal.aborted) {
      throw new TtsAcknowledgementError('TTS_TIMEOUT', 'Xiaohuan TTS acknowledgement timed out', {
        cause: error,
      });
    }
    throw new TtsAcknowledgementError(
      'TTS_NETWORK_ERROR',
      'Xiaohuan TTS acknowledgement could not be submitted',
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

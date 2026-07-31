import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { AudioPipelineError } from './errors.js';
import type { ExperimentAudioV1 } from './experiment-schema.js';
import type { SafeLogger } from './pipeline.js';
import { parseWav, type WavMetadata } from './wav.js';

export const WHOLE_UTTERANCE_AUDIO_PATH = '/api/audio';
export const WHOLE_UTTERANCE_HEALTH_PATH = '/healthz';

export interface WholeUtteranceHttpConfig {
  bindHost: string;
  port: number;
  outputDir?: string;
  maxBodyBytes: number;
  maxDurationMs: number;
  expectedSampleRate: number;
  maxQueue: number;
  requestTimeoutMs: number;
  keepUtterances: boolean;
}

export interface WholeUtteranceHttpOutput {
  captureId: string;
  result?: ExperimentAudioV1;
  errorCode?: string;
}

export interface WholeUtteranceHttpSummary {
  received: number;
  duplicates: number;
  succeeded: number;
  failed: number;
  rejected: number;
}

export interface WholeUtteranceHttpDependencies {
  logger?: SafeLogger;
  processUtterance(filePath: string, captureId: string): Promise<ExperimentAudioV1>;
  onOutput?(output: WholeUtteranceHttpOutput): void | Promise<void>;
  now?: () => Date;
}

export interface RunningWholeUtteranceHttpService {
  bindHost: string;
  port: number;
  outputRoot: string;
  done: Promise<WholeUtteranceHttpSummary>;
  close(): Promise<WholeUtteranceHttpSummary>;
}

interface AcceptedUtterance {
  captureId: string;
  filePath: string;
}

interface DuplicateReceipt {
  filename: string;
  durationMs: number;
}

interface PendingAcceptance extends DuplicateReceipt {
  filePath: string;
}

const silentLogger: SafeLogger = {
  info: () => undefined,
  error: () => undefined,
};

class HttpIngressError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'HttpIngressError';
    this.status = status;
    this.code = code;
  }
}

function integerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_HTTP_AUDIO_CONFIGURATION',
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

export function validateWholeUtteranceHttpConfig(config: WholeUtteranceHttpConfig): void {
  if (
    !config.bindHost.trim() ||
    config.bindHost.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(config.bindHost)
  ) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_HTTP_AUDIO_CONFIGURATION',
      'bindHost must be a non-empty safe host',
    );
  }
  // Port 0 is accepted for isolated tests; operator config requires 1-65535.
  integerInRange(config.port, 'port', 0, 65_535);
  integerInRange(config.maxBodyBytes, 'maxBodyBytes', 1, 50 * 1024 * 1024);
  integerInRange(config.maxDurationMs, 'maxDurationMs', 1, 120_000);
  integerInRange(config.expectedSampleRate, 'expectedSampleRate', 8_000, 192_000);
  integerInRange(config.maxQueue, 'maxQueue', 1, 64);
  integerInRange(config.requestTimeoutMs, 'requestTimeoutMs', 100, 60_000);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    Connection: 'close',
    ...extraHeaders,
  });
  response.end(body);
}

function validateUploadedWav(
  payload: Buffer,
  config: WholeUtteranceHttpConfig,
): WavMetadata {
  const metadata = parseWav(payload);
  const expectedBlockAlign = (metadata.channels * metadata.bitsPerSample) / 8;
  const expectedByteRate = metadata.sampleRate * expectedBlockAlign;
  if (
    metadata.audioFormat !== 1 ||
    metadata.channels !== 1 ||
    metadata.bitsPerSample !== 16 ||
    metadata.sampleRate !== config.expectedSampleRate ||
    metadata.blockAlign !== expectedBlockAlign ||
    metadata.byteRate !== expectedByteRate ||
    metadata.dataBytes % expectedBlockAlign !== 0 ||
    payload.readUInt32LE(4) + 8 !== payload.length
  ) {
    throw new HttpIngressError(400, 'invalid_audio_format');
  }
  if (metadata.durationMs <= 0 || metadata.durationMs > config.maxDurationMs) {
    throw new HttpIngressError(400, 'audio_duration_out_of_range');
  }
  return metadata;
}

async function readRequestBody(
  request: IncomingMessage,
  expectedBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    request.destroy(new Error('request body timeout'));
  }, timeoutMs);
  timeout.unref?.();

  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > expectedBytes) {
        throw new HttpIngressError(400, 'body_length_mismatch');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof HttpIngressError) throw error;
    throw new HttpIngressError(
      timedOut ? 408 : 400,
      timedOut ? 'request_timeout' : 'incomplete_request_body',
    );
  } finally {
    clearTimeout(timeout);
  }
  if (received !== expectedBytes) {
    throw new HttpIngressError(400, 'body_length_mismatch');
  }
  return Buffer.concat(chunks, received);
}

async function saveAtomically(
  outputRoot: string,
  payload: Buffer,
  hash: string,
  now: Date,
): Promise<{ filePath: string; filename: string }> {
  const dayDirectory = path.join(
    outputRoot,
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`,
  );
  await fs.mkdir(dayDirectory, { recursive: true });
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    '_',
    String(now.getMilliseconds()).padStart(3, '0'),
  ].join('');
  const filename = `${timestamp}_${hash.slice(0, 16)}.wav`;
  const filePath = path.join(dayDirectory, filename);
  const temporaryPath = path.join(dayDirectory, `.${filename}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
  return { filePath, filename };
}

function safeProcessingCode(error: unknown): string {
  if (error instanceof AudioPipelineError) return error.code;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^[A-Z0-9_:-]{1,128}$/.test((error as { code: string }).code)
  ) {
    return (error as { code: string }).code;
  }
  return 'UNEXPECTED_HTTP_UTTERANCE_ERROR';
}

export async function startWholeUtteranceHttpService(
  config: WholeUtteranceHttpConfig,
  dependencies: WholeUtteranceHttpDependencies,
): Promise<RunningWholeUtteranceHttpService> {
  validateWholeUtteranceHttpConfig(config);
  const logger = dependencies.logger ?? silentLogger;
  const now = dependencies.now ?? (() => new Date());
  const createdOutputRoot = !config.outputDir;
  const outputRoot = config.outputDir
    ? path.resolve(config.outputDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'xiaohuan-http-audio-'));
  await fs.mkdir(outputRoot, { recursive: true });

  const summary: WholeUtteranceHttpSummary = {
    received: 0,
    duplicates: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
  };
  const queue: AcceptedUtterance[] = [];
  const duplicateReceipts = new Map<string, DuplicateReceipt>();
  const pendingAcceptances = new Map<string, Promise<PendingAcceptance>>();
  const duplicateReceiptLimit = Math.max(64, config.maxQueue * 16);
  let processing = false;
  let processingPromise: Promise<void> | null = null;
  let closing = false;
  let closePromise: Promise<WholeUtteranceHttpSummary> | null = null;
  let resolveDone: (summary: WholeUtteranceHttpSummary) => void = () => undefined;
  const done = new Promise<WholeUtteranceHttpSummary>((resolve) => {
    resolveDone = resolve;
  });

  const rememberReceipt = (hash: string, receipt: DuplicateReceipt): void => {
    duplicateReceipts.set(hash, receipt);
    while (duplicateReceipts.size > duplicateReceiptLimit) {
      const oldest = duplicateReceipts.keys().next().value as string | undefined;
      if (!oldest) break;
      duplicateReceipts.delete(oldest);
    }
  };

  const runQueue = (): void => {
    if (processingPromise || queue.length === 0) return;
    processingPromise = (async () => {
      processing = true;
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        let output: WholeUtteranceHttpOutput;
        try {
          const result = await dependencies.processUtterance(item.filePath, item.captureId);
          summary.succeeded += 1;
          output = { captureId: item.captureId, result };
        } catch (error) {
          summary.failed += 1;
          const errorCode = safeProcessingCode(error);
          logger.error({
            event: 'xiaohuan_http_audio_utterance',
            outcome: 'error',
            captureId: item.captureId,
            code: errorCode,
          });
          output = { captureId: item.captureId, errorCode };
        }
        try {
          await dependencies.onOutput?.(output);
        } catch {
          logger.error({
            event: 'xiaohuan_http_audio_output_callback',
            outcome: 'error',
            captureId: item.captureId,
            code: 'HTTP_AUDIO_OUTPUT_CALLBACK_FAILED',
          });
        } finally {
          if (!config.keepUtterances) {
            await fs.unlink(item.filePath).catch(() => undefined);
          }
        }
      }
      processing = false;
    })().finally(() => {
      processingPromise = null;
      if (queue.length > 0) runQueue();
    });
  };

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        if (request.url !== WHOLE_UTTERANCE_HEALTH_PATH) {
          sendJson(response, 404, { ok: false, error: 'not_found' });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          service: 'xiaohuan_whole_utterance_receiver',
          received: summary.received,
          duplicates: summary.duplicates,
          failures: summary.failed + summary.rejected,
          queued: queue.length,
          processing,
        });
        return;
      }

      if (request.method !== 'POST' || request.url !== WHOLE_UTTERANCE_AUDIO_PATH) {
        sendJson(response, 404, { accepted: false, error: 'not_found' });
        return;
      }
      if (closing) {
        sendJson(response, 503, { accepted: false, error: 'service_stopping' });
        return;
      }
      const contentType = (request.headers['content-type'] ?? '')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'audio/wav') {
        summary.rejected += 1;
        sendJson(response, 415, {
          accepted: false,
          error: 'content_type_must_be_audio_wav',
        });
        return;
      }
      if (request.headers['transfer-encoding']) {
        summary.rejected += 1;
        sendJson(response, 411, {
          accepted: false,
          error: 'content_length_required',
        });
        return;
      }
      const rawContentLength = request.headers['content-length'];
      if (!rawContentLength || !/^[0-9]+$/.test(rawContentLength)) {
        summary.rejected += 1;
        sendJson(response, 411, {
          accepted: false,
          error: 'content_length_required',
        });
        return;
      }
      const contentLength = Number(rawContentLength);
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0 ||
        contentLength > config.maxBodyBytes
      ) {
        summary.rejected += 1;
        sendJson(response, 413, {
          accepted: false,
          error: 'request_too_large',
          max_body_bytes: config.maxBodyBytes,
        });
        return;
      }

      try {
        const payload = await readRequestBody(
          request,
          contentLength,
          config.requestTimeoutMs,
        );
        const metadata = validateUploadedWav(payload, config);
        const hash = createHash('sha256').update(payload).digest('hex');
        const duplicate = duplicateReceipts.get(hash);
        if (duplicate) {
          summary.duplicates += 1;
          sendJson(response, 202, {
            accepted: true,
            duplicate: true,
            filename: duplicate.filename,
            duration_seconds: Number((duplicate.durationMs / 1_000).toFixed(3)),
          });
          return;
        }
        const pendingAcceptance = pendingAcceptances.get(hash);
        if (pendingAcceptance) {
          try {
            const pendingReceipt = await pendingAcceptance;
            summary.duplicates += 1;
            sendJson(response, 202, {
              accepted: true,
              duplicate: true,
              filename: pendingReceipt.filename,
              duration_seconds: Number(
                (pendingReceipt.durationMs / 1_000).toFixed(3),
              ),
            });
          } catch {
            summary.rejected += 1;
            sendJson(response, 500, {
              accepted: false,
              error: 'audio_storage_failed',
            });
          }
          return;
        }
        if (queue.length + (processing ? 1 : 0) >= config.maxQueue) {
          summary.rejected += 1;
          sendJson(
            response,
            503,
            { accepted: false, error: 'audio_queue_full' },
            { 'Retry-After': '1' },
          );
          return;
        }

        const captureId = `xiaohuan-http-${hash}`;
        const acceptance = saveAtomically(outputRoot, payload, hash, now())
          .then((stored) => ({
            ...stored,
            durationMs: metadata.durationMs,
          }))
          .catch(() => {
            throw new HttpIngressError(500, 'audio_storage_failed');
          });
        pendingAcceptances.set(hash, acceptance);
        let stored: PendingAcceptance;
        try {
          stored = await acceptance;
        } finally {
          pendingAcceptances.delete(hash);
        }
        rememberReceipt(hash, {
          filename: stored.filename,
          durationMs: metadata.durationMs,
        });
        queue.push({ captureId, filePath: stored.filePath });
        summary.received += 1;
        runQueue();
        logger.info({
          event: 'xiaohuan_http_audio_accepted',
          outcome: 'ok',
          captureId,
          bytes: contentLength,
          durationMs: metadata.durationMs,
          queued: queue.length,
        });
        sendJson(response, 202, {
          accepted: true,
          duplicate: false,
          filename: stored.filename,
          duration_seconds: Number((metadata.durationMs / 1_000).toFixed(3)),
        });
      } catch (error) {
        summary.rejected += 1;
        const failure =
          error instanceof HttpIngressError
            ? error
            : new HttpIngressError(400, 'invalid_audio');
        sendJson(response, failure.status, {
          accepted: false,
          error: failure.code,
        });
      }
    })().catch(() => {
      summary.rejected += 1;
      sendJson(response, 500, {
        accepted: false,
        error: 'internal_receiver_error',
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.bindHost);
  }).catch(async (error) => {
    if (createdOutputRoot) {
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
    throw error;
  });

  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : config.port;

  const close = async (): Promise<WholeUtteranceHttpSummary> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await processingPromise;
      while (processingPromise || queue.length > 0) {
        runQueue();
        await processingPromise;
      }
      if (createdOutputRoot) {
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
      logger.info({
        event: 'xiaohuan_http_audio_service_stopped',
        outcome: 'ok',
        ...summary,
      });
      return { ...summary };
    })().then((finalSummary) => {
      resolveDone(finalSummary);
      return finalSummary;
    });
    return closePromise;
  };

  logger.info({
    event: 'xiaohuan_http_audio_service_started',
    outcome: 'ok',
    bindHost: config.bindHost,
    port: actualPort,
    maxBodyBytes: config.maxBodyBytes,
    maxDurationMs: config.maxDurationMs,
    maxQueue: config.maxQueue,
  });

  return {
    bindHost: config.bindHost,
    port: actualPort,
    outputRoot,
    done,
    close,
  };
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startWholeUtteranceHttpService,
  type RunningWholeUtteranceHttpService,
  type WholeUtteranceHttpConfig,
  type WholeUtteranceHttpOutput,
} from '../examples/xiaohuan-doubao-audio/whole-utterance-http-service.js';
import type { ExperimentAudioV1 } from '../examples/xiaohuan-doubao-audio/experiment-schema.js';
import { encodePcm16leWav } from '../examples/xiaohuan-doubao-audio/vad.js';

const roots: string[] = [];
const running: RunningWholeUtteranceHttpService[] = [];

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((service) => service.close()));
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function outputRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaohuan-http-test-'));
  roots.push(root);
  return root;
}

function config(root: string, overrides: Partial<WholeUtteranceHttpConfig> = {}): WholeUtteranceHttpConfig {
  return {
    bindHost: '127.0.0.1',
    port: 0,
    outputDir: root,
    maxBodyBytes: 4 * 1024 * 1024,
    maxDurationMs: 61_000,
    expectedSampleRate: 16_000,
    maxQueue: 8,
    requestTimeoutMs: 2_000,
    keepUtterances: false,
    ...overrides,
  };
}

function wav(seed = 1): Buffer {
  const pcm = Buffer.alloc(16_000 * 2);
  pcm.writeInt16LE(seed, 0);
  return encodePcm16leWav(pcm, 16_000, 1);
}

function result(captureId: string): ExperimentAudioV1 {
  return {
    schemaVersion: 'experiment-audio.v1',
    captureId,
    transcript: '测试语句',
    experiment: {
      title: null,
      sampleIds: [],
      actions: [],
      measurements: [],
      observations: [],
      notes: null,
    },
  };
}

async function post(
  service: RunningWholeUtteranceHttpService,
  body: Buffer,
  contentType = 'audio/wav',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${service.port}/api/audio`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

describe('Xiaohuan whole-utterance HTTP receiver', () => {
  it('accepts one durable WAV, reports health, and deduplicates an exact retry', async () => {
    const root = await outputRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processUtterance = vi.fn(async (_filePath: string, captureId: string) => {
      await gate;
      return result(captureId);
    });
    const outputs: WholeUtteranceHttpOutput[] = [];
    const service = await startWholeUtteranceHttpService(config(root), {
      processUtterance,
      onOutput: (output) => outputs.push(output),
      now: () => new Date('2026-07-30T14:18:00.123Z'),
    });
    running.push(service);

    const health = await fetch(`http://127.0.0.1:${service.port}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: 'xiaohuan_whole_utterance_receiver',
      received: 0,
    });

    const audio = wav();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(service, audio)),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const receipts = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Record<string, unknown>[];
    const originals = receipts.filter((receipt) => receipt.duplicate === false);
    const duplicates = receipts.filter((receipt) => receipt.duplicate === true);
    expect(originals).toHaveLength(1);
    expect(duplicates).toHaveLength(7);
    const receipt = originals[0]!;
    expect(receipt).toMatchObject({
      accepted: true,
      duration_seconds: 1,
    });
    expect(String(receipt.filename)).toMatch(/20260730_\d{6}_123_[a-f0-9]{16}\.wav/);
    expect(processUtterance).toHaveBeenCalledOnce();

    expect(duplicates.every((item) => item.filename === receipt.filename)).toBe(true);
    expect(processUtterance).toHaveBeenCalledOnce();

    release?.();
    const summary = await service.close();
    expect(summary).toEqual({
      received: 1,
      duplicates: 7,
      succeeded: 1,
      failed: 0,
      rejected: 0,
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.captureId).toMatch(/^xiaohuan-http-[a-f0-9]{64}$/);
    await expect(fs.stat(path.join(root, '2026-07-30', String(receipt.filename))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsupported content and malformed WAV without model work', async () => {
    const root = await outputRoot();
    const processUtterance = vi.fn(async (_filePath: string, captureId: string) => result(captureId));
    const service = await startWholeUtteranceHttpService(config(root), {
      processUtterance,
    });
    running.push(service);

    const wrongType = await post(service, wav(), 'application/octet-stream');
    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toMatchObject({
      accepted: false,
      error: 'content_type_must_be_audio_wav',
    });

    const malformed = await post(service, Buffer.from('not-a-wav'));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      accepted: false,
      error: 'invalid_audio',
    });
    expect(processUtterance).not.toHaveBeenCalled();
  });

  it('returns a retryable non-2xx response when the bounded model queue is full', async () => {
    const root = await outputRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processUtterance = vi.fn(async (_filePath: string, captureId: string) => {
      await gate;
      return result(captureId);
    });
    const service = await startWholeUtteranceHttpService(
      config(root, { maxQueue: 1 }),
      { processUtterance },
    );
    running.push(service);

    expect((await post(service, wav(1))).status).toBe(202);
    const full = await post(service, wav(2));
    expect(full.status).toBe(503);
    expect(full.headers.get('retry-after')).toBe('1');
    await expect(full.json()).resolves.toMatchObject({
      accepted: false,
      error: 'audio_queue_full',
    });

    release?.();
    const summary = await service.close();
    expect(summary.received).toBe(1);
    expect(summary.rejected).toBe(1);
  });

  it('isolates one Ark failure and continues with a later accepted WAV', async () => {
    const root = await outputRoot();
    let calls = 0;
    const outputs: WholeUtteranceHttpOutput[] = [];
    const service = await startWholeUtteranceHttpService(config(root), {
      processUtterance: async (_filePath, captureId) => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('private upstream detail'), {
            code: 'ARK_UPSTREAM_ERROR',
          });
        }
        return result(captureId);
      },
      onOutput: (output) => outputs.push(output),
    });
    running.push(service);

    expect((await post(service, wav(3))).status).toBe(202);
    expect((await post(service, wav(4))).status).toBe(202);
    const summary = await service.close();
    expect(summary).toMatchObject({ received: 2, failed: 1, succeeded: 1 });
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ errorCode: 'ARK_UPSTREAM_ERROR' });
    expect(outputs[1]?.result?.schemaVersion).toBe('experiment-audio.v1');
  });
});

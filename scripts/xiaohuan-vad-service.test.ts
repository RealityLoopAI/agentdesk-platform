import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExperimentAudioV1 } from '../examples/xiaohuan-doubao-audio/experiment-schema.js';
import {
  parseVadServiceArgs,
  type VadServiceConfig,
} from '../examples/xiaohuan-doubao-audio/vad-service-config.js';
import {
  buildVadFfmpegArgs,
  runVadListeningService,
} from '../examples/xiaohuan-doubao-audio/vad-listening-service.js';
import {
  EnergyVad,
  PcmFrameAccumulator,
  encodePcm16leWav,
  normalizePcm16lePeak,
  pcm16leDbfs,
  pcmFrameBytes,
  type EnergyVadConfig,
} from '../examples/xiaohuan-doubao-audio/vad.js';
import { parseWav } from '../examples/xiaohuan-doubao-audio/wav.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaohuan-vad-test-'));
  tempDirs.push(directory);
  return directory;
}

function frame(amplitude: number, samples = 320): Buffer {
  const output = Buffer.alloc(samples * 2);
  for (let offset = 0; offset < output.length; offset += 2) {
    output.writeInt16LE(offset % 4 === 0 ? amplitude : -amplitude, offset);
  }
  return output;
}

const silence = (): Buffer => frame(0);
const voice = (): Buffer => frame(10_000);

function smallVad(overrides: Partial<EnergyVadConfig> = {}): EnergyVadConfig {
  return {
    sampleRate: 16_000,
    frameMs: 20,
    thresholdDb: -30,
    startFrames: 2,
    preRollMs: 40,
    trailingSilenceMs: 40,
    minSpeechMs: 40,
    maxUtteranceMs: 2_000,
    ...overrides,
  };
}

function serviceConfig(overrides: Partial<VadServiceConfig> = {}): VadServiceConfig {
  return {
    sdpPath: '/tmp/xiaohuan.sdp',
    ffmpegPath: 'ffmpeg',
    vad: smallVad(),
    maxQueue: 4,
    maxUtterances: 2,
    firstAudioTimeoutMs: 1_000,
    stopGraceMs: 20,
    keepUtterances: false,
    processUtterances: false,
    allowExternalUpload: false,
    capturePrefix: 'vad-test',
    normalizePeakDb: -3,
    maxNormalizeGainDb: 30,
    ...overrides,
    vad: { ...smallVad(), ...overrides.vad },
  };
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeSpawn(
  producer: (child: FakeChild) => Promise<void>,
): { spawn: any; child: FakeChild; calls: unknown[][] } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close', null, signal));
    }
    return true;
  });
  const calls: unknown[][] = [];
  const spawn = vi.fn((...args: unknown[]) => {
    calls.push(args);
    queueMicrotask(() => {
      void producer(child).catch((error) => child.emit('error', error));
    });
    return child;
  });
  return { spawn, child, calls };
}

function closeChild(child: FakeChild, code = 0): void {
  child.exitCode = code;
  child.emit('close', code, null);
}

function utteranceFrames(): Buffer[] {
  return [silence(), silence(), voice(), voice(), voice(), voice(), silence(), silence()];
}

function twoUtterances(): Buffer {
  return Buffer.concat([
    ...utteranceFrames(),
    silence(),
    ...utteranceFrames(),
  ]);
}

function experiment(captureId: string): ExperimentAudioV1 {
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

describe('PCM energy VAD', () => {
  it('computes dBFS and handles digital silence', () => {
    expect(pcm16leDbfs(silence())).toBe(Number.NEGATIVE_INFINITY);
    expect(pcm16leDbfs(frame(3277))).toBeCloseTo(-20, 1);
  });

  it('assembles fixed frames across arbitrary stream chunks', () => {
    const accumulator = new PcmFrameAccumulator(640);
    const bytes = Buffer.concat([voice(), silence()]);
    expect(accumulator.push(bytes.subarray(0, 100))).toHaveLength(0);
    expect(accumulator.push(bytes.subarray(100, 900))).toHaveLength(1);
    expect(accumulator.push(bytes.subarray(900))).toHaveLength(1);
    expect(accumulator.pendingBytes()).toBe(0);
  });

  it('keeps pre-roll and completes on trailing silence', () => {
    const vad = new EnergyVad(smallVad());
    const events = utteranceFrames().flatMap((item) => vad.pushFrame(item));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'utterance',
      utterance: { reason: 'silence', voicedMs: 80 },
    });
    if (events[0]?.type === 'utterance') {
      expect(events[0].utterance.durationMs).toBe(120);
      expect(events[0].utterance.pcm.length).toBe(120 * 32);
    }
  });

  it('discards a short impulse', () => {
    const vad = new EnergyVad(
      smallVad({ startFrames: 1, minSpeechMs: 60, trailingSilenceMs: 40 }),
    );
    const events = [voice(), silence(), silence()].flatMap((item) => vad.pushFrame(item));
    expect(events).toEqual([
      { type: 'discard', discard: { reason: 'too-short', voicedMs: 20 } },
    ]);
  });

  it('force-completes continuous speech at the maximum duration', () => {
    const vad = new EnergyVad(
      smallVad({ startFrames: 1, preRollMs: 20, maxUtteranceMs: 80 }),
    );
    const events = [voice(), voice(), voice(), voice()].flatMap((item) =>
      vad.pushFrame(item),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'utterance',
      utterance: { reason: 'max-duration', durationMs: 80 },
    });
  });

  it('flushes only a valid active utterance', () => {
    const idle = new EnergyVad(smallVad());
    expect(idle.flush()).toEqual([]);
    const active = new EnergyVad(smallVad());
    active.pushFrame(voice());
    active.pushFrame(voice());
    active.pushFrame(voice());
    expect(active.flush()).toEqual([
      expect.objectContaining({
        type: 'utterance',
        utterance: expect.objectContaining({ reason: 'flush', voicedMs: 60 }),
      }),
    ]);
  });

  it('encodes a WAV accepted by the existing parser', () => {
    expect(parseWav(encodePcm16leWav(Buffer.concat([voice(), voice()])))).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      durationMs: 40,
    });
  });

  it('applies bounded peak normalization without clipping', () => {
    const normalized = normalizePcm16lePeak(frame(1_000), -3, 20);
    expect(normalized.gainDb).toBe(20);
    expect(pcm16leDbfs(normalized.pcm)).toBeCloseTo(pcm16leDbfs(frame(1_000)) + 20, 1);
    expect(normalizePcm16lePeak(frame(30_000), -3, 30).gainDb).toBeLessThan(0);
  });
});

describe('VAD service configuration', () => {
  it('parses calibrated defaults and explicit upload mode', () => {
    expect(
      parseVadServiceArgs([
        '--sdp',
        './input.sdp',
        '--threshold-db',
        '-38',
        '--max-utterances',
        '2',
        '--process',
        '--allow-external-upload',
      ]),
    ).toMatchObject({
      sdpPath: path.resolve('./input.sdp'),
      vad: { thresholdDb: -38, frameMs: 20 },
      maxUtterances: 2,
      processUtterances: true,
      allowExternalUpload: true,
    });
  });

  it.each([
    [[], 'INVALID_VAD_SERVICE_ARGUMENTS'],
    [['--sdp', 'a.sdp', '--threshold-db', '0'], 'INVALID_VAD_SERVICE_CONFIGURATION'],
    [['--sdp', 'a.sdp', '--max-queue', '0'], 'INVALID_VAD_SERVICE_CONFIGURATION'],
    [['--sdp', 'a.sdp', '--process'], 'EXTERNAL_UPLOAD_NOT_CONFIRMED'],
  ])('rejects invalid service arguments', (args, code) => {
    expect(() => parseVadServiceArgs(args)).toThrowError(expect.objectContaining({ code }));
  });

  it('builds a continuous no-shell raw PCM command', () => {
    const args = buildVadFfmpegArgs(serviceConfig());
    expect(args).toContain('file,udp,rtp');
    expect(args).toContain('pcm_s16le');
    expect(args).toContain('s16le');
    expect(args.at(-1)).toBe('pipe:1');
    expect(args).not.toContain('-t');
    expect(args).not.toContain('segment');
  });
});

describe('continuous VAD listening service', () => {
  it('captures two utterances without using a model', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (child) => {
      child.stdout.write(twoUtterances());
    });
    const processor = vi.fn();
    const outputs: unknown[] = [];
    const summary = await runVadListeningService(serviceConfig({ outputDir }), {
      spawnProcess: fake.spawn,
      processUtterance: processor,
      onOutput: (output) => outputs.push(output),
    });
    expect(summary).toMatchObject({ accepted: 2, succeeded: 2, failed: 0 });
    expect(outputs).toHaveLength(2);
    expect(processor).not.toHaveBeenCalled();
    expect(fake.calls[0]?.[2]).toMatchObject({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('keeps consuming while a slow processor runs and stays serial', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (child) => child.stdout.write(twoUtterances()));
    let active = 0;
    let maximum = 0;
    const order: string[] = [];
    const processor = vi.fn(async (_filePath: string, captureId: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(captureId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return experiment(captureId);
    });
    const summary = await runVadListeningService(
      serviceConfig({
        outputDir,
        processUtterances: true,
        allowExternalUpload: true,
      }),
      { spawnProcess: fake.spawn, processUtterance: processor },
    );
    expect(summary).toMatchObject({ accepted: 2, succeeded: 2, failed: 0 });
    expect(maximum).toBe(1);
    expect(order).toEqual(['vad-test-000001', 'vad-test-000002']);
  });

  it('signals a validated complete WAV before starting Ark processing', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (child) => child.stdout.write(Buffer.concat(utteranceFrames())));
    const order: string[] = [];
    const summary = await runVadListeningService(
      serviceConfig({
        outputDir,
        maxUtterances: 1,
        processUtterances: true,
        allowExternalUpload: true,
      }),
      {
        spawnProcess: fake.spawn,
        onWavReady: (event) => {
          order.push(`ready:${event.captureId}`);
          expect(event.metadata.dataBytes).toBeGreaterThan(0);
        },
        processUtterance: async (_filePath, captureId) => {
          order.push(`process:${captureId}`);
          return experiment(captureId);
        },
      },
    );
    expect(summary).toMatchObject({ accepted: 1, succeeded: 1, failed: 0 });
    expect(order).toEqual([
      'ready:vad-test-000001',
      'process:vad-test-000001',
    ]);
  });

  it('isolates one utterance failure and processes the next', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (child) => child.stdout.write(twoUtterances()));
    const processor = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider detail'))
      .mockImplementationOnce(async (_filePath, captureId) => experiment(captureId));
    const events: Record<string, unknown>[] = [];
    const summary = await runVadListeningService(
      serviceConfig({
        outputDir,
        processUtterances: true,
        allowExternalUpload: true,
      }),
      {
        spawnProcess: fake.spawn,
        processUtterance: processor,
        logger: {
          info: (event) => events.push(event),
          error: (event) => events.push(event),
        },
      },
    );
    expect(summary).toMatchObject({ accepted: 2, succeeded: 1, failed: 1 });
    expect(processor).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain('provider detail');
  });

  it('fails closed when slow processing fills the queue', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (child) => {
      child.stdout.write(Buffer.concat([twoUtterances(), ...utteranceFrames()]));
    });
    await expect(
      runVadListeningService(
        serviceConfig({
          outputDir,
          maxQueue: 1,
          maxUtterances: 0,
          processUtterances: true,
          allowExternalUpload: true,
        }),
        {
          spawnProcess: fake.spawn,
          processUtterance: async (_filePath, captureId) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return experiment(captureId);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'QUEUE_OVERFLOW' });
  });

  it('times out without the first PCM bytes', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async () => undefined);
    await expect(
      runVadListeningService(
        serviceConfig({ outputDir, maxUtterances: 0, firstAudioTimeoutMs: 5 }),
        { spawnProcess: fake.spawn },
      ),
    ).rejects.toMatchObject({ code: 'NO_AUDIO_RECEIVED' });
    expect(fake.child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('flushes a valid in-progress sentence on signal', async () => {
    const outputDir = await tempDirectory();
    const abort = new AbortController();
    const fake = fakeSpawn(async (child) => {
      child.stdout.write(Buffer.concat([voice(), voice(), voice()]));
      queueMicrotask(() => abort.abort());
    });
    const outputs: unknown[] = [];
    const summary = await runVadListeningService(
      serviceConfig({ outputDir, maxUtterances: 0 }),
      {
        spawnProcess: fake.spawn,
        signal: abort.signal,
        onOutput: (output) => outputs.push(output),
      },
    );
    expect(summary).toMatchObject({ accepted: 1, succeeded: 1 });
    expect(outputs).toHaveLength(1);
  });

  it('cleans its program-created temporary directory by default', async () => {
    const listServiceTemps = async (): Promise<string[]> =>
      (await fs.readdir(os.tmpdir()))
        .filter((name) => /^xiaohuan-vad-[A-Za-z0-9]{6}$/.test(name))
        .sort();
    const before = await listServiceTemps();
    const fake = fakeSpawn(async (child) => child.stdout.write(Buffer.concat(utteranceFrames())));
    const outputs: Array<{ retainedPath?: string }> = [];
    await runVadListeningService(serviceConfig({ maxUtterances: 1 }), {
      spawnProcess: fake.spawn,
      onOutput: (output) => outputs.push(output),
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.retainedPath).toBeUndefined();
    expect(await listServiceTemps()).toEqual(before);
  });

  it('reports an unexpected FFmpeg exit', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (child) => closeChild(child, 1));
    await expect(
      runVadListeningService(serviceConfig({ outputDir, maxUtterances: 0 }), {
        spawnProcess: fake.spawn,
      }),
    ).rejects.toMatchObject({ code: 'FFMPEG_EXIT', retryable: true });
  });

  it('accepts FFmpeg code 255 after an intentional signal stop', async () => {
    const outputDir = await tempDirectory();
    const abort = new AbortController();
    const fake = fakeSpawn(async (child) => {
      child.stdout.write(Buffer.concat([silence(), silence()]));
      child.kill.mockImplementationOnce(() => {
        child.exitCode = 255;
        queueMicrotask(() => child.emit('close', 255, null));
        return true;
      });
      queueMicrotask(() => abort.abort());
    });
    await expect(
      runVadListeningService(serviceConfig({ outputDir, maxUtterances: 0 }), {
        spawnProcess: fake.spawn,
        signal: abort.signal,
      }),
    ).resolves.toMatchObject({ accepted: 0 });
  });
});

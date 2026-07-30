import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExperimentAudioV1 } from '../examples/xiaohuan-doubao-audio/experiment-schema.js';
import {
  parseRealtimeArgs,
  validateRealtimeSdp,
  type RealtimeConfig,
} from '../examples/xiaohuan-doubao-audio/realtime-config.js';
import {
  buildFfmpegSegmentArgs,
  runRealtimeIngress,
} from '../examples/xiaohuan-doubao-audio/realtime-ingress.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaohuan-realtime-test-'));
  tempDirs.push(directory);
  return directory;
}

function pcmWav(durationMs = 100, sampleRate = 16_000): Buffer {
  const dataBytes = Math.round((sampleRate * 16 * durationMs) / 8 / 1000);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function config(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
  return {
    sdpPath: '/tmp/xiaohuan.sdp',
    ffmpegPath: 'ffmpeg',
    segmentSeconds: 8,
    maxSegments: 1,
    maxQueue: 4,
    firstSegmentTimeoutMs: 1_000,
    stopGraceMs: 20,
    keepSegments: false,
    processSegments: false,
    allowExternalUpload: false,
    capturePrefix: 'test-live',
    ...overrides,
  };
}

interface FakeChild extends EventEmitter {
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeSpawn(
  producer: (pattern: string, child: FakeChild) => Promise<void>,
): { spawn: any; child: FakeChild; options: unknown[] } {
  const child = new EventEmitter() as FakeChild;
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
  const options: unknown[] = [];
  const spawn = vi.fn((_command: string, args: string[], spawnOptions: unknown) => {
    options.push(spawnOptions);
    const pattern = args.at(-1) as string;
    queueMicrotask(() => {
      void producer(pattern, child).catch((error) => child.emit('error', error));
    });
    return child;
  });
  return { spawn, child, options };
}

async function writeSegment(pattern: string, index: number, bytes = pcmWav()): Promise<void> {
  const filePath = pattern.replace('%06d', String(index).padStart(6, '0'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}

function closeChild(child: FakeChild, code = 0): void {
  child.exitCode = code;
  child.emit('close', code, null);
}

function experiment(captureId: string): ExperimentAudioV1 {
  return {
    schemaVersion: 'experiment-audio.v1',
    captureId,
    transcript: '测试语音',
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

describe('realtime configuration and SDP', () => {
  it('defaults to capture-only and parses bounded options', () => {
    expect(
      parseRealtimeArgs([
        '--sdp',
        './input.sdp',
        '--segment-seconds',
        '7',
        '--max-segments',
        '2',
        '--max-queue',
        '3',
        '--capture-prefix',
        'mac-live',
      ]),
    ).toMatchObject({
      sdpPath: path.resolve('./input.sdp'),
      segmentSeconds: 7,
      maxSegments: 2,
      maxQueue: 3,
      processSegments: false,
      allowExternalUpload: false,
      capturePrefix: 'mac-live',
    });
  });

  it.each([
    [[], 'INVALID_REALTIME_ARGUMENTS'],
    [['--sdp', 'a.sdp', '--segment-seconds', '0'], 'INVALID_REALTIME_CONFIGURATION'],
    [['--sdp', 'a.sdp', '--max-segments', '101'], 'INVALID_REALTIME_CONFIGURATION'],
    [['--sdp', 'a.sdp', '--process'], 'EXTERNAL_UPLOAD_NOT_CONFIRMED'],
    [['--sdp', 'a.sdp', '--allow-external-upload'], 'EXTERNAL_UPLOAD_NOT_CONFIRMED'],
  ])('fails closed for invalid args', (args, code) => {
    expect(() => parseRealtimeArgs(args)).toThrowError(expect.objectContaining({ code }));
  });

  it('accepts explicit process plus upload acknowledgement', () => {
    expect(
      parseRealtimeArgs(['--sdp', 'a.sdp', '--process', '--allow-external-upload']),
    ).toMatchObject({ processSegments: true, allowExternalUpload: true });
  });

  it('validates the bundled macOS SDP and rejects the wrong codec mapping', async () => {
    const bundled = path.resolve(
      'examples/xiaohuan-doubao-audio/xiaohuan-realtime-macos.sdp',
    );
    await expect(validateRealtimeSdp(bundled)).resolves.toContain(
      'm=audio 50020 RTP/AVP 96',
    );
    const directory = await tempDirectory();
    const invalid = path.join(directory, 'invalid.sdp');
    await fs.writeFile(
      invalid,
      'v=0\nm=audio 50020 RTP/AVP 97\na=rtpmap:97 PCMU/8000\n',
    );
    await expect(validateRealtimeSdp(invalid)).rejects.toMatchObject({
      code: 'INVALID_SDP',
    });
  });

  it('builds fixed no-shell RTP to PCM segment arguments', () => {
    const args = buildFfmpegSegmentArgs(config({ maxSegments: 2 }), '/tmp/segment-%06d.wav');
    expect(args).toContain('file,udp,rtp');
    expect(args).toContain('pcm_s16le');
    expect(args).toContain('16000');
    expect(args).toContain('segment');
    expect(args).toContain('wav');
    expect(args[args.indexOf('-t') + 1]).toBe('16');
    expect(args.at(-1)).toBe('/tmp/segment-%06d.wav');
  });
});

describe('realtime ingress lifecycle', () => {
  it('captures a finalized segment locally without a model processor', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (pattern, child) => {
      await writeSegment(pattern, 0);
      closeChild(child);
    });
    const processor = vi.fn();
    const result = await runRealtimeIngress(config({ outputDir }), {
      spawnProcess: fake.spawn,
      processSegment: processor,
      pollIntervalMs: 1,
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      captureId: 'test-live-001',
      index: 0,
      retainedPath: path.join(outputDir, 'segment-000000.wav'),
    });
    expect(processor).not.toHaveBeenCalled();
    expect(fake.options).toEqual([
      expect.objectContaining({ shell: false, stdio: ['ignore', 'ignore', 'pipe'] }),
    ]);
  });

  it('processes finalized segments exactly once and serially', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (pattern, child) => {
      await writeSegment(pattern, 0);
      await writeSegment(pattern, 1);
      closeChild(child);
    });
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const processor = vi.fn(async (_filePath: string, captureId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(captureId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return experiment(captureId);
    });
    const result = await runRealtimeIngress(
      config({
        outputDir,
        maxSegments: 2,
        processSegments: true,
        allowExternalUpload: true,
      }),
      {
        spawnProcess: fake.spawn,
        processSegment: processor,
        pollIntervalMs: 1,
      },
    );
    expect(order).toEqual(['test-live-001', 'test-live-002']);
    expect(maximumActive).toBe(1);
    expect(result.segments.map((segment) => segment.result?.captureId)).toEqual(order);
  });

  it('rejects an empty final WAV as no audio', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (pattern, child) => {
      await writeSegment(pattern, 0, Buffer.alloc(44));
      closeChild(child);
    });
    await expect(
      runRealtimeIngress(config({ outputDir }), {
        spawnProcess: fake.spawn,
        pollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'NO_AUDIO_RECEIVED', stage: 'realtime' });
  });

  it('reports no audio when FFmpeg exits without a segment', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (_pattern, child) => closeChild(child));
    await expect(
      runRealtimeIngress(config({ outputDir }), {
        spawnProcess: fake.spawn,
        pollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'NO_AUDIO_RECEIVED' });
  });

  it('stops a silent child at the first-segment timeout', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async () => undefined);
    let tick = 0;
    await expect(
      runRealtimeIngress(config({ outputDir, firstSegmentTimeoutMs: 1_000 }), {
        spawnProcess: fake.spawn,
        pollIntervalMs: 1,
        now: () => {
          tick += 600;
          return tick;
        },
      }),
    ).rejects.toMatchObject({ code: 'NO_AUDIO_RECEIVED' });
    expect(fake.child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('fails rather than silently dropping an overflowing queue', async () => {
    const outputDir = await tempDirectory();
    let processingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      processingStarted = resolve;
    });
    const fake = fakeSpawn(async (pattern, child) => {
      await writeSegment(pattern, 0);
      await writeSegment(pattern, 1);
      await started;
      await Promise.all([2, 3, 4].map((index) => writeSegment(pattern, index)));
      closeChild(child);
    });
    await expect(
      runRealtimeIngress(
        config({
          outputDir,
          maxSegments: 5,
          maxQueue: 2,
          processSegments: true,
          allowExternalUpload: true,
        }),
        {
          spawnProcess: fake.spawn,
          pollIntervalMs: 1,
          processSegment: async (_filePath, captureId) => {
            processingStarted();
            await new Promise((resolve) => setTimeout(resolve, 10));
            return experiment(captureId);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'QUEUE_OVERFLOW' });
  });

  it('reports abnormal FFmpeg exit after validating the final segment', async () => {
    const outputDir = await tempDirectory();
    const fake = fakeSpawn(async (pattern, child) => {
      await writeSegment(pattern, 0);
      closeChild(child, 1);
    });
    await expect(
      runRealtimeIngress(config({ outputDir }), {
        spawnProcess: fake.spawn,
        pollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'FFMPEG_EXIT', retryable: true });
  });

  it('forwards interruption to FFmpeg and cleans its temporary directory', async () => {
    const abort = new AbortController();
    let generatedDirectory = '';
    const fake = fakeSpawn(async (pattern) => {
      generatedDirectory = path.dirname(pattern);
      setTimeout(() => abort.abort(), 2);
    });
    await expect(
      runRealtimeIngress(config(), {
        spawnProcess: fake.spawn,
        pollIntervalMs: 1,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'NO_AUDIO_RECEIVED' });
    expect(fake.child.kill).toHaveBeenCalledWith('SIGINT');
    await expect(fs.stat(generatedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not expose FFmpeg stderr content through safe logs', async () => {
    const outputDir = await tempDirectory();
    const events: Record<string, unknown>[] = [];
    const fake = fakeSpawn(async (_pattern, child) => {
      child.stderr.write('sensitive-path-or-packet-detail');
      closeChild(child, 1);
    });
    await expect(
      runRealtimeIngress(config({ outputDir }), {
        spawnProcess: fake.spawn,
        pollIntervalMs: 1,
        logger: {
          info: (event) => events.push(event),
          error: (event) => events.push(event),
        },
      }),
    ).rejects.toBeDefined();
    expect(JSON.stringify(events)).not.toContain('sensitive-path-or-packet-detail');
    expect(events).toContainEqual(
      expect.objectContaining({ ffmpegDiagnosticAvailable: true }),
    );
  });
});

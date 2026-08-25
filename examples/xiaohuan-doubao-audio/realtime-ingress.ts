import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AudioPipelineError } from './errors.js';
import type { ExperimentAudioV1 } from './experiment-schema.js';
import type { SafeLogger } from './pipeline.js';
import type { RealtimeConfig } from './realtime-config.js';
import { loadWav, type WavMetadata } from './wav.js';

const SEGMENT_PATTERN = /^segment-(\d{6})\.wav$/;
const STDERR_TAIL_BYTES = 4 * 1024;

export interface RealtimeSegment {
  captureId: string;
  index: number;
  metadata: WavMetadata;
  retainedPath?: string;
  result?: ExperimentAudioV1;
}

export interface RealtimeRunResult {
  segments: RealtimeSegment[];
  retainedDirectory?: string;
}

export interface RealtimeIngressDependencies {
  spawnProcess?: typeof spawn;
  processSegment?: (filePath: string, captureId: string) => Promise<ExperimentAudioV1>;
  logger?: SafeLogger;
  now?: () => number;
  pollIntervalMs?: number;
  maxWavBytes?: number;
  maxWavDurationMs?: number;
  signal?: AbortSignal;
}

const silentLogger: SafeLogger = {
  info: () => undefined,
  error: () => undefined,
};

export function buildFfmpegSegmentArgs(
  config: RealtimeConfig,
  outputPattern: string,
): string[] {
  return [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-protocol_whitelist',
    'file,udp,rtp',
    '-i',
    config.sdpPath,
    '-t',
    String(config.segmentSeconds * config.maxSegments),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'segment',
    '-segment_time',
    String(config.segmentSeconds),
    '-reset_timestamps',
    '1',
    '-segment_format',
    'wav',
    outputPattern,
  ];
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listSegmentPaths(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SEGMENT_PATTERN.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function segmentIndex(filePath: string): number {
  const match = SEGMENT_PATTERN.exec(path.basename(filePath));
  if (!match) {
    throw new AudioPipelineError(
      'realtime',
      'INVALID_SEGMENT_NAME',
      'FFmpeg produced an unexpected segment name',
    );
  }
  return Number(match[1]);
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`;
  return next.length <= STDERR_TAIL_BYTES ? next : next.slice(-STDERR_TAIL_BYTES);
}

async function stopChild(child: ChildProcess, exitPromise: Promise<void>, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exitPromise;
    return;
  }
  child.kill('SIGINT');
  const graceful = await Promise.race([
    exitPromise.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exitPromise;
  }
}

export async function runRealtimeIngress(
  config: RealtimeConfig,
  dependencies: RealtimeIngressDependencies = {},
): Promise<RealtimeRunResult> {
  if (config.processSegments && !dependencies.processSegment) {
    throw new AudioPipelineError(
      'configuration',
      'MISSING_SEGMENT_PROCESSOR',
      'Process mode requires a segment processor',
    );
  }

  const logger = dependencies.logger ?? silentLogger;
  const now = dependencies.now ?? Date.now;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 100;
  const maxWavBytes = dependencies.maxWavBytes ?? 10 * 1024 * 1024;
  const maxWavDurationMs = dependencies.maxWavDurationMs ?? 20_000;
  const createdTempDirectory = !config.outputDir;
  const outputDirectory =
    config.outputDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'xiaohuan-realtime-')));
  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPattern = path.join(outputDirectory, 'segment-%06d.wav');
  const args = buildFfmpegSegmentArgs(config, outputPattern);
  const startedAt = now();
  let stderrTail = '';
  let spawnError: unknown;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let child: ChildProcess | undefined;
  let exitPromise: Promise<void> = Promise.resolve();
  const processedPaths = new Set<string>();
  const segments: RealtimeSegment[] = [];
  let caughtError: unknown;
  const abortHandler = (): void => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT');
    }
  };

  try {
    child = spawnProcess(config.ffmpegPath, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk);
    });
    exitPromise = new Promise<void>((resolve) => {
      child?.once('error', (error) => {
        spawnError = error;
      });
      child?.once('close', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });
    dependencies.signal?.addEventListener('abort', abortHandler, { once: true });
    logger.info({
      event: 'xiaohuan_realtime_started',
      mode: config.processSegments ? 'process' : 'capture',
      segmentSeconds: config.segmentSeconds,
      maxSegments: config.maxSegments,
    });

    while (true) {
      const paths = await listSegmentPaths(outputDirectory);
      const finalized = exited ? paths : paths.slice(0, -1);
      const pending = finalized.filter((filePath) => !processedPaths.has(filePath));

      if (pending.length > config.maxQueue) {
        throw new AudioPipelineError(
          'realtime',
          'QUEUE_OVERFLOW',
          'Realtime segment queue exceeded its configured bound',
        );
      }

      for (const filePath of pending) {
        if (segments.length >= config.maxSegments) {
          break;
        }
        let loaded;
        try {
          loaded = await loadWav(filePath, {
            maxBytes: maxWavBytes,
            maxDurationMs: maxWavDurationMs,
          });
        } catch (error) {
          if (segments.length === 0 && exited) {
            throw new AudioPipelineError(
              'realtime',
              'NO_AUDIO_RECEIVED',
              'No valid audio was received before FFmpeg exited',
              { cause: error },
            );
          }
          throw error;
        }

        const index = segmentIndex(filePath);
        const captureId = `${config.capturePrefix}-${String(index + 1).padStart(3, '0')}`;
        const result = config.processSegments
          ? await dependencies.processSegment?.(filePath, captureId)
          : undefined;
        processedPaths.add(filePath);
        const retained =
          Boolean(config.outputDir) || config.keepSegments ? filePath : undefined;
        segments.push({
          captureId,
          index,
          metadata: loaded.metadata,
          ...(retained ? { retainedPath: retained } : {}),
          ...(result ? { result } : {}),
        });
        logger.info({
          event: 'xiaohuan_realtime_segment',
          outcome: 'ok',
          captureId,
          index,
          bytes: loaded.metadata.bytes,
          wavDurationMs: loaded.metadata.durationMs,
          retained: Boolean(retained),
          processed: config.processSegments,
        });
      }

      if (segments.length >= config.maxSegments && child) {
        await stopChild(child, exitPromise, config.stopGraceMs);
      }
      if (exited) {
        const remaining = (await listSegmentPaths(outputDirectory)).filter(
          (filePath) => !processedPaths.has(filePath),
        );
        if (remaining.length === 0 || segments.length >= config.maxSegments) {
          break;
        }
      } else if (segments.length === 0 && now() - startedAt >= config.firstSegmentTimeoutMs) {
        if (child) {
          await stopChild(child, exitPromise, config.stopGraceMs);
        }
        throw new AudioPipelineError(
          'realtime',
          'NO_AUDIO_RECEIVED',
          'No completed audio segment arrived before the configured timeout',
        );
      }
      await delay(pollIntervalMs);
    }

    if (spawnError) {
      throw new AudioPipelineError(
        'realtime',
        'FFMPEG_SPAWN_FAILED',
        'FFmpeg could not be started',
        { cause: spawnError },
      );
    }
    if (segments.length === 0) {
      throw new AudioPipelineError(
        'realtime',
        'NO_AUDIO_RECEIVED',
        'FFmpeg exited without a valid audio segment',
      );
    }
    if (exitCode !== 0 && exitSignal !== 'SIGINT') {
      throw new AudioPipelineError(
        'realtime',
        'FFMPEG_EXIT',
        'FFmpeg exited unsuccessfully',
        { retryable: true },
      );
    }

    logger.info({
      event: 'xiaohuan_realtime_completed',
      outcome: 'ok',
      segmentCount: segments.length,
      durationMs: now() - startedAt,
    });
    return {
      segments,
      ...(Boolean(config.outputDir) || config.keepSegments
        ? { retainedDirectory: outputDirectory }
        : {}),
    };
  } catch (error) {
    caughtError = error;
    logger.error({
      event: 'xiaohuan_realtime_failed',
      ...(error instanceof AudioPipelineError
        ? error.toSafeJSON()
        : {
            name: 'AudioPipelineError',
            stage: 'realtime',
            code: 'UNEXPECTED_REALTIME_ERROR',
            retryable: false,
            transcriptAvailable: false,
          }),
      ffmpegDiagnosticAvailable: stderrTail.length > 0,
    });
    throw error;
  } finally {
    dependencies.signal?.removeEventListener('abort', abortHandler);
    if (child && !exited) {
      await stopChild(child, exitPromise, config.stopGraceMs).catch(() => undefined);
    }
    if (createdTempDirectory && !config.keepSegments) {
      await fs.rm(outputDirectory, { recursive: true, force: true });
    }
    void caughtError;
  }
}

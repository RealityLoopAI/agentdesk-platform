import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AudioPipelineError } from './errors.js';
import type { ExperimentAudioV1 } from './experiment-schema.js';
import type { SafeLogger } from './pipeline.js';
import type { VadServiceConfig } from './vad-service-config.js';
import {
  EnergyVad,
  PcmFrameAccumulator,
  encodePcm16leWav,
  normalizePcm16lePeak,
  pcmFrameBytes,
  type VadEvent,
  type VadUtterance,
} from './vad.js';
import { loadWav, type WavMetadata } from './wav.js';

const STDERR_TAIL_BYTES = 4 * 1024;

export interface VadServiceOutput {
  captureId: string;
  index: number;
  reason: VadUtterance['reason'];
  metadata?: WavMetadata;
  retainedPath?: string;
  result?: ExperimentAudioV1;
  errorCode?: string;
}

export interface VadServiceSummary {
  accepted: number;
  succeeded: number;
  failed: number;
  discarded: number;
  retainedDirectory?: string;
}

export interface VadWavReadyEvent {
  captureId: string;
  index: number;
  reason: VadUtterance['reason'];
  metadata: WavMetadata;
}

export interface VadListeningServiceDependencies {
  spawnProcess?: typeof spawn;
  processUtterance?: (filePath: string, captureId: string) => Promise<ExperimentAudioV1>;
  onWavReady?: (event: VadWavReadyEvent) => void | Promise<void>;
  onOutput?: (output: VadServiceOutput) => void;
  logger?: SafeLogger;
  signal?: AbortSignal;
  maxWavBytes?: number;
  maxWavDurationMs?: number;
}

interface QueuedUtterance {
  index: number;
  utterance: VadUtterance;
}

const silentLogger: SafeLogger = {
  info: () => undefined,
  error: () => undefined,
};

export function buildVadFfmpegArgs(config: VadServiceConfig): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-protocol_whitelist',
    'file,udp,rtp',
    '-i',
    config.sdpPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(config.vad.sampleRate),
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ];
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`;
  return next.length <= STDERR_TAIL_BYTES ? next : next.slice(-STDERR_TAIL_BYTES);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopChild(
  child: ChildProcess,
  closePromise: Promise<void>,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closePromise;
    return;
  }
  child.kill('SIGINT');
  const graceful = await Promise.race([
    closePromise.then(() => true),
    wait(graceMs).then(() => false),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await closePromise;
  }
}

function safeError(error: unknown): Record<string, unknown> {
  return error instanceof AudioPipelineError
    ? error.toSafeJSON()
    : {
        name: 'AudioPipelineError',
        stage: 'realtime',
        code: 'UNEXPECTED_VAD_UTTERANCE_ERROR',
        retryable: false,
        transcriptAvailable: false,
      };
}

export async function runVadListeningService(
  config: VadServiceConfig,
  dependencies: VadListeningServiceDependencies = {},
): Promise<VadServiceSummary> {
  if (config.processUtterances && !dependencies.processUtterance) {
    throw new AudioPipelineError(
      'configuration',
      'MISSING_UTTERANCE_PROCESSOR',
      'Process service requires an utterance processor',
    );
  }

  const logger = dependencies.logger ?? silentLogger;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const createdTempDirectory = !config.outputDir;
  const outputDirectory =
    config.outputDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'xiaohuan-vad-')));
  await fs.mkdir(outputDirectory, { recursive: true });
  const retainFiles = Boolean(config.outputDir) || config.keepUtterances;
  const maxWavBytes = dependencies.maxWavBytes ?? 10 * 1024 * 1024;
  const maxWavDurationMs = dependencies.maxWavDurationMs ?? config.vad.maxUtteranceMs + 2_000;
  const frameAccumulator = new PcmFrameAccumulator(pcmFrameBytes(config.vad));
  const vad = new EnergyVad(config.vad);
  const queue: QueuedUtterance[] = [];
  let child: ChildProcess | undefined;
  let closePromise: Promise<void> = Promise.resolve();
  let workerPromise: Promise<void> = Promise.resolve();
  let workerRunning = false;
  let requestedStop = false;
  let closed = false;
  let firstAudioReceived = false;
  let firstAudioTimer: NodeJS.Timeout | undefined;
  let forceStopTimer: NodeJS.Timeout | undefined;
  let fatalError: AudioPipelineError | undefined;
  let spawnError: unknown;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stderrTail = '';
  let accepted = 0;
  let succeeded = 0;
  let failed = 0;
  let discarded = 0;

  const requestStop = (): void => {
    requestedStop = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT');
      if (!forceStopTimer) {
        forceStopTimer = setTimeout(() => {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, config.stopGraceMs);
      }
    }
  };

  const processOne = async (queued: QueuedUtterance): Promise<void> => {
    const captureId = `${config.capturePrefix}-${String(queued.index).padStart(6, '0')}`;
    const filePath = path.join(
      outputDirectory,
      `utterance-${String(queued.index).padStart(6, '0')}.wav`,
    );
    let metadata: WavMetadata | undefined;
    try {
      const normalized = normalizePcm16lePeak(
        queued.utterance.pcm,
        config.normalizePeakDb,
        config.maxNormalizeGainDb,
      );
      await fs.writeFile(
        filePath,
        encodePcm16leWav(normalized.pcm, config.vad.sampleRate, 1),
      );
      const loaded = await loadWav(filePath, {
        maxBytes: maxWavBytes,
        maxDurationMs: maxWavDurationMs,
      });
      metadata = loaded.metadata;
      try {
        const notification = dependencies.onWavReady?.({
          captureId,
          index: queued.index,
          reason: queued.utterance.reason,
          metadata,
        });
        void Promise.resolve(notification).catch(() => {
          logger.error({
            event: 'xiaohuan_vad_wav_ready_callback',
            outcome: 'error',
            captureId,
            code: 'WAV_READY_CALLBACK_FAILED',
          });
        });
      } catch {
        logger.error({
          event: 'xiaohuan_vad_wav_ready_callback',
          outcome: 'error',
          captureId,
          code: 'WAV_READY_CALLBACK_FAILED',
        });
      }
      const result = config.processUtterances
        ? await dependencies.processUtterance?.(filePath, captureId)
        : undefined;
      succeeded += 1;
      const output: VadServiceOutput = {
        captureId,
        index: queued.index,
        reason: queued.utterance.reason,
        metadata,
        ...(retainFiles ? { retainedPath: filePath } : {}),
        ...(result ? { result } : {}),
      };
      dependencies.onOutput?.(output);
      logger.info({
        event: 'xiaohuan_vad_utterance',
        outcome: 'ok',
        captureId,
        index: queued.index,
        reason: queued.utterance.reason,
        durationMs: queued.utterance.durationMs,
        voicedMs: queued.utterance.voicedMs,
        processed: config.processUtterances,
        retained: retainFiles,
        normalizationGainDb: Math.round(normalized.gainDb * 10) / 10,
      });
    } catch (error) {
      failed += 1;
      const safe = safeError(error);
      dependencies.onOutput?.({
        captureId,
        index: queued.index,
        reason: queued.utterance.reason,
        ...(metadata ? { metadata } : {}),
        errorCode: String(safe.code ?? 'UNEXPECTED_VAD_UTTERANCE_ERROR'),
      });
      logger.error({
        event: 'xiaohuan_vad_utterance',
        outcome: 'error',
        captureId,
        index: queued.index,
        ...safe,
      });
    } finally {
      if (!retainFiles) await fs.rm(filePath, { force: true });
    }
  };

  const startWorker = (): void => {
    if (workerRunning) return;
    workerRunning = true;
    workerPromise = (async () => {
      while (queue.length > 0) {
        const queued = queue.shift();
        if (queued) await processOne(queued);
      }
      workerRunning = false;
    })();
  };

  const enqueue = (utterance: VadUtterance): void => {
    if (queue.length >= config.maxQueue) {
      fatalError = new AudioPipelineError(
        'realtime',
        'QUEUE_OVERFLOW',
        'VAD utterance queue exceeded its configured bound',
      );
      requestStop();
      return;
    }
    accepted += 1;
    queue.push({ index: accepted, utterance });
    logger.info({
      event: 'xiaohuan_vad_detected',
      index: accepted,
      reason: utterance.reason,
      durationMs: utterance.durationMs,
      voicedMs: utterance.voicedMs,
      queued: queue.length,
    });
    startWorker();
    if (config.maxUtterances > 0 && accepted >= config.maxUtterances) requestStop();
  };

  const handleVadEvents = (events: VadEvent[]): void => {
    for (const event of events) {
      if (event.type === 'utterance') enqueue(event.utterance);
      else {
        discarded += 1;
        logger.info({
          event: 'xiaohuan_vad_discarded',
          reason: event.discard.reason,
          voicedMs: event.discard.voicedMs,
        });
      }
    }
  };

  const abortHandler = (): void => requestStop();

  try {
    child = spawnProcess(config.ffmpegPath, buildVadFfmpegArgs(config), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!firstAudioReceived) {
        firstAudioReceived = true;
        if (firstAudioTimer) clearTimeout(firstAudioTimer);
        logger.info({
          event: 'xiaohuan_vad_ready',
          thresholdDb: config.vad.thresholdDb,
          frameMs: config.vad.frameMs,
        });
      }
      for (const frame of frameAccumulator.push(chunk)) {
        handleVadEvents(vad.pushFrame(frame));
        if (fatalError) break;
      }
    });
    closePromise = new Promise<void>((resolve) => {
      child?.once('error', (error) => {
        spawnError = error;
      });
      child?.once('close', (code, signal) => {
        if (forceStopTimer) clearTimeout(forceStopTimer);
        closed = true;
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });
    dependencies.signal?.addEventListener('abort', abortHandler, { once: true });
    firstAudioTimer = setTimeout(() => {
      if (!firstAudioReceived) {
        fatalError = new AudioPipelineError(
          'realtime',
          'NO_AUDIO_RECEIVED',
          'No PCM arrived before the configured timeout',
        );
        requestStop();
      }
    }, config.firstAudioTimeoutMs);
    logger.info({
      event: 'xiaohuan_vad_service_started',
      mode: config.processUtterances ? 'process' : 'capture',
      thresholdDb: config.vad.thresholdDb,
      maxQueue: config.maxQueue,
    });

    await closePromise;
    if (firstAudioTimer) clearTimeout(firstAudioTimer);
    if (forceStopTimer) clearTimeout(forceStopTimer);
    handleVadEvents(vad.flush());
    await workerPromise;

    if (fatalError) throw fatalError;
    if (spawnError) {
      throw new AudioPipelineError(
        'realtime',
        'FFMPEG_SPAWN_FAILED',
        'FFmpeg could not be started',
        { cause: spawnError },
      );
    }
    if (!requestedStop || exitSignal === 'SIGKILL') {
      throw new AudioPipelineError(
        'realtime',
        'FFMPEG_EXIT',
        'Continuous FFmpeg receiver exited unexpectedly',
        { retryable: true },
      );
    }
    logger.info({
      event: 'xiaohuan_vad_service_stopped',
      outcome: 'ok',
      accepted,
      succeeded,
      failed,
      discarded,
    });
    return {
      accepted,
      succeeded,
      failed,
      discarded,
      ...(retainFiles ? { retainedDirectory: outputDirectory } : {}),
    };
  } catch (error) {
    logger.error({
      event: 'xiaohuan_vad_service_failed',
      ...safeError(error),
      ffmpegDiagnosticAvailable: stderrTail.length > 0,
    });
    throw error;
  } finally {
    if (firstAudioTimer) clearTimeout(firstAudioTimer);
    dependencies.signal?.removeEventListener('abort', abortHandler);
    if (child && !closed) {
      await stopChild(child, closePromise, config.stopGraceMs).catch(() => undefined);
    }
    await workerPromise.catch(() => undefined);
    if (createdTempDirectory && !config.keepUtterances) {
      await fs.rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

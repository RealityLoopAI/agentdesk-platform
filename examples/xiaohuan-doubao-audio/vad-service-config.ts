import fs from 'node:fs/promises';
import path from 'node:path';

import { AudioPipelineError } from './errors.js';
import { validateRealtimeSdp, verifyFfmpeg } from './realtime-config.js';
import {
  DEFAULT_ENERGY_VAD_CONFIG,
  type EnergyVadConfig,
  validateEnergyVadConfig,
} from './vad.js';
import { validateCaptureId } from './wav.js';

export interface VadServiceConfig {
  sdpPath: string;
  ffmpegPath: string;
  vad: EnergyVadConfig;
  maxQueue: number;
  maxUtterances: number;
  firstAudioTimeoutMs: number;
  stopGraceMs: number;
  outputDir?: string;
  keepUtterances: boolean;
  processUtterances: boolean;
  allowExternalUpload: boolean;
  capturePrefix: string;
  normalizePeakDb: number;
  maxNormalizeGainDb: number;
}

function nextValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_VAD_SERVICE_ARGUMENTS',
      'VAD service option is missing its value',
    );
  }
  return value;
}

function integer(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_VAD_SERVICE_CONFIGURATION',
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function numberValue(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_VAD_SERVICE_CONFIGURATION',
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function parseVadServiceArgs(args: string[]): VadServiceConfig {
  let sdpPath = '';
  let ffmpegPath = 'ffmpeg';
  const vad: EnergyVadConfig = { ...DEFAULT_ENERGY_VAD_CONFIG };
  let maxQueue = 4;
  let maxUtterances = 0;
  let firstAudioTimeoutMs = 30_000;
  let stopGraceMs = 3_000;
  let outputDir: string | undefined;
  let keepUtterances = false;
  let processUtterances = false;
  let allowExternalUpload = false;
  let capturePrefix = 'xiaohuan-vad';
  let normalizePeakDb = -3;
  let maxNormalizeGainDb = 30;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--sdp') {
      sdpPath = nextValue(args, index);
      index += 1;
    } else if (arg === '--ffmpeg') {
      ffmpegPath = nextValue(args, index);
      index += 1;
    } else if (arg === '--threshold-db') {
      vad.thresholdDb = numberValue(nextValue(args, index), 'threshold-db', -100, -1);
      index += 1;
    } else if (arg === '--frame-ms') {
      vad.frameMs = integer(nextValue(args, index), 'frame-ms', 10, 100);
      index += 1;
    } else if (arg === '--start-frames') {
      vad.startFrames = integer(nextValue(args, index), 'start-frames', 1, 100);
      index += 1;
    } else if (arg === '--pre-roll-ms') {
      vad.preRollMs = integer(nextValue(args, index), 'pre-roll-ms', 20, 5_000);
      index += 1;
    } else if (arg === '--trailing-silence-ms') {
      vad.trailingSilenceMs = integer(
        nextValue(args, index),
        'trailing-silence-ms',
        100,
        10_000,
      );
      index += 1;
    } else if (arg === '--min-speech-ms') {
      vad.minSpeechMs = integer(nextValue(args, index), 'min-speech-ms', 20, 20_000);
      index += 1;
    } else if (arg === '--max-utterance-ms') {
      vad.maxUtteranceMs = integer(
        nextValue(args, index),
        'max-utterance-ms',
        1_000,
        120_000,
      );
      index += 1;
    } else if (arg === '--max-queue') {
      maxQueue = integer(nextValue(args, index), 'max-queue', 1, 32);
      index += 1;
    } else if (arg === '--max-utterances') {
      maxUtterances = integer(nextValue(args, index), 'max-utterances', 0, 10_000);
      index += 1;
    } else if (arg === '--first-audio-timeout-ms') {
      firstAudioTimeoutMs = integer(
        nextValue(args, index),
        'first-audio-timeout-ms',
        1_000,
        120_000,
      );
      index += 1;
    } else if (arg === '--stop-grace-ms') {
      stopGraceMs = integer(nextValue(args, index), 'stop-grace-ms', 10, 30_000);
      index += 1;
    } else if (arg === '--output-dir') {
      outputDir = path.resolve(nextValue(args, index));
      index += 1;
    } else if (arg === '--capture-prefix') {
      capturePrefix = validateCaptureId(nextValue(args, index));
      index += 1;
    } else if (arg === '--normalize-peak-db') {
      normalizePeakDb = numberValue(
        nextValue(args, index),
        'normalize-peak-db',
        -30,
        -0.1,
      );
      index += 1;
    } else if (arg === '--max-normalize-gain-db') {
      maxNormalizeGainDb = numberValue(
        nextValue(args, index),
        'max-normalize-gain-db',
        0,
        60,
      );
      index += 1;
    } else if (arg === '--keep-utterances') {
      keepUtterances = true;
    } else if (arg === '--process') {
      processUtterances = true;
    } else if (arg === '--allow-external-upload') {
      allowExternalUpload = true;
    } else {
      throw new AudioPipelineError(
        'configuration',
        'INVALID_VAD_SERVICE_ARGUMENTS',
        'Unknown VAD service CLI argument',
      );
    }
  }

  if (!sdpPath) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_VAD_SERVICE_ARGUMENTS',
      'Usage: vad-service-cli.ts --sdp <file> [options]',
    );
  }
  if (processUtterances !== allowExternalUpload) {
    throw new AudioPipelineError(
      'configuration',
      'EXTERNAL_UPLOAD_NOT_CONFIRMED',
      'Process service requires --process and --allow-external-upload together',
    );
  }
  validateEnergyVadConfig(vad);
  return {
    sdpPath: path.resolve(sdpPath),
    ffmpegPath,
    vad,
    maxQueue,
    maxUtterances,
    firstAudioTimeoutMs,
    stopGraceMs,
    outputDir,
    keepUtterances,
    processUtterances,
    allowExternalUpload,
    capturePrefix,
    normalizePeakDb,
    maxNormalizeGainDb,
  };
}

export async function validateVadServiceConfig(config: VadServiceConfig): Promise<void> {
  await validateRealtimeSdp(config.sdpPath);
  await verifyFfmpeg(config.ffmpegPath);
  if (config.outputDir) {
    await fs.mkdir(config.outputDir, { recursive: true });
    if (!(await fs.stat(config.outputDir)).isDirectory()) {
      throw new AudioPipelineError(
        'configuration',
        'INVALID_OUTPUT_DIRECTORY',
        'VAD output path must be a directory',
      );
    }
  }
}

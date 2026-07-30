import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AudioPipelineError } from './errors.js';
import { validateCaptureId } from './wav.js';

const execFileAsync = promisify(execFile);
const MAX_SDP_BYTES = 16 * 1024;

export interface RealtimeConfig {
  sdpPath: string;
  ffmpegPath: string;
  segmentSeconds: number;
  maxSegments: number;
  maxQueue: number;
  firstSegmentTimeoutMs: number;
  stopGraceMs: number;
  outputDir?: string;
  keepSegments: boolean;
  processSegments: boolean;
  allowExternalUpload: boolean;
  capturePrefix: string;
}

export type RealtimeConfigOverrides = Partial<
  Pick<RealtimeConfig, 'stopGraceMs'>
>;

function valueAfter(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_REALTIME_ARGUMENTS',
      'Realtime option is missing its value',
    );
  }
  return value;
}

function positiveInteger(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_REALTIME_CONFIGURATION',
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function parseRealtimeArgs(
  args: string[],
  overrides: RealtimeConfigOverrides = {},
): RealtimeConfig {
  let sdpPath = '';
  let ffmpegPath = 'ffmpeg';
  let segmentSeconds = 8;
  let maxSegments = 1;
  let maxQueue = 4;
  let firstSegmentTimeoutMs = 30_000;
  let outputDir: string | undefined;
  let keepSegments = false;
  let processSegments = false;
  let allowExternalUpload = false;
  let capturePrefix = 'xiaohuan-live';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--sdp') {
      sdpPath = valueAfter(args, index);
      index += 1;
    } else if (arg === '--ffmpeg') {
      ffmpegPath = valueAfter(args, index);
      index += 1;
    } else if (arg === '--segment-seconds') {
      segmentSeconds = positiveInteger(valueAfter(args, index), 'segment-seconds', 1, 20);
      index += 1;
    } else if (arg === '--max-segments') {
      maxSegments = positiveInteger(valueAfter(args, index), 'max-segments', 1, 100);
      index += 1;
    } else if (arg === '--max-queue') {
      maxQueue = positiveInteger(valueAfter(args, index), 'max-queue', 1, 16);
      index += 1;
    } else if (arg === '--first-segment-timeout-ms') {
      firstSegmentTimeoutMs = positiveInteger(
        valueAfter(args, index),
        'first-segment-timeout-ms',
        1_000,
        120_000,
      );
      index += 1;
    } else if (arg === '--output-dir') {
      outputDir = path.resolve(valueAfter(args, index));
      index += 1;
    } else if (arg === '--capture-prefix') {
      capturePrefix = validateCaptureId(valueAfter(args, index));
      index += 1;
    } else if (arg === '--keep-segments') {
      keepSegments = true;
    } else if (arg === '--process') {
      processSegments = true;
    } else if (arg === '--allow-external-upload') {
      allowExternalUpload = true;
    } else {
      throw new AudioPipelineError(
        'configuration',
        'INVALID_REALTIME_ARGUMENTS',
        'Unknown realtime CLI argument',
      );
    }
  }

  if (!sdpPath) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_REALTIME_ARGUMENTS',
      'Usage: realtime-cli.ts --sdp <file> [options]',
    );
  }
  if (processSegments !== allowExternalUpload) {
    throw new AudioPipelineError(
      'configuration',
      'EXTERNAL_UPLOAD_NOT_CONFIRMED',
      'Process mode requires --process and --allow-external-upload together',
    );
  }

  return {
    sdpPath: path.resolve(sdpPath),
    ffmpegPath,
    segmentSeconds,
    maxSegments,
    maxQueue,
    firstSegmentTimeoutMs,
    stopGraceMs: overrides.stopGraceMs ?? 3_000,
    outputDir,
    keepSegments,
    processSegments,
    allowExternalUpload,
    capturePrefix,
  };
}

export async function validateRealtimeSdp(sdpPath: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(sdpPath);
  } catch (error) {
    throw new AudioPipelineError(
      'configuration',
      'SDP_NOT_FOUND',
      'Realtime SDP file does not exist',
      { cause: error },
    );
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SDP_BYTES) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_SDP',
      'Realtime SDP must be a non-empty bounded regular file',
    );
  }
  const text = await fs.readFile(sdpPath, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const media = lines.find((line) => /^m=audio\s+\d+\s+RTP\/AVP\s+/.test(line));
  const mapping = lines.find((line) => /^a=rtpmap:96\s+opus\/48000(?:\/\d+)?$/i.test(line));
  if (!media || !media.split(/\s+/).slice(3).includes('96') || !mapping) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_SDP',
      'Realtime SDP must map audio payload 96 to Opus at 48 kHz',
    );
  }
  return text;
}

export async function verifyFfmpeg(ffmpegPath: string): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, ['-version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw new AudioPipelineError(
      'configuration',
      'FFMPEG_UNAVAILABLE',
      'FFmpeg executable is unavailable',
      { cause: error },
    );
  }
}

export async function validateRealtimeConfig(config: RealtimeConfig): Promise<void> {
  await validateRealtimeSdp(config.sdpPath);
  await verifyFfmpeg(config.ffmpegPath);
  if (config.outputDir) {
    await fs.mkdir(config.outputDir, { recursive: true });
    const stat = await fs.stat(config.outputDir);
    if (!stat.isDirectory()) {
      throw new AudioPipelineError(
        'configuration',
        'INVALID_OUTPUT_DIRECTORY',
        'Realtime output path must be a directory',
      );
    }
  }
}

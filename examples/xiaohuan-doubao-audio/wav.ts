import fs from 'node:fs/promises';

import { AudioPipelineError } from './errors.js';

export interface WavMetadata {
  bytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  durationMs: number;
  audioFormat: number;
  dataBytes: number;
}

export interface LoadedWav {
  bytes: Buffer;
  metadata: WavMetadata;
}

export function validateCaptureId(captureId: string): string {
  const value = captureId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new AudioPipelineError(
      'input',
      'INVALID_CAPTURE_ID',
      'captureId must be 1-128 safe identifier characters',
    );
  }
  return value;
}

function invalidWav(message: string): never {
  throw new AudioPipelineError('input', 'INVALID_WAV', message);
}

export function parseWav(buffer: Buffer): WavMetadata {
  if (buffer.length === 0) {
    throw new AudioPipelineError('input', 'EMPTY_WAV', 'WAV file is empty');
  }
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    invalidWav('Missing RIFF header');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    invalidWav('Missing WAVE signature');
  }

  let offset = 12;
  let format:
    | {
        audioFormat: number;
        channels: number;
        sampleRate: number;
        byteRate: number;
        blockAlign: number;
        bitsPerSample: number;
      }
    | undefined;
  let dataBytes: number | undefined;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) invalidWav(`Truncated ${id || 'unknown'} chunk`);

    if (id === 'fmt ') {
      if (size < 16) invalidWav('fmt chunk is too short');
      format = {
        audioFormat: buffer.readUInt16LE(dataStart),
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        byteRate: buffer.readUInt32LE(dataStart + 8),
        blockAlign: buffer.readUInt16LE(dataStart + 12),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14),
      };
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset = dataEnd + (size % 2);
  }

  if (!format || dataBytes === undefined) invalidWav('WAV must contain fmt and data chunks');
  if (dataBytes === 0) {
    throw new AudioPipelineError('input', 'EMPTY_WAV', 'WAV contains no audio samples');
  }
  if (format.audioFormat !== 1) invalidWav('Only uncompressed PCM WAV is supported');
  if (
    format.channels <= 0 ||
    format.sampleRate <= 0 ||
    format.byteRate <= 0 ||
    format.blockAlign <= 0 ||
    format.bitsPerSample <= 0
  ) {
    invalidWav('WAV format metadata is invalid');
  }

  return {
    bytes: buffer.length,
    ...format,
    dataBytes,
    durationMs: Math.round((dataBytes / format.byteRate) * 1000),
  };
}

export async function loadWav(
  filePath: string,
  limits: { maxBytes: number; maxDurationMs: number },
): Promise<LoadedWav> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    throw new AudioPipelineError('input', 'WAV_NOT_FOUND', 'WAV file does not exist', { cause: error });
  }
  if (!stat.isFile()) {
    throw new AudioPipelineError('input', 'WAV_NOT_FILE', 'WAV path is not a regular file');
  }
  if (stat.size === 0) {
    throw new AudioPipelineError('input', 'EMPTY_WAV', 'WAV file is empty');
  }
  if (stat.size > limits.maxBytes) {
    throw new AudioPipelineError('input', 'WAV_TOO_LARGE', 'WAV exceeds configured byte limit');
  }

  const bytes = await fs.readFile(filePath);
  const metadata = parseWav(bytes);
  if (metadata.durationMs > limits.maxDurationMs) {
    throw new AudioPipelineError(
      'input',
      'WAV_TOO_LONG',
      'WAV exceeds configured duration limit',
    );
  }
  return { bytes, metadata };
}

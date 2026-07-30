import { AudioPipelineError } from './errors.js';

export interface EnergyVadConfig {
  sampleRate: number;
  frameMs: number;
  thresholdDb: number;
  startFrames: number;
  preRollMs: number;
  trailingSilenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
}

export interface VadUtterance {
  pcm: Buffer;
  reason: 'silence' | 'max-duration' | 'flush';
  durationMs: number;
  voicedMs: number;
}

export interface VadDiscard {
  reason: 'too-short';
  voicedMs: number;
}

export type VadEvent =
  | { type: 'utterance'; utterance: VadUtterance }
  | { type: 'discard'; discard: VadDiscard };

export const DEFAULT_ENERGY_VAD_CONFIG: EnergyVadConfig = {
  sampleRate: 16_000,
  frameMs: 20,
  thresholdDb: -43,
  startFrames: 5,
  preRollMs: 300,
  trailingSilenceMs: 800,
  minSpeechMs: 400,
  maxUtteranceMs: 20_000,
};

export function pcmFrameBytes(config: Pick<EnergyVadConfig, 'sampleRate' | 'frameMs'>): number {
  return Math.round((config.sampleRate * config.frameMs * 2) / 1_000);
}

export function pcm16leDbfs(frame: Buffer): number {
  if (frame.length === 0 || frame.length % 2 !== 0) {
    throw new AudioPipelineError(
      'realtime',
      'INVALID_PCM_FRAME',
      'PCM frame must contain complete signed 16-bit samples',
    );
  }
  let sumSquares = 0;
  const samples = frame.length / 2;
  for (let offset = 0; offset < frame.length; offset += 2) {
    const sample = frame.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

export class PcmFrameAccumulator {
  readonly frameBytes: number;
  private remainder = Buffer.alloc(0);

  constructor(frameBytes: number) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0 || frameBytes % 2 !== 0) {
      throw new AudioPipelineError(
        'configuration',
        'INVALID_VAD_CONFIGURATION',
        'PCM frame byte length must be a positive even integer',
      );
    }
    this.frameBytes = frameBytes;
  }

  push(chunk: Buffer): Buffer[] {
    const bytes =
      this.remainder.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.remainder, chunk]);
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + this.frameBytes <= bytes.length) {
      frames.push(Buffer.from(bytes.subarray(offset, offset + this.frameBytes)));
      offset += this.frameBytes;
    }
    this.remainder = Buffer.from(bytes.subarray(offset));
    return frames;
  }

  pendingBytes(): number {
    return this.remainder.length;
  }
}

function framesFor(milliseconds: number, frameMs: number): number {
  return Math.max(1, Math.ceil(milliseconds / frameMs));
}

export class EnergyVad {
  readonly config: EnergyVadConfig;
  private state: 'idle' | 'speech' = 'idle';
  private preRoll: Buffer[] = [];
  private consecutiveSpeech = 0;
  private utteranceFrames: Buffer[] = [];
  private voicedFrames = 0;
  private silenceFrames = 0;

  constructor(config: EnergyVadConfig = DEFAULT_ENERGY_VAD_CONFIG) {
    validateEnergyVadConfig(config);
    this.config = { ...config };
  }

  pushFrame(frame: Buffer): VadEvent[] {
    if (frame.length !== pcmFrameBytes(this.config)) {
      throw new AudioPipelineError(
        'realtime',
        'INVALID_PCM_FRAME',
        'PCM frame does not match configured duration',
      );
    }
    const voiced = pcm16leDbfs(frame) >= this.config.thresholdDb;
    if (this.state === 'idle') {
      this.pushPreRoll(frame);
      this.consecutiveSpeech = voiced ? this.consecutiveSpeech + 1 : 0;
      if (this.consecutiveSpeech >= this.config.startFrames) {
        this.state = 'speech';
        this.utteranceFrames = this.preRoll.map((item) => Buffer.from(item));
        this.voicedFrames = this.config.startFrames;
        this.silenceFrames = 0;
        this.preRoll = [];
      }
      return [];
    }

    this.utteranceFrames.push(Buffer.from(frame));
    if (voiced) {
      this.voicedFrames += 1;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
    }

    if (
      this.utteranceFrames.length >=
      framesFor(this.config.maxUtteranceMs, this.config.frameMs)
    ) {
      return [this.finalize('max-duration')];
    }
    if (
      this.silenceFrames >=
      framesFor(this.config.trailingSilenceMs, this.config.frameMs)
    ) {
      return [this.finalize('silence')];
    }
    return [];
  }

  flush(): VadEvent[] {
    if (this.state !== 'speech') return [];
    return [this.finalize('flush')];
  }

  isSpeaking(): boolean {
    return this.state === 'speech';
  }

  private pushPreRoll(frame: Buffer): void {
    this.preRoll.push(Buffer.from(frame));
    const limit = framesFor(this.config.preRollMs, this.config.frameMs);
    if (this.preRoll.length > limit) this.preRoll.shift();
  }

  private finalize(reason: VadUtterance['reason']): VadEvent {
    const voicedMs = this.voicedFrames * this.config.frameMs;
    const pcm = Buffer.concat(this.utteranceFrames);
    const durationMs = this.utteranceFrames.length * this.config.frameMs;
    this.state = 'idle';
    this.preRoll = [];
    this.consecutiveSpeech = 0;
    this.utteranceFrames = [];
    this.voicedFrames = 0;
    this.silenceFrames = 0;

    if (voicedMs < this.config.minSpeechMs) {
      return { type: 'discard', discard: { reason: 'too-short', voicedMs } };
    }
    return {
      type: 'utterance',
      utterance: { pcm, reason, durationMs, voicedMs },
    };
  }
}

export function encodePcm16leWav(pcm: Buffer, sampleRate = 16_000, channels = 1): Buffer {
  if (pcm.length === 0 || pcm.length % (channels * 2) !== 0) {
    throw new AudioPipelineError(
      'realtime',
      'INVALID_PCM_UTTERANCE',
      'PCM utterance must contain complete non-empty samples',
    );
  }
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function normalizePcm16lePeak(
  pcm: Buffer,
  targetPeakDb = -3,
  maxGainDb = 30,
): { pcm: Buffer; gainDb: number; sourcePeakDb: number } {
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new AudioPipelineError(
      'realtime',
      'INVALID_PCM_UTTERANCE',
      'PCM utterance must contain complete non-empty samples',
    );
  }
  let peak = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  if (peak === 0) {
    return { pcm: Buffer.from(pcm), gainDb: 0, sourcePeakDb: Number.NEGATIVE_INFINITY };
  }
  const sourcePeakDb = 20 * Math.log10(peak / 32768);
  const requestedGainDb = targetPeakDb - sourcePeakDb;
  const gainDb = Math.min(requestedGainDb, maxGainDb);
  const multiplier = 10 ** (gainDb / 20);
  const output = Buffer.alloc(pcm.length);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const value = Math.round(pcm.readInt16LE(offset) * multiplier);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, value)), offset);
  }
  return { pcm: output, gainDb, sourcePeakDb };
}

export function validateEnergyVadConfig(config: EnergyVadConfig): void {
  const positive = [
    config.sampleRate,
    config.frameMs,
    config.startFrames,
    config.preRollMs,
    config.trailingSilenceMs,
    config.minSpeechMs,
    config.maxUtteranceMs,
  ];
  if (
    positive.some((value) => !Number.isFinite(value) || value <= 0) ||
    !Number.isFinite(config.thresholdDb) ||
    config.thresholdDb >= 0 ||
    config.thresholdDb < -100 ||
    config.minSpeechMs > config.maxUtteranceMs ||
    pcmFrameBytes(config) % 2 !== 0
  ) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_VAD_CONFIGURATION',
      'VAD configuration is invalid',
    );
  }
}

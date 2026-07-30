import type { DoubaoAudioConfig } from './config.js';
import {
  createArkMultimodalWavExtractor,
  type ArkMultimodalWavExtractor,
} from './ark-multimodal.js';
import { AudioPipelineError } from './errors.js';
import type { ExperimentAudioV1 } from './experiment-schema.js';
import { loadWav, validateCaptureId, type LoadedWav } from './wav.js';

export interface SafeLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface PipelineDependencies {
  loadWavFile?: typeof loadWav;
  extractor?: ArkMultimodalWavExtractor;
  logger?: SafeLogger;
  now?: () => number;
}

const silentLogger: SafeLogger = {
  info: () => undefined,
  error: () => undefined,
};

export function createAudioPipeline(
  config: DoubaoAudioConfig,
  dependencies: PipelineDependencies = {},
): {
  processWav(filePath: string, captureId: string): Promise<ExperimentAudioV1>;
} {
  const loadWavFile = dependencies.loadWavFile ?? loadWav;
  const extractor = dependencies.extractor ?? createArkMultimodalWavExtractor(config);
  const logger = dependencies.logger ?? silentLogger;
  const now = dependencies.now ?? Date.now;

  return {
    async processWav(filePath, rawCaptureId) {
      const captureId = validateCaptureId(rawCaptureId);
      let started = now();
      let loaded: LoadedWav;
      try {
        loaded = await loadWavFile(filePath, {
          maxBytes: config.maxWavBytes,
          maxDurationMs: config.maxWavDurationMs,
        });
        logger.info({
          event: 'xiaohuan_audio_stage',
          stage: 'input',
          outcome: 'ok',
          durationMs: now() - started,
          captureId,
          bytes: loaded.metadata.bytes,
          sampleRate: loaded.metadata.sampleRate,
          channels: loaded.metadata.channels,
          bitsPerSample: loaded.metadata.bitsPerSample,
          wavDurationMs: loaded.metadata.durationMs,
        });
      } catch (error) {
        logFailure(logger, error, 'input', captureId, now() - started);
        throw error;
      }

      started = now();
      try {
        const response = await extractor.extract(loaded.bytes, captureId);
        logger.info({
          event: 'xiaohuan_audio_stage',
          stage: 'multimodal',
          outcome: 'ok',
          durationMs: now() - started,
          captureId,
          ...(response.requestId ? { requestId: response.requestId } : {}),
        });
        return response.result;
      } catch (error) {
        logFailure(logger, error, 'multimodal', captureId, now() - started);
        throw error;
      }
    },
  };
}

function logFailure(
  logger: SafeLogger,
  error: unknown,
  fallbackStage: string,
  captureId: string,
  durationMs: number,
): void {
  const safe =
    error instanceof AudioPipelineError
      ? error.toSafeJSON()
      : { stage: fallbackStage, code: 'UNEXPECTED_ERROR', retryable: false };
  logger.error({
    event: 'xiaohuan_audio_stage',
    outcome: 'error',
    durationMs,
    captureId,
    ...safe,
  });
}

import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { AudioPipelineError } from './errors.js';
import type { ExperimentAudioV1 } from './experiment-schema.js';
import { createAudioPipeline, type SafeLogger } from './pipeline.js';
import {
  parseVadServiceArgs,
  validateVadServiceConfig,
} from './vad-service-config.js';
import {
  runVadListeningService,
  type VadServiceOutput,
} from './vad-listening-service.js';

interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runVadServiceCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const config = parseVadServiceArgs(args);
    await validateVadServiceConfig(config);
    const logger: SafeLogger = {
      info: (event) => io.stderr(`${JSON.stringify(event)}\n`),
      error: (event) => io.stderr(`${JSON.stringify(event)}\n`),
    };
    let processUtterance:
      | ((filePath: string, captureId: string) => Promise<ExperimentAudioV1>)
      | undefined;
    let maxWavBytes = 10 * 1024 * 1024;
    let maxWavDurationMs = config.vad.maxUtteranceMs + 2_000;
    if (config.processUtterances) {
      const ark = loadConfig(env);
      if (config.vad.maxUtteranceMs > ark.maxWavDurationMs) {
        throw new AudioPipelineError(
          'configuration',
          'UTTERANCE_EXCEEDS_WAV_LIMIT',
          'VAD maximum utterance exceeds the configured WAV duration limit',
        );
      }
      const pipeline = createAudioPipeline(ark, { logger });
      processUtterance = pipeline.processWav;
      maxWavBytes = ark.maxWavBytes;
      maxWavDurationMs = ark.maxWavDurationMs;
    }

    const onOutput = (output: VadServiceOutput): void => {
      if (output.result) {
        io.stdout(`${JSON.stringify(output.result)}\n`);
      } else {
        io.stdout(
          `${JSON.stringify({
            type: 'xiaohuan_vad_utterance',
            captureId: output.captureId,
            index: output.index,
            reason: output.reason,
            ...(output.metadata ? { metadata: output.metadata } : {}),
            ...(output.retainedPath ? { path: output.retainedPath } : {}),
            ...(output.errorCode ? { errorCode: output.errorCode } : {}),
          })}\n`,
        );
      }
    };

    await runVadListeningService(config, {
      logger,
      processUtterance,
      onOutput,
      signal: abortController.signal,
      maxWavBytes,
      maxWavDurationMs,
    });
    return 0;
  } catch (error) {
    const safe =
      error instanceof AudioPipelineError
        ? error.toSafeJSON()
        : {
            name: 'AudioPipelineError',
            stage: 'realtime',
            code: 'UNEXPECTED_VAD_SERVICE_ERROR',
            retryable: false,
            transcriptAvailable: false,
          };
    io.stderr(`${JSON.stringify({ event: 'xiaohuan_vad_cli_failed', ...safe })}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runVadServiceCli(process.argv.slice(2));
}

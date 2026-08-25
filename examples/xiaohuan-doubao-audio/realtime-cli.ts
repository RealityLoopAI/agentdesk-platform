import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { AudioPipelineError } from './errors.js';
import type { ExperimentAudioV1 } from './experiment-schema.js';
import { createAudioPipeline, type SafeLogger } from './pipeline.js';
import { parseRealtimeArgs, validateRealtimeConfig } from './realtime-config.js';
import { runRealtimeIngress } from './realtime-ingress.js';

interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runRealtimeCli(
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
    const realtime = parseRealtimeArgs(args);
    await validateRealtimeConfig(realtime);
    const logger: SafeLogger = {
      info: (event) => io.stderr(`${JSON.stringify(event)}\n`),
      error: (event) => io.stderr(`${JSON.stringify(event)}\n`),
    };

    let processSegment:
      | ((filePath: string, captureId: string) => Promise<ExperimentAudioV1>)
      | undefined;
    let maxWavBytes = 10 * 1024 * 1024;
    let maxWavDurationMs = 20_000;
    if (realtime.processSegments) {
      const arkConfig = loadConfig(env);
      if (realtime.segmentSeconds * 1_000 > arkConfig.maxWavDurationMs) {
        throw new AudioPipelineError(
          'configuration',
          'SEGMENT_EXCEEDS_WAV_LIMIT',
          'Realtime segment duration exceeds the configured WAV duration limit',
        );
      }
      const pipeline = createAudioPipeline(arkConfig, { logger });
      processSegment = pipeline.processWav;
      maxWavBytes = arkConfig.maxWavBytes;
      maxWavDurationMs = arkConfig.maxWavDurationMs;
    }

    const completed = await runRealtimeIngress(realtime, {
      logger,
      processSegment,
      maxWavBytes,
      maxWavDurationMs,
      signal: abortController.signal,
    });
    for (const segment of completed.segments) {
      if (segment.result) {
        io.stdout(`${JSON.stringify(segment.result)}\n`);
      } else {
        io.stdout(
          `${JSON.stringify({
            type: 'xiaohuan_audio_capture',
            captureId: segment.captureId,
            index: segment.index,
            metadata: segment.metadata,
            ...(segment.retainedPath ? { path: segment.retainedPath } : {}),
          })}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    const safe =
      error instanceof AudioPipelineError
        ? error.toSafeJSON()
        : {
            name: 'AudioPipelineError',
            stage: 'realtime',
            code: 'UNEXPECTED_REALTIME_ERROR',
            retryable: false,
            transcriptAvailable: false,
          };
    io.stderr(`${JSON.stringify({ event: 'xiaohuan_realtime_cli_failed', ...safe })}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRealtimeCli(process.argv.slice(2));
}

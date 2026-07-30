import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { AudioPipelineError } from './errors.js';
import { createAudioPipeline, type SafeLogger } from './pipeline.js';

interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

function parseArgs(args: string[]): { filePath: string; captureId: string } {
  let filePath = '';
  let captureId: string = crypto.randomUUID();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--capture-id') {
      captureId = args[index + 1] ?? '';
      index += 1;
    } else if (!arg.startsWith('-') && !filePath) {
      filePath = arg;
    } else {
      throw new AudioPipelineError('input', 'INVALID_ARGUMENTS', 'Unknown or incomplete CLI argument');
    }
  }
  if (!filePath) {
    throw new AudioPipelineError(
      'input',
      'INVALID_ARGUMENTS',
      'Usage: cli.ts <recording.wav> [--capture-id <id>]',
    );
  }
  return { filePath, captureId };
}

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  try {
    const input = parseArgs(args);
    const config = loadConfig(env);
    const logger: SafeLogger = {
      info: (event) => io.stderr(`${JSON.stringify(event)}\n`),
      error: (event) => io.stderr(`${JSON.stringify(event)}\n`),
    };
    const result = await createAudioPipeline(config, { logger }).processWav(
      input.filePath,
      input.captureId,
    );
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe =
      error instanceof AudioPipelineError
        ? error.toSafeJSON()
        : { name: 'Error', stage: 'unknown', code: 'UNEXPECTED_ERROR' };
    io.stderr(`${JSON.stringify({ event: 'xiaohuan_audio_failed', ...safe })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

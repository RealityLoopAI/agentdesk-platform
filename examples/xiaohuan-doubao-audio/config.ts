import { AudioPipelineError } from './errors.js';

export const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const DEFAULT_ARK_AUDIO_MODEL = 'doubao-seed-2-0-lite-260428';

export interface DoubaoAudioConfig {
  ark: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  requestTimeoutMs: number;
  maxWavBytes: number;
  maxWavDurationMs: number;
}

const PLACEHOLDER_PATTERNS = [
  /^your[-_ ]/i,
  /^replace[-_ ]/i,
  /^changeme$/i,
  /^placeholder$/i,
  /^<.+>$/,
  /^\$\{.+\}$/,
];

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (!value) {
    throw new AudioPipelineError('configuration', 'MISSING_CREDENTIAL', `${name} is required`);
  }
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new AudioPipelineError(
      'configuration',
      'PLACEHOLDER_CREDENTIAL',
      `${name} must not contain a placeholder`,
    );
  }
  return value;
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (!value) {
    throw new AudioPipelineError('configuration', 'MISSING_CONFIGURATION', `${name} is required`);
  }
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new AudioPipelineError(
      'configuration',
      'PLACEHOLDER_CONFIGURATION',
      `${name} must not contain a placeholder`,
    );
  }
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new AudioPipelineError(
      'configuration',
      'INVALID_CONFIGURATION',
      `${name} must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

function httpsUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AudioPipelineError('configuration', 'INVALID_CONFIGURATION', `${name} is invalid`);
  }
  if (url.protocol !== 'https:') {
    throw new AudioPipelineError(
      'configuration',
      'INSECURE_UPSTREAM',
      `${name} must use HTTPS`,
    );
  }
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DoubaoAudioConfig {
  return {
    ark: {
      baseUrl: httpsUrl(env.DOUBAO_ARK_BASE_URL?.trim() || DEFAULT_ARK_BASE_URL, 'DOUBAO_ARK_BASE_URL'),
      apiKey: requiredSecret(env, 'DOUBAO_ARK_API_KEY'),
      model: requiredText(env, 'DOUBAO_ARK_MODEL'),
    },
    requestTimeoutMs: positiveInteger(env, 'DOUBAO_REQUEST_TIMEOUT_MS', 60_000, 120_000),
    maxWavBytes: positiveInteger(env, 'DOUBAO_WAV_MAX_BYTES', 10 * 1024 * 1024, 50 * 1024 * 1024),
    maxWavDurationMs: positiveInteger(
      env,
      'DOUBAO_WAV_MAX_DURATION_MS',
      20_000,
      120_000,
    ),
  };
}

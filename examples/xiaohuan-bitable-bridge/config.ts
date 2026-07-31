import path from 'node:path';

import {
  loadConfig as loadAudioConfig,
  type DoubaoAudioConfig,
  type WholeUtteranceHttpConfig,
} from '../xiaohuan-doubao-audio/index.js';
import type { TrustedChannelIdentity } from '../../src/channels/adapter.js';
import { parseFieldMap, type ExperimentFieldMap } from './mapper.js';

export const BRIDGE_ENV_PREFIX = 'XIAOHUAN_BITABLE_';
export const DEFAULT_FIELD_JOIN_SEPARATOR = ' | ';
export const DEFAULT_MAX_FIELD_VALUE_BYTES = 8 * 1024;
export const DEFAULT_HTTP_BIND_HOST = '0.0.0.0';
export const DEFAULT_HTTP_PORT = 50_020;
export const DEFAULT_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_HTTP_MAX_QUEUE = 8;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 10_000;

export interface DisabledBridgeConfig {
  enabled: false;
}

export interface EnabledBridgeConfig {
  enabled: true;
  authenticatedUserId: string;
  platformId: string;
  senderIdentity: TrustedChannelIdentity;
  feishuTranscriptMirrorEnabled: boolean;
  resource: string;
  fieldMap: ExperimentFieldMap;
  joinSeparator: string;
  maxFieldValueBytes: number;
  httpService: WholeUtteranceHttpConfig;
  audio: DoubaoAudioConfig;
}

export type BridgeConfig = DisabledBridgeConfig | EnabledBridgeConfig;

export class BridgeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeConfigError';
    this.code = code;
  }
}

const PLACEHOLDER_PATTERNS = [
  /^your[-_ ]/i,
  /^replace[-_ ]/i,
  /replace[_-]?me/i,
  /^changeme$/i,
  /^placeholder$/i,
  /^<.+>$/,
  /^\$\{.+\}$/,
];

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new BridgeConfigError('INVALID_BOOLEAN', `${name} must be exactly "true" or "false"`);
}

function requiredText(env: NodeJS.ProcessEnv, name: string, maximumLength = 256): string {
  const value = env[name]?.trim() ?? '';
  if (!value || value.length > maximumLength || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new BridgeConfigError(
      'INVALID_REQUIRED_BINDING',
      `${name} must contain a non-placeholder value of at most ${maximumLength} characters`,
    );
  }
  return value;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BridgeConfigError('INVALID_INTEGER', `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateLogicalResource(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || /^(?:bas|tbl)[A-Za-z0-9_-]+$/i.test(value)) {
    throw new BridgeConfigError(
      'INVALID_LOGICAL_RESOURCE',
      'XIAOHUAN_BITABLE_RESOURCE must be a logical alias, not a physical app or table identifier',
    );
  }
  return value;
}

function loadHttpServiceConfig(env: NodeJS.ProcessEnv, audio: DoubaoAudioConfig): WholeUtteranceHttpConfig {
  const outputDir = env.XIAOHUAN_BITABLE_HTTP_OUTPUT_DIR?.trim();
  return {
    bindHost: env.XIAOHUAN_BITABLE_HTTP_BIND?.trim() || DEFAULT_HTTP_BIND_HOST,
    port: boundedInteger(env, 'XIAOHUAN_BITABLE_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65_535),
    ...(outputDir ? { outputDir: path.resolve(outputDir) } : {}),
    maxBodyBytes: boundedInteger(
      env,
      'XIAOHUAN_BITABLE_HTTP_MAX_BODY_BYTES',
      Math.min(DEFAULT_HTTP_MAX_BODY_BYTES, audio.maxWavBytes),
      1,
      DEFAULT_HTTP_MAX_BODY_BYTES,
    ),
    maxDurationMs: boundedInteger(
      env,
      'XIAOHUAN_BITABLE_HTTP_MAX_DURATION_MS',
      audio.maxWavDurationMs,
      1,
      audio.maxWavDurationMs,
    ),
    expectedSampleRate: 16_000,
    maxQueue: boundedInteger(env, 'XIAOHUAN_BITABLE_HTTP_MAX_QUEUE', DEFAULT_HTTP_MAX_QUEUE, 1, 64),
    requestTimeoutMs: boundedInteger(
      env,
      'XIAOHUAN_BITABLE_HTTP_REQUEST_TIMEOUT_MS',
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      100,
      60_000,
    ),
    keepUtterances: booleanValue(env, 'XIAOHUAN_BITABLE_KEEP_UTTERANCES'),
  };
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  if (!booleanValue(env, 'XIAOHUAN_BITABLE_BRIDGE_ENABLED')) {
    return { enabled: false };
  }
  if (
    !booleanValue(env, 'XIAOHUAN_BITABLE_ALLOW_EXTERNAL_UPLOAD') ||
    !booleanValue(env, 'XIAOHUAN_BITABLE_ALLOW_AGENT_DELIVERY')
  ) {
    throw new BridgeConfigError(
      'CONSENT_REQUIRED',
      'Bridge startup requires explicit external-upload and Agent-delivery consent',
    );
  }

  const platformId = requiredText(env, 'XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID');
  const routeMatch = /^feishu:p2p:(ou_[A-Za-z0-9_-]+)$/.exec(platformId);
  if (!routeMatch) {
    throw new BridgeConfigError(
      'INVALID_P2P_ROUTE',
      'XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID must be a Feishu P2P route',
    );
  }

  const joinSeparator = env.XIAOHUAN_BITABLE_JOIN_SEPARATOR ?? DEFAULT_FIELD_JOIN_SEPARATOR;
  if (!joinSeparator || joinSeparator.length > 32 || /[\u0000-\u001f\u007f]/.test(joinSeparator)) {
    throw new BridgeConfigError(
      'INVALID_JOIN_SEPARATOR',
      'XIAOHUAN_BITABLE_JOIN_SEPARATOR must be 1-32 printable characters',
    );
  }

  const audio = loadAudioConfig(env);
  return {
    enabled: true,
    authenticatedUserId: requiredText(env, 'XIAOHUAN_BITABLE_AUTHENTICATED_USER_ID'),
    platformId,
    senderIdentity: {
      provider: 'feishu',
      providerScope: requiredText(env, 'FEISHU_APP_ID'),
      identifierType: 'open_id',
      externalSubject: routeMatch[1]!,
    },
    feishuTranscriptMirrorEnabled: booleanValue(env, 'XIAOHUAN_BITABLE_FEISHU_TRANSCRIPT_MIRROR_ENABLED'),
    resource: validateLogicalResource(requiredText(env, 'XIAOHUAN_BITABLE_RESOURCE', 128)),
    fieldMap: parseFieldMap(requiredText(env, 'XIAOHUAN_BITABLE_FIELD_MAP_JSON', 8_192)),
    joinSeparator,
    maxFieldValueBytes: boundedInteger(
      env,
      'XIAOHUAN_BITABLE_MAX_FIELD_VALUE_BYTES',
      DEFAULT_MAX_FIELD_VALUE_BYTES,
      1,
      64 * 1024,
    ),
    httpService: loadHttpServiceConfig(env, audio),
    audio,
  };
}

import path from 'node:path';

import {
  loadConfig as loadAudioConfig,
  parseVadServiceArgs,
  type DoubaoAudioConfig,
  type VadServiceConfig,
} from '../xiaohuan-doubao-audio/index.js';
import { parseFieldMap, type ExperimentFieldMap } from './mapper.js';

export const BRIDGE_ENV_PREFIX = 'XIAOHUAN_BITABLE_';
export const DEFAULT_FIELD_JOIN_SEPARATOR = ' | ';
export const DEFAULT_MAX_FIELD_VALUE_BYTES = 8 * 1024;
export const DEFAULT_TTS_ACK_TEXT = '收到';
export const DEFAULT_TTS_ACK_TIMEOUT_MS = 2_000;

export interface DisabledTtsAckConfig {
  enabled: false;
}

export interface EnabledTtsAckConfig {
  enabled: true;
  baseUrl: string;
  text: string;
  timeoutMs: number;
}

export type TtsAckConfig = DisabledTtsAckConfig | EnabledTtsAckConfig;

export interface DisabledBridgeConfig {
  enabled: false;
}

export interface EnabledBridgeConfig {
  enabled: true;
  authenticatedUserId: string;
  platformId: string;
  resource: string;
  fieldMap: ExperimentFieldMap;
  joinSeparator: string;
  maxFieldValueBytes: number;
  ttsAck: TtsAckConfig;
  vadService: VadServiceConfig;
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

function optionalVadArg(env: NodeJS.ProcessEnv, args: string[], envName: string, option: string): void {
  const value = env[envName]?.trim();
  if (value) args.push(option, value);
}

function loadVadConfig(env: NodeJS.ProcessEnv): VadServiceConfig {
  const args = [
    '--sdp',
    path.resolve(requiredText(env, 'XIAOHUAN_BITABLE_SDP_PATH', 4_096)),
    '--process',
    '--allow-external-upload',
  ];
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_FFMPEG_PATH', '--ffmpeg');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_THRESHOLD_DB', '--threshold-db');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_FRAME_MS', '--frame-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_START_FRAMES', '--start-frames');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_PRE_ROLL_MS', '--pre-roll-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_TRAILING_SILENCE_MS', '--trailing-silence-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_MIN_SPEECH_MS', '--min-speech-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_VAD_MAX_UTTERANCE_MS', '--max-utterance-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_MAX_QUEUE', '--max-queue');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_FIRST_AUDIO_TIMEOUT_MS', '--first-audio-timeout-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_STOP_GRACE_MS', '--stop-grace-ms');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_OUTPUT_DIR', '--output-dir');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_CAPTURE_PREFIX', '--capture-prefix');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_NORMALIZE_PEAK_DB', '--normalize-peak-db');
  optionalVadArg(env, args, 'XIAOHUAN_BITABLE_MAX_NORMALIZE_GAIN_DB', '--max-normalize-gain-db');
  if (booleanValue(env, 'XIAOHUAN_BITABLE_KEEP_UTTERANCES')) {
    args.push('--keep-utterances');
  }
  return parseVadServiceArgs(args);
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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function loadTtsAckConfig(env: NodeJS.ProcessEnv): TtsAckConfig {
  if (!booleanValue(env, 'XIAOHUAN_BITABLE_TTS_ACK_ENABLED')) {
    return { enabled: false };
  }
  const rawBaseUrl = requiredText(env, 'XIAOHUAN_BITABLE_TTS_BASE_URL', 512);
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new BridgeConfigError(
      'INVALID_TTS_BASE_URL',
      'XIAOHUAN_BITABLE_TTS_BASE_URL must be an absolute trusted-LAN HTTP URL',
    );
  }
  if (
    url.protocol !== 'http:' ||
    !isPrivateIpv4(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new BridgeConfigError(
      'INVALID_TTS_BASE_URL',
      'XIAOHUAN_BITABLE_TTS_BASE_URL must be a credential-free private-IPv4 HTTP origin with an explicit port',
    );
  }
  const text = env.XIAOHUAN_BITABLE_TTS_ACK_TEXT?.trim() || DEFAULT_TTS_ACK_TEXT;
  if (
    text.length > 500 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  ) {
    throw new BridgeConfigError(
      'INVALID_TTS_TEXT',
      'XIAOHUAN_BITABLE_TTS_ACK_TEXT must contain 1-500 safe characters',
    );
  }
  return {
    enabled: true,
    baseUrl: url.origin,
    text,
    timeoutMs: boundedInteger(
      env,
      'XIAOHUAN_BITABLE_TTS_TIMEOUT_MS',
      DEFAULT_TTS_ACK_TIMEOUT_MS,
      100,
      10_000,
    ),
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
  if (!/^feishu:p2p:ou_[A-Za-z0-9_-]+$/.test(platformId)) {
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

  return {
    enabled: true,
    authenticatedUserId: requiredText(env, 'XIAOHUAN_BITABLE_AUTHENTICATED_USER_ID'),
    platformId,
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
    ttsAck: loadTtsAckConfig(env),
    vadService: loadVadConfig(env),
    audio: loadAudioConfig(env),
  };
}

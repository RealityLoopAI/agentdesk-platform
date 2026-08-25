import path from 'node:path';

import { normalizeFeishuP2pTarget } from '../../src/channels/feishu/outbound-image.js';

export interface VoicePhotoMonitorConfig {
  rootPath: string;
  stateDbPath: string;
  feishuTarget: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuBaseUrl: string;
  feishuRequestTimeoutMs: number;
  pollIntervalMs: number;
  stabilityScans: number;
  maxImageBytes: number;
  maxCandidatesPerScan: number;
  deliveryConcurrency: number;
  maxSendsPerMinute: number;
  retryBaseMs: number;
  retryMaxMs: number;
  sendingLeaseMs: number;
  ownerLeaseMs: number;
  shutdownDeadlineMs: number;
}

export class VoicePhotoMonitorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoicePhotoMonitorConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new VoicePhotoMonitorConfigError(`${name} is required`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new VoicePhotoMonitorConfigError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function absoluteLocalPath(value: string, name: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new VoicePhotoMonitorConfigError(`${name} must be a local mounted path, not a URL`);
  }
  if (!path.isAbsolute(value)) throw new VoicePhotoMonitorConfigError(`${name} must be absolute`);
  return path.resolve(value);
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function loadVoicePhotoMonitorConfig(env: NodeJS.ProcessEnv = process.env): VoicePhotoMonitorConfig {
  const rootPath = absoluteLocalPath(required(env, 'VOICE_PHOTOS_ROOT'), 'VOICE_PHOTOS_ROOT');
  const stateDbPath = absoluteLocalPath(required(env, 'VOICE_PHOTOS_STATE_DB'), 'VOICE_PHOTOS_STATE_DB');
  if (isContained(rootPath, stateDbPath)) {
    throw new VoicePhotoMonitorConfigError('VOICE_PHOTOS_STATE_DB must be outside VOICE_PHOTOS_ROOT');
  }

  const feishuTarget = required(env, 'VOICE_PHOTOS_FEISHU_TARGET');
  try {
    normalizeFeishuP2pTarget(feishuTarget);
  } catch {
    throw new VoicePhotoMonitorConfigError('VOICE_PHOTOS_FEISHU_TARGET must use feishu:p2p:ou_*');
  }

  const retryBaseMs = integer(env, 'VOICE_PHOTOS_RETRY_BASE_MS', 1_000, 100, 60_000);
  const retryMaxMs = integer(env, 'VOICE_PHOTOS_RETRY_MAX_MS', 300_000, retryBaseMs, 3_600_000);

  return {
    rootPath,
    stateDbPath,
    feishuTarget,
    feishuAppId: required(env, 'FEISHU_APP_ID'),
    feishuAppSecret: required(env, 'FEISHU_APP_SECRET'),
    feishuBaseUrl: (env.FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/+$/, ''),
    feishuRequestTimeoutMs: integer(env, 'FEISHU_REQUEST_TIMEOUT_MS', 10_000, 100, 120_000),
    pollIntervalMs: integer(env, 'VOICE_PHOTOS_POLL_INTERVAL_MS', 5_000, 250, 3_600_000),
    stabilityScans: integer(env, 'VOICE_PHOTOS_STABILITY_SCANS', 2, 2, 20),
    maxImageBytes: integer(env, 'VOICE_PHOTOS_MAX_IMAGE_BYTES', 20 * 1024 * 1024, 1_024, 100 * 1024 * 1024),
    maxCandidatesPerScan: integer(env, 'VOICE_PHOTOS_MAX_CANDIDATES_PER_SCAN', 100_000, 1, 1_000_000),
    deliveryConcurrency: integer(env, 'VOICE_PHOTOS_DELIVERY_CONCURRENCY', 1, 1, 8),
    maxSendsPerMinute: integer(env, 'VOICE_PHOTOS_MAX_SENDS_PER_MINUTE', 30, 1, 600),
    retryBaseMs,
    retryMaxMs,
    sendingLeaseMs: integer(env, 'VOICE_PHOTOS_SENDING_LEASE_MS', 60_000, 1_000, 3_600_000),
    ownerLeaseMs: integer(env, 'VOICE_PHOTOS_OWNER_LEASE_MS', 30_000, 5_000, 3_600_000),
    shutdownDeadlineMs: integer(env, 'VOICE_PHOTOS_SHUTDOWN_DEADLINE_MS', 10_000, 100, 120_000),
  };
}

export function safeVoicePhotoMonitorConfig(config: VoicePhotoMonitorConfig): Record<string, unknown> {
  return {
    rootPath: config.rootPath,
    stateDbPath: config.stateDbPath,
    targetType: 'feishu-p2p',
    feishuBaseUrl: config.feishuBaseUrl,
    pollIntervalMs: config.pollIntervalMs,
    stabilityScans: config.stabilityScans,
    maxImageBytes: config.maxImageBytes,
    maxCandidatesPerScan: config.maxCandidatesPerScan,
    deliveryConcurrency: config.deliveryConcurrency,
    maxSendsPerMinute: config.maxSendsPerMinute,
  };
}

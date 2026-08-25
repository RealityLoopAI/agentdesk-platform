import path from 'node:path';

import type { VoicePhotoSceneRoute, VoicePhotoSceneRoutes } from './json-analysis.js';

export interface VoicePhotoJsonMonitorConfig {
  enabled: boolean;
  rootPath: string;
  stateDbPath: string;
  authenticatedUserId: string;
  platformId: string;
  routes: VoicePhotoSceneRoutes;
  machineIngestHmacKey: string;
  pollIntervalMs: number;
  stabilityScans: number;
  maxJsonBytes: number;
  maxCandidatesPerScan: number;
}

export class VoicePhotoJsonConfigError extends Error {}

function boolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim();
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new VoicePhotoJsonConfigError(`${name} must be true or false`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new VoicePhotoJsonConfigError(`${name} is required`);
  return value;
}

function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!path.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new VoicePhotoJsonConfigError(`${name} must be an absolute mounted local path`);
  }
  return path.resolve(value);
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new VoicePhotoJsonConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function logicalResource(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ||
    /^(?:bas|tbl)[A-Za-z0-9_-]+$/i.test(value)
  ) {
    throw new VoicePhotoJsonConfigError(`${label} must be a logical resource alias`);
  }
  return value;
}

function loadRoutes(env: NodeJS.ProcessEnv): VoicePhotoSceneRoutes {
  let raw: unknown;
  try {
    raw = JSON.parse(required(env, 'VOICE_PHOTOS_SCENE_ROUTES_JSON'));
  } catch {
    throw new VoicePhotoJsonConfigError('VOICE_PHOTOS_SCENE_ROUTES_JSON must be valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new VoicePhotoJsonConfigError('VOICE_PHOTOS_SCENE_ROUTES_JSON must define at least one scene');
  }
  const routes: VoicePhotoSceneRoutes = {};
  for (const [scene, candidate] of Object.entries(raw)) {
    if (!scene.trim() || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new VoicePhotoJsonConfigError('every scene route must be a named object');
    }
    const value = candidate as Record<string, unknown>;
    const allowedKeys = new Set(['resource', 'measurementField', 'acceptedUnits', 'valueType', 'staticFields']);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
      throw new VoicePhotoJsonConfigError(`scene route ${scene} contains an unexpected property`);
    }
    if (
      typeof value.measurementField !== 'string' ||
      !value.measurementField.trim() ||
      !Array.isArray(value.acceptedUnits) ||
      value.acceptedUnits.length === 0 ||
      value.acceptedUnits.some((unit) => typeof unit !== 'string' || !unit.trim()) ||
      (value.valueType !== 'number' && value.valueType !== 'text-with-unit') ||
      !value.staticFields ||
      typeof value.staticFields !== 'object' ||
      Array.isArray(value.staticFields) ||
      Object.entries(value.staticFields).some(
        ([field, fieldValue]) => !field.trim() || typeof fieldValue !== 'string' || !fieldValue.trim(),
      )
    ) {
      throw new VoicePhotoJsonConfigError(`scene route ${scene} is invalid`);
    }
    routes[scene] = {
      resource: logicalResource(value.resource, `scene route ${scene}.resource`),
      measurementField: value.measurementField.trim(),
      acceptedUnits: [...new Set((value.acceptedUnits as string[]).map((unit) => unit.trim()))],
      valueType: value.valueType,
      staticFields: { ...(value.staticFields as Record<string, string>) },
    } satisfies VoicePhotoSceneRoute;
  }
  return routes;
}

export function loadVoicePhotoJsonMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
): { enabled: false } | VoicePhotoJsonMonitorConfig {
  if (!boolean(env, 'VOICE_PHOTOS_JSON_MONITOR_ENABLED')) return { enabled: false };
  const rootPath = absolute(env, 'VOICE_PHOTOS_ROOT');
  const stateDbPath = absolute(env, 'VOICE_PHOTOS_JSON_STATE_DB');
  const imageStateDbPath = env.VOICE_PHOTOS_STATE_DB?.trim();
  if (imageStateDbPath && path.resolve(imageStateDbPath) === stateDbPath) {
    throw new VoicePhotoJsonConfigError('VOICE_PHOTOS_JSON_STATE_DB must differ from VOICE_PHOTOS_STATE_DB');
  }
  const relative = path.relative(rootPath, stateDbPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new VoicePhotoJsonConfigError('VOICE_PHOTOS_JSON_STATE_DB must be outside VOICE_PHOTOS_ROOT');
  }
  const routes = loadRoutes(env);
  const hmacKey = required(env, 'VOICE_PHOTOS_MACHINE_INGEST_HMAC_KEY');
  if (hmacKey.length < 32) {
    throw new VoicePhotoJsonConfigError('VOICE_PHOTOS_MACHINE_INGEST_HMAC_KEY must be at least 32 characters');
  }
  return {
    enabled: true,
    rootPath,
    stateDbPath,
    authenticatedUserId: required(env, 'VOICE_PHOTOS_AUTHENTICATED_USER_ID'),
    platformId: required(env, 'VOICE_PHOTOS_PLATFORM_ID'),
    routes,
    machineIngestHmacKey: hmacKey,
    pollIntervalMs: integer(env, 'VOICE_PHOTOS_POLL_INTERVAL_MS', 5_000, 250, 3_600_000),
    stabilityScans: integer(env, 'VOICE_PHOTOS_STABILITY_SCANS', 2, 2, 20),
    maxJsonBytes: integer(env, 'VOICE_PHOTOS_MAX_JSON_BYTES', 1024 * 1024, 128, 10 * 1024 * 1024),
    maxCandidatesPerScan: integer(env, 'VOICE_PHOTOS_MAX_CANDIDATES_PER_SCAN', 10_000, 1, 1_000_000),
  };
}

export function safeVoicePhotoJsonConfig(config: VoicePhotoJsonMonitorConfig): Record<string, unknown> {
  return {
    rootPath: config.rootPath,
    stateDbPath: config.stateDbPath,
    sceneRoutes: Object.fromEntries(
      Object.entries(config.routes).map(([scene, route]) => [
        scene,
        { resource: route.resource, fields: [...Object.keys(route.staticFields), route.measurementField] },
      ]),
    ),
    pollIntervalMs: config.pollIntervalMs,
    stabilityScans: config.stabilityScans,
    maxJsonBytes: config.maxJsonBytes,
  };
}

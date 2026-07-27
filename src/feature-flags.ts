import { readEnvFile } from './env.js';

/**
 * Host-side release gates for the unified Web/Feishu rollout.
 *
 * WEB_ENABLED remains owned by src/web/config.ts because that flag controls
 * whether an entire listener (and its required security configuration) exists.
 * This module owns gates that affect the normal Host message path.
 */
export const HOST_FEATURE_FLAG_KEYS = ['CROSS_CHANNEL_LANES_ENABLED'] as const;

export type FeatureFlagReader = (key: string) => string | undefined;

export interface HostFeatureFlags {
  crossChannelLanesEnabled: boolean;
}

export function parseOptInFeatureFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no, on/off)`);
}

export function parseHostFeatureFlags(get: FeatureFlagReader): HostFeatureFlags {
  return {
    crossChannelLanesEnabled: parseOptInFeatureFlag(
      'CROSS_CHANNEL_LANES_ENABLED',
      get('CROSS_CHANNEL_LANES_ENABLED'),
    ),
  };
}

export function readHostFeatureFlags(): HostFeatureFlags {
  const dotenv = readEnvFile([...HOST_FEATURE_FLAG_KEYS]);
  return parseHostFeatureFlags((key) => process.env[key]?.trim() || dotenv[key]?.trim() || undefined);
}

import { describe, expect, it } from 'vitest';

import { parseWebConfig } from './config.js';

const ENABLED_WEB_CONFIG = {
  WEB_ENABLED: 'true',
  WEB_PUBLIC_ORIGIN: 'https://agent.example.com',
  WEB_SESSION_SECRET: '45ac2d73456f87a7884e3fb326469107cdf739a63c92e1ba85bb1c32e864056f',
  FEISHU_APP_ID: 'cli_test_app',
  FEISHU_APP_SECRET: 'provider-secret',
} as const;

function enabledConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = { ...ENABLED_WEB_CONFIG, ...overrides };
  return parseWebConfig((key) => values[key]);
}

describe('Web listener release gate', () => {
  it('does not require SSO configuration or start a Web surface when WEB_ENABLED is unset', () => {
    expect(parseWebConfig(() => undefined)).toBeNull();
  });

  it('does not treat an ambiguous WEB_ENABLED value as enabled or disabled', () => {
    expect(() => parseWebConfig((key) => (key === 'WEB_ENABLED' ? 'enabled' : undefined))).toThrow(
      /Invalid boolean value/,
    );
  });
});

describe('Feishu SSO Scope', () => {
  it('does not force an OAuth Scope when none is configured', () => {
    expect(enabledConfig()?.feishu.scope).toBeUndefined();
  });

  it('preserves an explicitly configured OAuth Scope', () => {
    expect(enabledConfig({ FEISHU_SSO_SCOPE: 'contact:user.employee_id:readonly' })?.feishu.scope).toBe(
      'contact:user.employee_id:readonly',
    );
  });

  it('treats a whitespace-only OAuth Scope as unset', () => {
    expect(enabledConfig({ FEISHU_SSO_SCOPE: '   ' })?.feishu.scope).toBeUndefined();
  });
});

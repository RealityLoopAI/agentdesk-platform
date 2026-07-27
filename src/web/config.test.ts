import { describe, expect, it } from 'vitest';

import { parseWebConfig } from './config.js';

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

import { describe, expect, it } from 'vitest';

import { parseHostFeatureFlags, parseOptInFeatureFlag } from './feature-flags.js';

describe('unified messaging Host feature flags', () => {
  it('keeps cross-channel Lane auto-association off by default', () => {
    expect(parseHostFeatureFlags(() => undefined)).toEqual({
      crossChannelLanesEnabled: false,
    });
  });

  it.each(['true', '1', 'YES', 'on'])('accepts the documented enabled value %s', (value) => {
    expect(parseOptInFeatureFlag('FLAG', value)).toBe(true);
  });

  it.each(['false', '0', 'No', 'off'])('accepts the documented disabled value %s', (value) => {
    expect(parseOptInFeatureFlag('FLAG', value)).toBe(false);
  });

  it('rejects ambiguous values instead of accidentally widening message sharing', () => {
    expect(() => parseOptInFeatureFlag('CROSS_CHANNEL_LANES_ENABLED', 'enabled')).toThrow(
      /CROSS_CHANNEL_LANES_ENABLED/,
    );
  });
});

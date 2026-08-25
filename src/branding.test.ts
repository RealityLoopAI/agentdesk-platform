import { describe, expect, it } from 'vitest';

import { buildPublicBranding, DEFAULT_UI_THEME } from './branding.js';

describe('public UI branding', () => {
  it('returns the approved same-origin default theme without machine namespace data', () => {
    expect(buildPublicBranding({ displayName: 'RealityLoop' })).toEqual({
      displayName: 'RealityLoop',
      logoPath: '/brand/logo.svg',
      theme: DEFAULT_UI_THEME,
    });
    expect(JSON.stringify(buildPublicBranding())).not.toContain('BRAND_NAMESPACE');
  });

  it('accepts only local asset paths and six-digit hex color tokens', () => {
    const values: Record<string, string> = {
      BRAND_UI_LOGO_PATH: '/brand/company.webp',
      BRAND_UI_PRIMARY: '#123abc',
      BRAND_UI_PRIMARY_HOVER: 'rgb(0,0,0)',
    };
    expect(
      buildPublicBranding({
        displayName: '  Company\u0000 Platform  ',
        read: (key) => values[key],
      }),
    ).toMatchObject({
      displayName: 'Company Platform',
      logoPath: '/brand/company.webp',
      theme: {
        brandPrimary: '#123ABC',
        brandPrimaryHover: DEFAULT_UI_THEME.brandPrimaryHover,
      },
    });

    for (const unsafe of [
      'https://cdn.example/logo.svg',
      '//attacker.example/logo.svg',
      '/../secret.svg',
      '/brand/logo.svg?token=secret',
      '/private/machine/path.txt',
    ]) {
      expect(buildPublicBranding({ read: (key) => (key === 'BRAND_UI_LOGO_PATH' ? unsafe : undefined) }).logoPath).toBe(
        '/brand/logo.svg',
      );
    }
  });

  it('uses an accessible generic fallback for invalid public display names', () => {
    expect(buildPublicBranding({ displayName: '\u0000\u0007' }).displayName).toBe('Agent Platform');
    expect(buildPublicBranding({ displayName: 'x'.repeat(81) }).displayName).toBe('Agent Platform');
  });

  it('rejects valid hex overrides when their foreground contrast is below WCAG AA', () => {
    const values: Record<string, string> = {
      BRAND_UI_PRIMARY: '#FFFFFF',
      BRAND_UI_TEXT_PRIMARY: '#FFFFFF',
      BRAND_UI_TEXT_SECONDARY: '#FAF8F4',
      BRAND_UI_STATUS_WARNING: '#F2C94C',
    };
    const theme = buildPublicBranding({ read: (key) => values[key] }).theme;
    expect(theme.brandPrimary).toBe(DEFAULT_UI_THEME.brandPrimary);
    expect(theme.textPrimary).toBe(DEFAULT_UI_THEME.textPrimary);
    expect(theme.textSecondary).toBe(DEFAULT_UI_THEME.textSecondary);
    expect(theme.statusWarning).toBe(DEFAULT_UI_THEME.statusWarning);
  });
});

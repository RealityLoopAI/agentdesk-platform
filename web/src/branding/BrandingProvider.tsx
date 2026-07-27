import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type PropsWithChildren } from 'react';

import { getBranding } from '@/api/client';
import type { PublicBranding } from '@/api/types';

const FALLBACK_BRANDING: PublicBranding = {
  displayName: 'Agent Platform',
  logoPath: '/brand/logo.svg',
  theme: {
    brandPrimary: '#245866',
    brandPrimaryHover: '#1B4652',
    brandPrimaryActive: '#143A44',
    brandSurfaceSubtle: '#E8F1F2',
    brandBorder: '#B8D0D3',
    canvas: '#FAF8F4',
    surface: '#FFFFFF',
    border: '#DDE5E5',
    textPrimary: '#18343B',
    textSecondary: '#60757A',
    statusSuccess: '#287A5B',
    statusWarning: '#A85E18',
    statusDanger: '#C44545',
  },
};

const CSS_TOKEN: Record<keyof PublicBranding['theme'], string> = {
  brandPrimary: '--brand-primary',
  brandPrimaryHover: '--brand-primary-hover',
  brandPrimaryActive: '--brand-primary-active',
  brandSurfaceSubtle: '--brand-surface-subtle',
  brandBorder: '--brand-border',
  canvas: '--canvas',
  surface: '--surface',
  border: '--border',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  statusSuccess: '--status-success',
  statusWarning: '--status-warning',
  statusDanger: '--status-danger',
};

const BrandingContext = createContext<PublicBranding>(FALLBACK_BRANDING);

export function BrandingProvider({ children }: PropsWithChildren) {
  const query = useQuery({
    queryKey: ['branding'],
    queryFn: getBranding,
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const branding = query.data ?? FALLBACK_BRANDING;

  useEffect(() => {
    document.title = branding.displayName;
    for (const [key, token] of Object.entries(CSS_TOKEN) as Array<[keyof PublicBranding['theme'], string]>) {
      document.documentElement.style.setProperty(token, branding.theme[key]);
    }
  }, [branding]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

export function useBranding(): PublicBranding {
  return useContext(BrandingContext);
}

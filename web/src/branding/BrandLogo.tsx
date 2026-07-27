import { useState } from 'react';

import { cn } from '@/lib/cn';
import { useBranding } from './BrandingProvider';

export function BrandLogo({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  const branding = useBranding();
  const [failed, setFailed] = useState(false);
  const label = decorative ? '' : `${branding.displayName} 标志`;

  if (failed) {
    return (
      <span
        aria-label={label || undefined}
        aria-hidden={decorative || undefined}
        className={cn(
          'inline-grid aspect-square place-items-center rounded-xl bg-brand text-sm font-bold text-white',
          className,
        )}
      >
        {decorative ? null : branding.displayName.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={branding.logoPath}
      alt={label}
      aria-hidden={decorative || undefined}
      className={cn('aspect-square object-contain', className)}
      onError={() => setFailed(true)}
    />
  );
}

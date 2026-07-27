import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { server } from '@/test/server';
import { BrandingProvider } from './BrandingProvider';
import { BrandLogo } from './BrandLogo';

function renderLogo(decorative = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrandingProvider>
        <BrandLogo decorative={decorative} />
      </BrandingProvider>
    </QueryClientProvider>,
  );
}

describe('BrandLogo', () => {
  it('falls back to an accessible brand initial when the configured image is missing', async () => {
    server.use(
      http.get('/api/branding', () =>
        HttpResponse.json({
          branding: {
            displayName: 'Test Platform',
            logoPath: '/brand/missing.svg',
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
          },
        }),
      ),
    );
    renderLogo();
    const image = await screen.findByRole('img', { name: 'Test Platform 标志' });
    fireEvent.error(image);

    const fallback = await screen.findByLabelText('Test Platform 标志');
    expect(fallback).toHaveTextContent('T');
    expect(fallback).not.toHaveAttribute('src');
  });

  it('keeps decorative fallback hidden from assistive technology', async () => {
    renderLogo(true);
    await waitFor(() => expect(document.title).toBe('Test Platform'));
    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    const fallback = document.querySelector('[aria-hidden="true"]');
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent('');
  });
});

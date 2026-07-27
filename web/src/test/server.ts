import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const server = setupServer(
  http.get('/api/branding', () =>
    HttpResponse.json({
      branding: {
        displayName: 'Test Platform',
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
          statusWarning: '#B66A20',
          statusDanger: '#C44545',
        },
      },
    }),
  ),
);

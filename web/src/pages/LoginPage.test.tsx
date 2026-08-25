import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { BrandingProvider } from '@/branding/BrandingProvider';
import { LoginPage } from './LoginPage';

function renderPage(entry = '/login') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrandingProvider>
        <MemoryRouter initialEntries={[entry]}>
          <LoginPage />
        </MemoryRouter>
      </BrandingProvider>
    </QueryClientProvider>,
  );
}

describe('LoginPage', () => {
  it('loads public branding and uses a top-level Feishu SSO navigation', async () => {
    renderPage();
    await waitFor(() => expect(document.title).toBe('Test Platform'));
    expect(screen.getByRole('heading', { name: '登录工作台' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /使用飞书登录/ })).toHaveAttribute('href', '/auth/feishu/start');
    expect(screen.getAllByText(/Test Platform/)).not.toHaveLength(0);
  });

  it('shows a generic authentication error without provider details', async () => {
    renderPage('/login?error=authentication_failed');
    expect(await screen.findByRole('alert')).toHaveTextContent('登录没有完成');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/code|token|state/i);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { getMe } from '@/api/client';
import type { MeResponse } from '@/api/types';
import { server } from '@/test/server';
import { ConversationPlaceholder, ConversationsPage } from './ConversationsPage';

vi.mock('@/events/useWebEventStream', () => ({
  useWebEventStream: () => 'open',
}));

const me: MeResponse = {
  user: { id: 'alice', kind: 'person', displayName: 'Alice' },
  csrfToken: 'csrf-conversations-page',
  sessionExpiresAt: '2026-07-28T10:00:00.000Z',
};

function renderPage(client: QueryClient) {
  client.setQueryData(['me'], me);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/conversations']}>
        <Routes>
          <Route path="/conversations" element={<ConversationsPage />}>
            <Route index element={<ConversationPlaceholder />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function authenticateClient(): Promise<void> {
  server.use(http.get('/api/me', () => HttpResponse.json(me)));
  await getMe();
}

describe('ConversationsPage', () => {
  it('finishes protected reconciliation before loading the Feishu-first conversation list', async () => {
    await authenticateClient();
    const requests: string[] = [];
    server.use(
      http.post('/api/conversations/reconcile', async ({ request }) => {
        requests.push('reconcile');
        expect(request.headers.get('x-csrf-token')).toBe(me.csrfToken);
        return HttpResponse.json({
          scanned: 1,
          linked: 1,
          existing: 0,
          dryRunEligible: 0,
          skippedUnauthorized: 0,
          skippedMode: 0,
          conflicts: 0,
          hasMore: false,
          nextCursor: 'session-feishu',
        });
      }),
      http.get('/api/conversations', () => {
        requests.push('list');
        return HttpResponse.json({
          conversations: [
            {
              id: 'lane-feishu',
              agentGroup: { id: 'assistant-1', name: '多维表格助手' },
              sourceChannel: 'feishu',
              status: 'active',
              createdAt: '2026-07-27T10:00:00.000Z',
              archivedAt: null,
              lastActiveAt: '2026-07-27T10:30:00.000Z',
            },
          ],
          availableAgentGroups: [{ id: 'assistant-1', name: '多维表格助手' }],
        });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);

    expect(screen.getByText('正在同步你的飞书会话…')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /多维表格助手/ })).toHaveAttribute(
      'href',
      '/conversations/lane-feishu',
    );
    expect(requests).toEqual(['reconcile', 'list']);
  });

  it('keeps the existing list available and offers a retry when reconciliation fails', async () => {
    await authenticateClient();
    server.use(
      http.post('/api/conversations/reconcile', () =>
        HttpResponse.json({ error: 'reconciliation_unavailable' }, { status: 503 }),
      ),
      http.get('/api/conversations', () => HttpResponse.json({ conversations: [], availableAgentGroups: [] })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);

    expect(await screen.findByText('暂无可见会话')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '部分飞书历史暂未同步，点击重试' })).toBeInTheDocument(),
    );
  });
});

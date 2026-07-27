import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { getMe } from '@/api/client';
import { server } from '@/test/server';
import { ConversationSidebar } from './ConversationSidebar';

const agentGroup = { id: 'agent-1', name: '研究 Agent' };
const existing = {
  id: 'lane-1',
  agentGroup,
  status: 'active' as const,
  createdAt: '2026-07-27T10:00:00.000Z',
  archivedAt: null,
  lastActiveAt: '2026-07-27T10:30:00.000Z',
};

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/conversations']}>
        <ConversationSidebar user={{ id: 'alice', kind: 'feishu', displayName: 'Alice' }} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  server.use(
    http.get('/api/me', () =>
      HttpResponse.json({
        user: { id: 'alice', kind: 'feishu', displayName: 'Alice' },
        csrfToken: 'csrf-sidebar',
        sessionExpiresAt: '2026-07-28T10:00:00.000Z',
      }),
    ),
    http.get('/api/conversations', () =>
      HttpResponse.json({ conversations: [existing], availableAgentGroups: [agentGroup] }),
    ),
  );
  await getMe();
});

describe('ConversationSidebar', () => {
  it('lists accessible lanes and creates a new server-authorized conversation', async () => {
    let postedAgentGroup = '';
    server.use(
      http.post('/api/conversations', async ({ request }) => {
        const body = (await request.json()) as { agentGroupId: string };
        postedAgentGroup = body.agentGroupId;
        return HttpResponse.json(
          {
            conversation: {
              ...existing,
              id: 'lane-2',
              createdAt: '2026-07-27T11:00:00.000Z',
              lastActiveAt: null,
            },
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderSidebar();

    expect(await screen.findByRole('link', { name: /研究 Agent/ })).toHaveAttribute('href', '/conversations/lane-1');
    await user.click(screen.getByRole('button', { name: /新会话/ }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('选择 Agent');
    await user.click(screen.getByRole('button', { name: '创建会话' }));

    await waitFor(() => expect(postedAgentGroup).toBe('agent-1'));
    expect(screen.getByTestId('location')).toHaveTextContent('/conversations/lane-2');
  });
});

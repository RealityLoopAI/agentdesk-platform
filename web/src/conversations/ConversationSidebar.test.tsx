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
  sourceChannel: 'feishu',
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
  it('lists the Feishu source and directly creates when exactly one assistant is available', async () => {
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
    expect(screen.getByText('飞书')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建 Web 对话' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await waitFor(() => expect(postedAgentGroup).toBe('agent-1'));
    expect(screen.getByTestId('location')).toHaveTextContent('/conversations/lane-2');
  });

  it('asks the user to choose only when multiple assistants are available', async () => {
    const second = { id: 'agent-2', name: '数据助手' };
    server.use(
      http.get('/api/conversations', () =>
        HttpResponse.json({ conversations: [existing], availableAgentGroups: [agentGroup, second] }),
      ),
      http.post('/api/conversations', async ({ request }) => {
        const body = (await request.json()) as { agentGroupId: string };
        return HttpResponse.json(
          {
            conversation: {
              ...existing,
              id: 'lane-selected',
              agentGroup: body.agentGroupId === second.id ? second : agentGroup,
              sourceChannel: 'web',
            },
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: '新建 Web 对话' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('选择助手');
    await user.selectOptions(screen.getByLabelText('助手'), second.id);
    await user.click(screen.getByRole('button', { name: '新建对话' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/conversations/lane-selected'));
  });

  it('shows an administrator guidance message without an invalid selector when no assistant is available', async () => {
    server.use(
      http.get('/api/conversations', () => HttpResponse.json({ conversations: [], availableAgentGroups: [] })),
    );
    const user = userEvent.setup();
    renderSidebar();

    expect(await screen.findByText('请联系管理员为你分配助手权限。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建 Web 对话' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('暂时无法新建对话');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/当前没有可用助手/)).toBeInTheDocument();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { getMe } from '@/api/client';
import { server } from '@/test/server';
import { ConversationPage } from './ConversationPage';

const conversation = {
  id: 'lane-1',
  agentGroup: { id: 'agent-1', name: '研究 Agent' },
  sourceChannel: 'feishu',
  status: 'active' as const,
  createdAt: '2026-07-27T10:00:00.000Z',
  archivedAt: null,
  lastActiveAt: '2026-07-27T10:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/conversations/lane-1']}>
        <Routes>
          <Route path="/conversations/:laneId" element={<ConversationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  server.use(
    http.get('/api/me', () =>
      HttpResponse.json({
        user: { id: 'alice', kind: 'feishu', displayName: 'Alice' },
        csrfToken: 'csrf-test',
        sessionExpiresAt: '2026-07-28T10:00:00.000Z',
      }),
    ),
    http.get('/api/conversations', () =>
      HttpResponse.json({ conversations: [conversation], availableAgentGroups: [conversation.agentGroup] }),
    ),
    http.get('/api/conversations/lane-1/messages', () => HttpResponse.json({ messages: [], nextCursor: null })),
    http.get('/api/conversations/lane-1/delivery-subscription', () =>
      HttpResponse.json({
        subscription: {
          channel: 'feishu',
          deliveryKind: 'agent-reply-mirror',
          enabled: false,
          available: true,
        },
      }),
    ),
  );
  await getMe();
});

describe('ConversationPage', () => {
  it('shows an optimistic message and reconciles it with the server id', async () => {
    let submitted: Record<string, unknown> = {};
    server.use(
      http.post('/api/conversations/lane-1/messages', async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            message: {
              clientMessageId: submitted.clientMessageId,
              messageId: 'server-message-1',
              status: 'accepted',
              replayed: false,
            },
          },
          { status: 202 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPage();

    const composer = await screen.findByLabelText('输入消息');
    await user.type(composer, '请总结这份数据');
    await user.click(screen.getByRole('button', { name: '发送消息' }));

    expect(screen.getByText('请总结这份数据')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('已接收')).toBeInTheDocument());
    expect(submitted).toMatchObject({ text: '请总结这份数据' });
    expect(submitted.clientMessageId).toMatch(/^web:/);
  });

  it('retries a failed send with the same stable client message id', async () => {
    const clientIds: string[] = [];
    let attempt = 0;
    server.use(
      http.post('/api/conversations/lane-1/messages', async ({ request }) => {
        const body = (await request.json()) as { clientMessageId: string };
        clientIds.push(body.clientMessageId);
        attempt += 1;
        if (attempt === 1) return HttpResponse.json({ error: 'message_route_failed' }, { status: 503 });
        return HttpResponse.json({
          message: {
            clientMessageId: body.clientMessageId,
            messageId: 'server-message-retry',
            status: 'accepted',
            replayed: true,
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    const composer = await screen.findByLabelText('输入消息');
    await user.type(composer, '同一条重试消息');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await user.click(await screen.findByRole('button', { name: '重试' }));

    await waitFor(() => expect(clientIds).toHaveLength(2));
    expect(clientIds[0]).toBe(clientIds[1]);
  });

  it('shows permission loss separately from a network failure', async () => {
    server.use(
      http.get('/api/conversations/lane-1/messages', () =>
        HttpResponse.json({ error: 'conversation_unavailable' }, { status: 403 }),
      ),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: '你无权访问这段会话' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('权限可能已经被管理员调整');
  });

  it('lets the user explicitly enable Feishu reply mirroring without sending a target identity', async () => {
    let submitted: Record<string, unknown> = {};
    server.use(
      http.post('/api/conversations/lane-1/delivery-subscription', async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          subscription: {
            channel: 'feishu',
            deliveryKind: 'agent-reply-mirror',
            enabled: true,
            available: true,
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', { name: '同步 Agent 回复到飞书' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(submitted).toEqual({ enabled: true });
    expect(toggle).toHaveAttribute('title', expect.stringContaining('你在 Web 端发送的消息不会被重复发送'));
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWebEventStream } from './useWebEventStream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data = '') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

function Harness() {
  const state = useWebEventStream();
  return <span>{state}</span>;
}

function renderHarness(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Harness />} />
          <Route path="/login" element={<h1>重新登录</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useWebEventStream', () => {
  it('deduplicates event ids and reconnects with the last in-memory cursor', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderHarness(client);
    const first = FakeEventSource.instances[0]!;

    act(() => first.onopen?.());
    expect(screen.getByText('open')).toBeInTheDocument();
    const payload = JSON.stringify({
      eventId: 'event-1',
      cursor: 'cursor-1',
      type: 'conversation.message.available',
      laneId: 'lane-1',
      resourceId: 'message-1',
      createdAt: '2026-07-27T10:00:00.000Z',
    });
    act(() => {
      first.emit('web-event', payload);
      first.emit('web-event', payload);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);

    act(() => {
      first.onerror?.();
      vi.advanceTimersByTime(800);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe('/api/events?cursor=cursor-1');
  });

  it('closes the stream and returns to login when the server revokes the session', () => {
    const client = new QueryClient();
    renderHarness(client);
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit('session-revoked'));

    expect(source.closed).toBe(true);
    expect(screen.getByRole('heading', { name: '重新登录' })).toBeInTheDocument();
  });
});

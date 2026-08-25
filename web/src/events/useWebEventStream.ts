import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { notifyAuthenticationRequired } from '@/api/client';
import type { WebEventPayload } from '@/api/types';
import { conversationKeys } from '@/conversations/queryKeys';

export type EventStreamState = 'connecting' | 'open' | 'offline';

const MAX_SEEN_EVENTS = 1_000;
const MAX_RETRY_MS = 30_000;

function parseEvent(data: string): WebEventPayload | null {
  try {
    const candidate = JSON.parse(data) as Partial<WebEventPayload>;
    if (
      typeof candidate.eventId !== 'string' ||
      typeof candidate.cursor !== 'string' ||
      typeof candidate.laneId !== 'string' ||
      typeof candidate.resourceId !== 'string' ||
      typeof candidate.createdAt !== 'string' ||
      ![
        'conversation.message.accepted',
        'conversation.message.available',
        'conversation.confirmation.available',
        'conversation.confirmation.resolved',
      ].includes(candidate.type ?? '')
    ) {
      return null;
    }
    return candidate as WebEventPayload;
  } catch {
    return null;
  }
}

export function useWebEventStream(): EventStreamState {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<EventStreamState>('connecting');
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let stopped = false;
    let attempt = 0;
    const seen = new Set<string>();
    const seenOrder: string[] = [];

    const remember = (eventId: string): boolean => {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      seenOrder.push(eventId);
      if (seenOrder.length > MAX_SEEN_EVENTS) {
        const removed = seenOrder.shift();
        if (removed) seen.delete(removed);
      }
      return true;
    };

    const scheduleReconnect = () => {
      if (stopped || retryTimer !== null) return;
      if (!navigator.onLine) {
        setState('offline');
        return;
      }
      setState('connecting');
      const base = Math.min(1_000 * 2 ** attempt, MAX_RETRY_MS);
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      attempt = Math.min(attempt + 1, 6);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      source?.close();
      const params = new URLSearchParams();
      if (cursor.current) params.set('cursor', cursor.current);
      const url = params.size ? `/api/events?${params.toString()}` : '/api/events';
      source = new EventSource(url);
      source.onopen = () => {
        attempt = 0;
        setState('open');
      };
      source.onerror = () => {
        source?.close();
        source = null;
        scheduleReconnect();
      };
      source.addEventListener('web-event', (rawEvent) => {
        const payload = parseEvent((rawEvent as MessageEvent<string>).data);
        if (!payload || !remember(payload.eventId)) return;
        cursor.current = payload.cursor;
        const confirmationEvent = payload.type.startsWith('conversation.confirmation.');
        void Promise.all(
          confirmationEvent
            ? [
                queryClient.invalidateQueries({ queryKey: conversationKeys.confirmations(payload.laneId) }),
                queryClient.invalidateQueries({ queryKey: conversationKeys.list() }),
              ]
            : [
                queryClient.invalidateQueries({ queryKey: conversationKeys.messages(payload.laneId) }),
                queryClient.invalidateQueries({ queryKey: conversationKeys.list() }),
              ],
        );
      });
      source.addEventListener('session-revoked', () => {
        stopped = true;
        source?.close();
        notifyAuthenticationRequired();
        navigate('/login', { replace: true });
      });
    };

    const handleOffline = () => {
      source?.close();
      source = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      setState('offline');
    };
    const handleOnline = () => {
      if (!stopped && !source) connect();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    if (navigator.onLine) connect();
    else setState('offline');

    return () => {
      stopped = true;
      source?.close();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [navigate, queryClient]);

  return state;
}

import { useInfiniteQuery } from '@tanstack/react-query';

import { getConversationHistory } from '@/api/client';
import type { HistoryMessage } from '@/api/types';
import { conversationKeys } from '@/conversations/queryKeys';

function compareMessages(left: HistoryMessage, right: HistoryMessage): number {
  return (
    left.timestamp.localeCompare(right.timestamp) ||
    (left.sequence ?? -1) - (right.sequence ?? -1) ||
    (left.direction === right.direction ? 0 : left.direction === 'user' ? -1 : 1) ||
    left.id.localeCompare(right.id)
  );
}

export function useConversationMessages(laneId: string) {
  return useInfiniteQuery({
    queryKey: conversationKeys.messages(laneId),
    queryFn: ({ pageParam }) => getConversationHistory(laneId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    select(data) {
      const byId = new Map<string, HistoryMessage>();
      for (const page of data.pages) {
        for (const message of page.messages) byId.set(message.id, message);
      }
      return {
        ...data,
        messages: [...byId.values()].sort(compareMessages),
      };
    },
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { createConversation, listConversations, reconcileConversations } from '@/api/client';
import { conversationKeys } from './queryKeys';

const MAX_RECONCILIATION_BATCHES = 5;

export function useConversationReconciliation(userId: string) {
  return useQuery({
    queryKey: conversationKeys.reconciliation(userId),
    queryFn: async () => {
      let cursor: string | null = null;
      let result = await reconcileConversations();
      for (let batch = 1; result.hasMore && result.nextCursor && batch < MAX_RECONCILIATION_BATCHES; batch += 1) {
        cursor = result.nextCursor;
        result = await reconcileConversations(cursor);
      }
      return result;
    },
    enabled: Boolean(userId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useConversationList() {
  return useQuery({
    queryKey: conversationKeys.list(),
    queryFn: listConversations,
    staleTime: 15_000,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: createConversation,
    async onSuccess(conversation) {
      await queryClient.invalidateQueries({ queryKey: conversationKeys.list() });
      navigate(`/conversations/${encodeURIComponent(conversation.id)}`);
    },
  });
}

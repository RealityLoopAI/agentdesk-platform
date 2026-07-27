import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { createConversation, listConversations } from '@/api/client';
import { conversationKeys } from './queryKeys';

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

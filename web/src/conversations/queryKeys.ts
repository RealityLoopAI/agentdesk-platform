export const conversationKeys = {
  all: ['conversations'] as const,
  reconciliation: (userId: string) => [...conversationKeys.all, 'reconciliation', userId] as const,
  list: () => [...conversationKeys.all, 'list'] as const,
  messages: (laneId: string) => [...conversationKeys.all, laneId, 'messages'] as const,
  confirmations: (laneId: string) => [...conversationKeys.all, laneId, 'confirmations'] as const,
  deliverySubscription: (laneId: string) => [...conversationKeys.all, laneId, 'delivery-subscription'] as const,
};

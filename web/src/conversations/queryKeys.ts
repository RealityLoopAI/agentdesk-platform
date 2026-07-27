export const conversationKeys = {
  all: ['conversations'] as const,
  list: () => [...conversationKeys.all, 'list'] as const,
  messages: (laneId: string) => [...conversationKeys.all, laneId, 'messages'] as const,
  deliverySubscription: (laneId: string) => [...conversationKeys.all, laneId, 'delivery-subscription'] as const,
};

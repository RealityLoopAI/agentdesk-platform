import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { submitMessage } from '@/api/client';
import { ApiFailure } from '@/components/ApiFailure';
import { Button } from '@/components/ui/Button';
import { DeliverySubscriptionControl } from '@/conversations/DeliverySubscriptionControl';
import { GatewayConfirmationPanel } from '@/conversations/GatewayConfirmationPanel';
import { conversationKeys } from '@/conversations/queryKeys';
import { useConversationList } from '@/conversations/useConversations';
import { MessageComposer } from '@/messages/MessageComposer';
import { MessageTimeline, type OptimisticMessage } from '@/messages/MessageTimeline';
import { useConversationMessages } from '@/messages/useConversationMessages';

function newClientMessageId(): string {
  return `web:${crypto.randomUUID()}`;
}

export function ConversationPage() {
  const { laneId = '' } = useParams();
  const queryClient = useQueryClient();
  const list = useConversationList();
  const history = useConversationMessages(laneId);
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);

  useEffect(() => setOptimistic([]), [laneId]);

  const send = useMutation({
    mutationFn: submitMessage,
    onSuccess(result, variables) {
      setOptimistic((current) =>
        current.map((message) =>
          message.clientMessageId === variables.clientMessageId
            ? {
                ...message,
                serverMessageId: result.messageId,
                status: result.status === 'accepted' ? 'accepted' : 'failed',
              }
            : message,
        ),
      );
    },
    onError(_error, variables) {
      setOptimistic((current) =>
        current.map((message) =>
          message.clientMessageId === variables.clientMessageId ? { ...message, status: 'failed' } : message,
        ),
      );
    },
    async onSettled() {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationKeys.messages(laneId) }),
        queryClient.invalidateQueries({ queryKey: conversationKeys.list() }),
      ]);
    },
  });

  const conversation = list.data?.conversations.find((item) => item.id === laneId);
  const messages = history.data?.messages ?? [];
  useEffect(() => {
    const serverIds = new Set(messages.map((message) => message.id));
    setOptimistic((current) => {
      const next = current.filter((message) => !message.serverMessageId || !serverIds.has(message.serverMessageId));
      return next.length === current.length ? current : next;
    });
  }, [messages]);
  const processing = useMemo(() => {
    const last = messages.at(-1);
    return (
      optimistic.some((message) => message.status === 'sending' || message.status === 'accepted') ||
      (last?.direction === 'user' && last.status !== 'failed')
    );
  }, [messages, optimistic]);

  const sendOptimistic = (message: OptimisticMessage) => {
    setOptimistic((current) => {
      const present = current.some((candidate) => candidate.clientMessageId === message.clientMessageId);
      return present
        ? current.map((candidate) =>
            candidate.clientMessageId === message.clientMessageId
              ? { ...candidate, status: 'sending', serverMessageId: undefined }
              : candidate,
          )
        : [...current, message];
    });
    send.mutate({
      laneId,
      clientMessageId: message.clientMessageId,
      text: message.text,
    });
  };

  if (!laneId) return null;
  if (history.isPending) {
    return (
      <div className="flex h-full flex-col" aria-busy="true" aria-label="正在加载消息">
        <ConversationHeader title={conversation?.agentGroup.name ?? '会话'} />
        <div className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-6 py-8">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-20 animate-pulse rounded-lg bg-brand-subtle motion-reduce:animate-none odd:ml-auto odd:w-2/3 even:w-3/4"
            />
          ))}
        </div>
      </div>
    );
  }
  if (history.isError) {
    return (
      <div className="flex h-full flex-col">
        <ConversationHeader title={conversation?.agentGroup.name ?? '会话'} />
        <div className="grid flex-1 place-items-center">
          <ApiFailure error={history.error} onRetry={() => void history.refetch()} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConversationHeader
        title={conversation?.agentGroup.name ?? '助手会话'}
        subtitle={
          conversation?.status === 'archived'
            ? '已归档'
            : conversation?.sourceChannel === 'feishu'
              ? '来自飞书，可在 Web 继续'
              : '在 Web 中创建'
        }
      >
        {conversation?.status !== 'archived' ? <DeliverySubscriptionControl laneId={laneId} /> : null}
      </ConversationHeader>
      <MessageTimeline
        messages={messages}
        optimistic={optimistic}
        processing={processing}
        hasMore={Boolean(history.hasNextPage)}
        loadingMore={history.isFetchingNextPage}
        onLoadMore={() => void history.fetchNextPage()}
        onRetry={(message) => sendOptimistic({ ...message, status: 'sending' })}
      />
      {conversation?.status !== 'archived' ? <GatewayConfirmationPanel laneId={laneId} /> : null}
      <MessageComposer
        disabled={send.isPending || conversation?.status === 'archived'}
        onSend={(text) =>
          sendOptimistic({
            clientMessageId: newClientMessageId(),
            text,
            timestamp: new Date().toISOString(),
            status: 'sending',
          })
        }
      />
      <span className="sr-only" role="status" aria-live="polite">
        {send.isPending ? '消息正在发送' : send.isError ? '消息发送失败，可以重试' : ''}
      </span>
    </div>
  );
}

function ConversationHeader({
  title,
  subtitle = '助手会话',
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
      <Button variant="ghost" size="icon" asChild className="lg:hidden">
        <Link to="/conversations" aria-label="返回会话列表">
          <ArrowLeft aria-hidden="true" className="size-5" />
        </Link>
      </Button>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-muted">{subtitle}</span>
      </span>
      {children}
    </header>
  );
}

import { AlertCircle, Check, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { HistoryMessage } from '@/api/types';
import { BrandLogo } from '@/branding/BrandLogo';
import { Button } from '@/components/ui/Button';
import { SafeMarkdown } from './SafeMarkdown';

export interface OptimisticMessage {
  clientMessageId: string;
  serverMessageId?: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'accepted' | 'failed';
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function AgentMessage({ message }: { message: HistoryMessage }) {
  return (
    <article className="flex w-full min-w-0 max-w-3xl items-start gap-3">
      <BrandLogo className="mt-1 size-8 shrink-0" decorative />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
          <span className="font-medium text-ink">助手</span>
          <time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>
          {message.channel.type === 'feishu' ? (
            <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-brand">来自飞书</span>
          ) : null}
        </div>
        <SafeMarkdown>{message.text}</SafeMarkdown>
      </div>
    </article>
  );
}

function UserMessage({
  text,
  timestamp,
  status,
  onRetry,
}: {
  text: string;
  timestamp: string;
  status: 'sending' | 'accepted' | 'failed';
  onRetry?: () => void;
}) {
  return (
    <article className="ml-auto flex min-w-0 max-w-[min(82%,720px)] flex-col items-end">
      <div className="max-w-full min-w-0 rounded-lg rounded-br-sm bg-brand px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-white [overflow-wrap:anywhere]">
        {text}
      </div>
      <div className="mt-1.5 flex min-h-5 items-center gap-1.5 text-xs text-muted">
        <time dateTime={timestamp}>{formatTime(timestamp)}</time>
        {status === 'sending' ? (
          <>
            <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
            发送中
          </>
        ) : status === 'failed' ? (
          <>
            <AlertCircle aria-hidden="true" className="size-3 text-danger" />
            <span className="text-danger">发送失败</span>
            {onRetry ? (
              <Button variant="ghost" size="compact" className="h-6 min-h-6 px-1.5 text-xs" onClick={onRetry}>
                <RotateCcw aria-hidden="true" className="size-3" />
                重试
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Check aria-hidden="true" className="size-3" />
            已接收
          </>
        )}
      </div>
    </article>
  );
}

export function MessageTimeline({
  messages,
  optimistic,
  processing,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
}: {
  messages: HistoryMessage[];
  optimistic: OptimisticMessage[];
  processing: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: (message: OptimisticMessage) => void;
}) {
  const scrollArea = useRef<HTMLDivElement>(null);
  const knownServerIds = new Set(messages.map((message) => message.id));
  const visibleOptimistic = optimistic.filter(
    (message) => !message.serverMessageId || !knownServerIds.has(message.serverMessageId),
  );
  const itemCount = messages.length + visibleOptimistic.length;
  const previousCount = useRef(0);

  useEffect(() => {
    const area = scrollArea.current;
    if (!area) return;
    const appended = itemCount > previousCount.current;
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 180;
    if (appended && (nearBottom || visibleOptimistic.some((message) => message.status === 'sending'))) {
      area.scrollTo?.({ top: area.scrollHeight, behavior: 'smooth' });
    }
    previousCount.current = itemCount;
  }, [itemCount, visibleOptimistic]);

  return (
    <div
      ref={scrollArea}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className="min-h-0 flex-1 overflow-y-auto bg-canvas"
    >
      <div className="mx-auto flex min-h-full w-full min-w-0 max-w-4xl flex-col px-4 py-6 sm:px-6">
        {hasMore ? (
          <Button
            variant="secondary"
            size="compact"
            className="mx-auto mb-6"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? '正在加载…' : '加载更早消息'}
          </Button>
        ) : null}
        {messages.length === 0 && visibleOptimistic.length === 0 ? (
          <div className="my-auto py-10 text-center">
            <BrandLogo className="mx-auto size-16 opacity-80" />
            <h2 className="mt-5 text-lg font-semibold text-ink">开始这段会话</h2>
            <p className="mt-2 text-sm leading-6 text-muted">这里发送的消息会继续进入同一段助手上下文。</p>
          </div>
        ) : (
          <div className="mt-auto min-w-0 space-y-7">
            {messages.map((message) =>
              message.direction === 'agent' ? (
                <AgentMessage key={message.id} message={message} />
              ) : (
                <UserMessage
                  key={message.id}
                  text={message.text}
                  timestamp={message.timestamp}
                  status={message.status === 'failed' ? 'failed' : 'accepted'}
                />
              ),
            )}
            {visibleOptimistic.map((message) => (
              <UserMessage
                key={message.clientMessageId}
                text={message.text}
                timestamp={message.timestamp}
                status={message.status}
                onRetry={message.status === 'failed' ? () => onRetry(message) : undefined}
              />
            ))}
            {processing ? (
              <div role="status" className="flex items-center gap-3 text-sm text-muted">
                <BrandLogo className="size-8 animate-pulse motion-reduce:animate-none" decorative />
                <span>助手正在处理…</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

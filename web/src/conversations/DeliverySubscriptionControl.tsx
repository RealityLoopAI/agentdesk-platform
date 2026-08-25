import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, LoaderCircle } from 'lucide-react';

import { getDeliverySubscription, setDeliverySubscription } from '@/api/client';
import { conversationKeys } from '@/conversations/queryKeys';
import { cn } from '@/lib/cn';

export function DeliverySubscriptionControl({ laneId }: { laneId: string }) {
  const queryClient = useQueryClient();
  const subscription = useQuery({
    queryKey: conversationKeys.deliverySubscription(laneId),
    queryFn: () => getDeliverySubscription(laneId),
  });
  const update = useMutation({
    mutationFn: setDeliverySubscription,
    onSuccess(next) {
      queryClient.setQueryData(conversationKeys.deliverySubscription(laneId), next);
    },
  });

  if (subscription.isError) return null;

  const state = subscription.data;
  const loading = subscription.isPending || update.isPending;
  const available = state?.available ?? false;
  const enabled = state?.enabled ?? false;
  const label = !available && !subscription.isPending ? '飞书未绑定' : enabled ? '飞书提醒已开' : '飞书提醒';
  const help = available
    ? '开启后，Agent 在 Web 端的文字回复会额外发送到你的飞书私聊；你在 Web 端发送的消息不会被重复发送。'
    : '当前登录身份没有可用的飞书 open_id，暂时无法开启回复提醒。';

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="同步 Agent 回复到飞书"
        title={help}
        disabled={loading || !available}
        onClick={() => update.mutate({ laneId, enabled: !enabled })}
        className={cn(
          'inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-55',
          enabled
            ? 'border-brand bg-brand-subtle text-brand'
            : 'border-line bg-surface text-muted hover:border-brand-border hover:bg-brand-subtle hover:text-ink',
        )}
      >
        {loading ? (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Bell aria-hidden="true" className="size-4" />
        )}
        <span className="hidden sm:inline">{label}</span>
        <span
          aria-hidden="true"
          className={cn('relative h-5 w-9 rounded-full transition-colors', enabled ? 'bg-brand' : 'bg-line')}
        >
          <span
            className={cn(
              'absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform',
              enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
            )}
          />
        </span>
      </button>
      {update.isError ? (
        <span className="hidden text-xs text-danger md:inline" role="alert">
          设置失败，请重试
        </span>
      ) : null}
    </div>
  );
}

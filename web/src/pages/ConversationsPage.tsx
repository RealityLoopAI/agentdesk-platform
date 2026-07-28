import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, WifiOff } from 'lucide-react';
import { Outlet, useMatch } from 'react-router-dom';

import { BrandLogo } from '@/branding/BrandLogo';
import type { MeResponse } from '@/api/types';
import { ConversationSidebar } from '@/conversations/ConversationSidebar';
import { CreateConversationDialog } from '@/conversations/CreateConversationDialog';
import { useConversationList, useConversationReconciliation } from '@/conversations/useConversations';
import { useWebEventStream } from '@/events/useWebEventStream';
import { cn } from '@/lib/cn';

export function ConversationsPage() {
  const laneMatch = useMatch('/conversations/:laneId');
  const queryClient = useQueryClient();
  const me = queryClient.getQueryData<MeResponse>(['me']);
  const eventState = useWebEventStream();
  const reconciliation = useConversationReconciliation(me?.user.id ?? '');
  if (!me) throw new Error('authenticated user context unavailable');

  if (reconciliation.isPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-canvas" aria-busy="true" aria-live="polite">
        <div className="flex items-center gap-3 text-sm text-muted">
          <BrandLogo className="size-9 animate-pulse motion-reduce:animate-none" decorative />
          正在同步你的飞书会话…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-canvas p-3 sm:p-5">
      <div className="mx-auto h-[calc(100vh-24px)] max-w-[1600px] overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow-panel)] sm:h-[calc(100vh-40px)]">
        <div className="grid h-full min-h-0 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className={cn('min-h-0 border-line lg:block lg:border-r', laneMatch ? 'hidden' : 'block')}>
            <ConversationSidebar user={me.user} />
          </div>
          <section className={cn('relative min-h-0 min-w-0', laneMatch ? 'block' : 'hidden lg:block')}>
            {eventState !== 'open' ? <OfflineBanner connecting={eventState === 'connecting'} /> : null}
            <Outlet />
          </section>
        </div>
      </div>
      {reconciliation.isError ? (
        <button
          type="button"
          className="fixed right-5 bottom-5 z-30 flex items-center gap-2 rounded-md border border-warning/30 bg-surface px-3 py-2 text-xs text-muted shadow-[var(--shadow-panel)]"
          onClick={() => void reconciliation.refetch()}
        >
          <RefreshCw aria-hidden="true" className="size-3.5 text-warning" />
          部分飞书历史暂未同步，点击重试
        </button>
      ) : null}
    </main>
  );
}

export function ConversationPlaceholder() {
  const list = useConversationList();
  const conversations = list.data?.conversations ?? [];
  const assistants = list.data?.availableAgentGroups ?? [];
  const hasConversations = conversations.length > 0;

  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-md">
        <BrandLogo className="mx-auto mb-6 size-20 opacity-85" />
        <h1 className="text-2xl font-semibold text-ink">
          {hasConversations ? '选择一段会话' : assistants.length > 0 ? '从飞书开始对话' : '暂无可见会话'}
        </h1>
        <p className="mt-3 leading-7 text-muted">
          {hasConversations
            ? '从左侧直接打开飞书或 Web 中的已有对话。'
            : assistants.length > 0
              ? '在飞书中与助手发出第一条消息后，对话会自动同步到这里；也可以单独新建一段 Web 对话。'
              : '请联系管理员为你的账号分配助手权限。完成后刷新页面即可开始使用。'}
        </p>
        {!hasConversations && assistants.length > 0 ? (
          <div className="mt-6 flex justify-center">
            <CreateConversationDialog agentGroups={assistants} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OfflineBanner({ connecting = false }: { connecting?: boolean }) {
  return (
    <div
      role="status"
      className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-warning px-3 py-2 text-xs text-white"
    >
      <WifiOff aria-hidden="true" className="size-3.5" />
      {connecting ? '正在连接实时消息…' : '实时连接已中断，恢复网络后会自动重连。已发送消息不会丢失。'}
    </div>
  );
}

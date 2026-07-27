import { useQueryClient } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { Outlet, useMatch } from 'react-router-dom';

import { BrandLogo } from '@/branding/BrandLogo';
import type { MeResponse } from '@/api/types';
import { ConversationSidebar } from '@/conversations/ConversationSidebar';
import { useWebEventStream } from '@/events/useWebEventStream';
import { cn } from '@/lib/cn';

export function ConversationsPage() {
  const laneMatch = useMatch('/conversations/:laneId');
  const queryClient = useQueryClient();
  const me = queryClient.getQueryData<MeResponse>(['me']);
  const eventState = useWebEventStream();
  if (!me) throw new Error('authenticated user context unavailable');

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
    </main>
  );
}

export function ConversationPlaceholder() {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-md">
        <BrandLogo className="mx-auto mb-6 size-20 opacity-85" />
        <h1 className="text-2xl font-semibold text-ink">选择一段会话</h1>
        <p className="mt-3 leading-7 text-muted">从左侧继续已有上下文，或新建一个只属于你的 Agent 会话。</p>
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

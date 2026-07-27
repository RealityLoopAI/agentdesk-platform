import { Outlet } from 'react-router-dom';

import { BrandLogo } from '@/branding/BrandLogo';
import { useBranding } from '@/branding/BrandingProvider';

export function ConversationsPage() {
  const branding = useBranding();
  return (
    <main className="min-h-screen bg-canvas p-3 sm:p-5">
      <div className="mx-auto min-h-[calc(100vh-24px)] max-w-[1600px] overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow-panel)] sm:min-h-[calc(100vh-40px)]">
        <header className="flex h-16 items-center gap-3 border-b border-line px-5">
          <BrandLogo className="size-9" />
          <span className="font-semibold text-ink">{branding.displayName}</span>
        </header>
        <div className="grid min-h-[calc(100vh-89px)] place-items-center p-6 text-center sm:min-h-[calc(100vh-105px)]">
          <Outlet />
        </div>
      </div>
    </main>
  );
}

export function ConversationPlaceholder() {
  return (
    <div className="max-w-md">
      <BrandLogo className="mx-auto mb-6 size-20 opacity-85" />
      <h1 className="text-2xl font-semibold text-ink">Web 工作台正在就绪</h1>
      <p className="mt-3 leading-7 text-muted">会话列表、消息历史和实时更新将在这里汇合。</p>
    </div>
  );
}

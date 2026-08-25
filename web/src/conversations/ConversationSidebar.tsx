import { LogOut, MessageSquareText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';

import { logout } from '@/api/client';
import type { ConversationSummary, CurrentUser } from '@/api/types';
import { BrandLogo } from '@/branding/BrandLogo';
import { useBranding } from '@/branding/BrandingProvider';
import { ApiFailure } from '@/components/ApiFailure';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { CreateConversationDialog } from './CreateConversationDialog';
import { useConversationList } from './useConversations';

function activityTime(conversation: ConversationSummary): number {
  return Date.parse(conversation.lastActiveAt ?? conversation.createdAt) || 0;
}

function formatActivity(conversation: ConversationSummary): string {
  const date = new Date(conversation.lastActiveAt ?? conversation.createdAt);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function sourceLabel(sourceChannel: string): string {
  if (sourceChannel === 'feishu') return '飞书';
  if (sourceChannel === 'web') return 'Web';
  return '其他渠道';
}

export function ConversationSidebar({ user }: { user: CurrentUser }) {
  const branding = useBranding();
  const queryClient = useQueryClient();
  const list = useConversationList();
  const conversations = [...(list.data?.conversations ?? [])].sort(
    (left, right) => activityTime(right) - activityTime(left) || left.id.localeCompare(right.id),
  );

  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-4">
        <BrandLogo className="size-9" />
        <span className="min-w-0 flex-1 truncate font-semibold text-ink">{branding.displayName}</span>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-4">
        <div>
          <p className="text-sm font-semibold text-ink">会话</p>
          <p className="mt-0.5 text-xs text-muted">{conversations.length} 个可见会话</p>
        </div>
        <CreateConversationDialog agentGroups={list.data?.availableAgentGroups ?? []} />
      </div>
      <nav aria-label="会话列表" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.isPending ? (
          <div className="space-y-2 px-2" aria-label="正在加载会话" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-16 animate-pulse rounded-md bg-brand-subtle motion-reduce:animate-none" />
            ))}
          </div>
        ) : list.isError ? (
          <ApiFailure error={list.error} onRetry={() => void list.refetch()} />
        ) : conversations.length === 0 ? (
          <div className="mx-2 rounded-md border border-dashed border-brand-border p-5 text-center">
            <MessageSquareText aria-hidden="true" className="mx-auto size-5 text-brand" />
            <p className="mt-3 text-sm font-medium text-ink">还没有可见会话</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {(list.data?.availableAgentGroups.length ?? 0) > 0
                ? '先在飞书中与助手发消息，对话会自动出现在这里。'
                : '请联系管理员为你分配助手权限。'}
            </p>
          </div>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <NavLink
                  to={`/conversations/${encodeURIComponent(conversation.id)}`}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-md px-3 py-3 transition-colors',
                      isActive ? 'bg-brand-subtle text-ink' : 'text-muted hover:bg-canvas hover:text-ink',
                    )
                  }
                >
                  <span className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-brand-border bg-surface text-brand">
                      <MessageSquareText aria-hidden="true" className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{conversation.agentGroup.name}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                        <span>{sourceLabel(conversation.sourceChannel)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{conversation.status === 'archived' ? '已归档' : formatActivity(conversation)}</span>
                      </span>
                    </span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-3 border-t border-line p-3">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-sm font-semibold text-white"
        >
          {(user.displayName ?? user.id).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{user.displayName ?? '飞书用户'}</span>
          <span className="block truncate text-xs text-muted">已通过飞书登录</span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="退出登录"
          title="退出登录"
          onClick={() => {
            void logout().finally(() => queryClient.clear());
          }}
        >
          <LogOut aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </aside>
  );
}

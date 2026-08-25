import { LockKeyhole, RefreshCw, TriangleAlert } from 'lucide-react';

import { ApiError } from '@/api/client';
import { Button } from './ui/Button';

export function ApiFailure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const forbidden = error instanceof ApiError && error.status === 403;
  const Icon = forbidden ? LockKeyhole : TriangleAlert;
  return (
    <section role="alert" className="mx-auto max-w-md p-8 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-lg bg-brand-subtle text-brand">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <h1 className="mt-5 text-lg font-semibold text-ink">{forbidden ? '你无权访问这段会话' : '内容暂时无法加载'}</h1>
      <p className="mt-2 text-sm leading-6 text-muted">
        {forbidden
          ? '权限可能已经被管理员调整。返回会话列表可以查看你当前仍有权使用的助手。'
          : '请检查网络连接后重试；页面不会把登录凭证或消息写入浏览器存储。'}
      </p>
      {onRetry ? (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          <RefreshCw aria-hidden="true" className="size-4" />
          重试
        </Button>
      ) : null}
    </section>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle } from 'lucide-react';

import { listGatewayConfirmations, resolveGatewayConfirmation } from '@/api/client';
import type { GatewayConfirmation } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { conversationKeys } from './queryKeys';

interface DiffItem {
  field: string;
  before: unknown;
  after: unknown;
  highImpact?: boolean;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isDiffItem(value: unknown): value is DiffItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.field === 'string' && 'before' in item && 'after' in item;
}

function ConfirmationSummary({ confirmation }: { confirmation: GatewayConfirmation }) {
  if (confirmation.kind === 'update') {
    const diff = Array.isArray(confirmation.display.diff) ? confirmation.display.diff.filter(isDiffItem) : [];
    return (
      <>
        <p className="mt-1 text-sm text-muted">
          记录 <code className="rounded bg-brand-subtle px-1 text-ink">{String(confirmation.display.recordId)}</code>
        </p>
        <div className="mt-3 overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[520px] border-collapse text-left text-sm">
            <thead className="bg-brand-subtle text-ink">
              <tr>
                <th className="px-3 py-2 font-semibold">字段</th>
                <th className="px-3 py-2 font-semibold">修改前</th>
                <th className="px-3 py-2 font-semibold">修改后</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((item) => (
                <tr key={item.field} className="border-t border-line">
                  <td className="px-3 py-2 font-medium text-ink">
                    {item.field}{' '}
                    {item.highImpact ? (
                      <AlertTriangle aria-label="高影响字段" className="inline size-4 text-warning" />
                    ) : null}
                  </td>
                  <td className="max-w-64 break-words px-3 py-2 text-muted">{valueText(item.before)}</td>
                  <td className="max-w-64 break-words px-3 py-2 text-ink">{valueText(item.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  if (confirmation.kind === 'delete') {
    const fields =
      confirmation.display.fields && typeof confirmation.display.fields === 'object'
        ? Object.entries(confirmation.display.fields as Record<string, unknown>)
        : [];
    return (
      <>
        <p className="mt-1 text-sm text-muted">
          删除记录{' '}
          <code className="rounded bg-brand-subtle px-1 text-ink">{String(confirmation.display.recordId)}</code>
        </p>
        <dl className="mt-3 grid gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
          {fields.map(([name, value]) => (
            <div key={name} className="grid grid-cols-[minmax(7rem,0.4fr)_1fr] gap-3">
              <dt className="font-medium text-ink">{name}</dt>
              <dd className="break-words text-muted">{valueText(value)}</dd>
            </div>
          ))}
        </dl>
      </>
    );
  }

  const fields =
    confirmation.display.fields && typeof confirmation.display.fields === 'object'
      ? Object.entries(confirmation.display.fields as Record<string, unknown>)
      : [];
  return (
    <>
      <p className="mt-1 text-sm text-muted">
        新增到资源{' '}
        <code className="rounded bg-brand-subtle px-1 text-ink">{String(confirmation.display.resource)}</code>
      </p>
      <dl className="mt-3 grid gap-2 rounded-md border border-line p-3 text-sm">
        {fields.map(([name, value]) => (
          <div key={name} className="grid grid-cols-[minmax(7rem,0.4fr)_1fr] gap-3">
            <dt className="font-medium text-ink">{name}</dt>
            <dd className="break-words text-muted">{valueText(value)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function GatewayConfirmationPanel({ laneId }: { laneId: string }) {
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: conversationKeys.confirmations(laneId),
    queryFn: () => listGatewayConfirmations(laneId),
    refetchInterval: 30_000,
  });
  const resolve = useMutation({
    mutationFn: resolveGatewayConfirmation,
    async onSettled() {
      await queryClient.invalidateQueries({ queryKey: conversationKeys.confirmations(laneId) });
    },
  });

  if (pending.isError || !pending.data?.confirmations.length) return null;

  return (
    <section className="shrink-0 border-t border-line bg-canvas px-3 py-3 sm:px-6" aria-label="待确认操作">
      <div className="mx-auto grid w-full max-w-4xl gap-3">
        {pending.data.confirmations.map((confirmation) => (
          <article key={confirmation.id} className="rounded-lg border border-brand-border bg-surface p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-ink">{confirmation.title}</h2>
            <ConfirmationSummary confirmation={confirmation} />
            <p className="mt-3 text-xs text-muted">此确认仅对上面显示的目标和值有效，过期或记录变化后不会执行。</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="compact"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ laneId, confirmationId: confirmation.id, decision: 'approve' })}
              >
                {resolve.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                {confirmation.kind === 'update' ? '确认修改' : confirmation.kind === 'delete' ? '确认删除' : '确认新增'}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ laneId, confirmationId: confirmation.id, decision: 'reject' })}
              >
                拒绝
              </Button>
              {resolve.isError ? (
                <span className="self-center text-xs text-danger" role="alert">
                  确认失败，请刷新后重试
                </span>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
